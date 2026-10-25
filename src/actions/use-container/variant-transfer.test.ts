import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type ContainerStack, type FakeBotOptions, createFakeBot, stackText } from "../../test-support/fake-bot/index.js";
import { SERVER_ANSWER_TICKS } from "../../world/world-age.js";
import { planPlacement, transferByVariant, type VariantTransferOptions } from "./variant-transfer.js";

const CELL = "1,64,1";
/** The 27 chest slots, then the player's 27 main slots (27-53) and 9 hotbar slots (54-62) in the window's numbering. */
const CHEST_SLOTS = 27;
const FIRST_PLAYER_SLOT = 27;
/** Long enough for a call on the fake clock, which only moves while a test lets it (27 stacks at 8 ticks a second take 135 s). */
const CALL_MS = 300_000;

/** The bot beside a chest at CELL holding `stacks` (item or `ITEM_VARIANTS` names, by slot), carrying `carried`, with the chest open. */
async function openChest(stacks: readonly ContainerStack[], carried: Readonly<Record<string, number>> = {}, serverOptions: FakeBotOptions["server"] = {}) {
  const harness = createFakeBot({ position: new Vec3(0, 64, 0), cells: { [CELL]: "chest" }, carried, containers: { [CELL]: {} }, server: serverOptions });
  const { bot, clock, windows, server } = harness;
  windows.setContainerStacks(CELL, stacks);
  const window = await clock.settle(bot.openContainer(bot.blockAt(new Vec3(1, 64, 1))!), 5_000);
  const id = (name: string) => bot.registry.itemsByName[name]!.id;
  return {
    ...harness,
    window,
    /** Run one transfer to its end on the fake clock, the server's last answers delivered after it. */
    async transfer(operation: "deposit" | "withdraw", name: string, count: number, options: VariantTransferOptions = {}) {
      try {
        await clock.settle(transferByVariant(bot, window, operation, id(name), count, { timing: clock, ...options }), CALL_MS);
      } finally {
        await clock.advance(200);
      }
    },
    /** What the server's chest holds, by slot, a variant under its name. */
    chest: () => windows.containerStacks(CELL).map(({ slot, name, count }) => `${slot}: ${name} x${count}`),
    /** What the client's window shows in the player's part, by window slot. */
    player: () => Object.fromEntries(window.slots.flatMap((item, slot) => (slot >= FIRST_PLAYER_SLOT && item ? [[slot, stackText(item)]] : []))),
    cursor: () => stackText(window.selectedItem),
    clicks: () => server.packets.filter(({ name }) => name === "window_click").length,
    age: () => bot.time.age,
  };
}

const slotted = (names: readonly (string | null)[]): ContainerStack[] =>
  names.flatMap((entry, slot) => {
    if (entry === null) return [];
    const [name, count] = entry.split(" x");
    return [{ slot, name: name!, count: Number(count) }];
  });

test("a deposit tops up the partial stacks of its own variant, the fullest first, before any empty slot, and never the renamed one", async () => {
  const scene = await openChest(slotted(["cobblestone x10", "renamed_first_cobblestone x5", "cobblestone x60"]), { cobblestone: 9 });
  await scene.transfer("deposit", "cobblestone", 9);
  assert.deepEqual(scene.chest(), ["0: cobblestone x15", "1: renamed_first_cobblestone x5", "2: cobblestone x64"], "4 filled the 60, the other 5 went on the 10");
  assert.equal(scene.cursor(), null);
});

test("a withdrawal by name takes the plain stack first, then a variant; with only variants left it takes them", async () => {
  const mixed = await openChest(slotted(["renamed_first_cobblestone x5", "cobblestone x4"]));
  await mixed.transfer("withdraw", "cobblestone", 6);
  assert.deepEqual(mixed.player(), { 27: "cobblestone x4", 28: 'cobblestone x2 "first"' });
  assert.deepEqual(mixed.chest(), ["0: renamed_first_cobblestone x3"]);
  assert.equal(mixed.cursor(), null);
  const variants = await openChest(slotted(["renamed_first_cobblestone x5", "enchanted_cobblestone x3"]));
  await variants.transfer("withdraw", "cobblestone", 7);
  assert.deepEqual(variants.player(), { 27: 'cobblestone x5 "first"', 28: "cobblestone x2" });
  assert.deepEqual(variants.chest(), ["1: enchanted_cobblestone x1"]);
});

test("what is left of a part of a stack goes back to the slot it came from, or onto a partial stack of its variant first", async () => {
  const alone = await openChest([], { cobblestone: 10 });
  await alone.transfer("deposit", "cobblestone", 3);
  assert.deepEqual(alone.chest(), ["0: cobblestone x3"]);
  assert.deepEqual(alone.player(), { 54: "cobblestone x7" });
  assert.equal(alone.cursor(), null);
  const joined = await openChest([], { cobblestone: 84 });
  await joined.transfer("deposit", "cobblestone", 3);
  assert.deepEqual(joined.chest(), ["0: cobblestone x3"]);
  assert.deepEqual(joined.player(), { 54: "cobblestone x17", 55: "cobblestone x64" }, "the 61 left filled the other partial stack (20 to 64), and the 17 over went to the slot they came from");
});

test("a full destination ends the transfer failed after what fitted, the rest back in its source slot and the cursor empty", async () => {
  const filler = Array.from({ length: CHEST_SLOTS - 1 }, (_, slot): ContainerStack => ({ slot, name: "dirt", count: 64 }));
  const scene = await openChest([...filler, { slot: CHEST_SLOTS - 1, name: "cobblestone", count: 60 }], { cobblestone: 10 });
  await assert.rejects(scene.transfer("deposit", "cobblestone", 10), /destination full.*deposit again/s);
  assert.equal(scene.chest().at(-1), "26: cobblestone x64", "the 4 that fitted");
  assert.deepEqual(scene.player(), { 54: "cobblestone x6" }, "the other 6 are back");
  assert.equal(scene.cursor(), null);
});

test("a withdrawal into an inventory with no free slot fails before any click", async () => {
  const names = ["dirt", "sand", "gravel", "stick", "coal", "bread", "apple", "carrot", "potato", "wheat", "sugar", "paper", "string", "feather", "flint", "bone", "leather", "brick", "torch", "stone", "granite", "diorite", "andesite", "clay", "ice", "snow", "cactus", "vine", "kelp", "melon", "pumpkin", "bamboo", "cake", "bowl", "slime_ball", "bucket"];
  const scene = await openChest(slotted(["cobblestone x5"]), Object.fromEntries(names.map((name) => [name, 1])));
  const before = scene.clicks();
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 5), /inventory is full.*withdraw again/s);
  assert.equal(scene.clicks(), before);
});

test("an item that is not there fails naming the item and the range, with nothing clicked", async () => {
  const scene = await openChest(slotted(["dirt x5"]));
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 1), /Can't find cobblestone in the container.*read what it holds/s);
  assert.equal(scene.clicks(), 0);
});

test("an abort between two source stacks leaves the cursor empty, the first stack moved, and the call rejects with the abort's reason", async () => {
  const scene = await openChest(slotted(["cobblestone x64", "cobblestone x64", "cobblestone x64"]));
  const owner = new AbortController();
  const before = ["set_slot", "window_items", "set_cursor_item"].map((name) => scene.bot._client.listenerCount(name));
  let received = 0;
  scene.windows.onClickReceived(() => void (++received === 2 && owner.abort(new Error("hunger reflex"))));
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 130, { signal: owner.signal }), /hunger reflex/);
  assert.deepEqual(scene.player(), { 27: "cobblestone x64" });
  assert.deepEqual(scene.chest(), ["1: cobblestone x64", "2: cobblestone x64"]);
  assert.equal(scene.cursor(), null);
  assert.deepEqual(["set_slot", "window_items", "set_cursor_item"].map((name) => scene.bot._client.listenerCount(name)), before, "no listener left behind");
});

test("an abort between two right clicks of one stack puts the rest back in the source slot", async () => {
  const scene = await openChest([], { cobblestone: 64 });
  const owner = new AbortController();
  let received = 0;
  // pick-up, the left click onto the empty slot, the half taken back, then 7 single clicks: the abort lands at the 10th write.
  const stopHook = scene.windows.onClickReceived(() => void (++received === 10 && owner.abort(new Error("hunger reflex"))));
  await assert.rejects(scene.transfer("deposit", "cobblestone", 63, { signal: owner.signal }), /hunger reflex/);
  stopHook();
  assert.equal(scene.cursor(), null, "the rest went back");
  assert.deepEqual(scene.chest(), ["0: cobblestone x39"]);
  assert.deepEqual(scene.player(), { 54: "cobblestone x25" });
});

test("an abort right after the whole stack went onto the destination still takes the larger half back: the destination never keeps more than was asked", async () => {
  const scene = await openChest([], { cobblestone: 40 });
  const owner = new AbortController();
  let received = 0;
  // pick-up, then the left click of the half-pickup path (30 of 40 asked): the abort lands with the second click.
  scene.windows.onClickReceived(() => void (++received === 2 && owner.abort(new Error("hunger reflex"))));
  await assert.rejects(scene.transfer("deposit", "cobblestone", 30, { signal: owner.signal }), /hunger reflex/);
  assert.deepEqual(scene.chest(), ["0: cobblestone x20"], "the half stayed, not the 40");
  assert.deepEqual(scene.player(), { 54: "cobblestone x20" });
  assert.equal(scene.cursor(), null);
});

test("a window the server closes during the wait for its answer fails the transfer naming the close, and no click is sent after it", async () => {
  const scene = await openChest(slotted(["cobblestone x64", "cobblestone x64", "cobblestone x64"]));
  let received = 0;
  scene.windows.onClickReceived(() => void (++received === 2 && scene.server.answer(() => scene.windows.closeOpenWindow())));
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 130), /window closed under the transfer.*reopen the container/s);
  assert.equal(scene.clicks(), 2, "the transfer wrote nothing after the second click");
  assert.equal(scene.bot.currentWindow, null);
});

test("a close the client learns of between two clicks of one stack gets no further click, not even a rescue one", async () => {
  const scene = await openChest([], { cobblestone: 64 });
  let received = 0;
  // The server closes before it applied the clicks it had queued (they are ignored); the stack never left the inventory's player part.
  scene.windows.onClickReceived(() => void (++received === 5 && scene.windows.closeOpenWindow()));
  await assert.rejects(scene.transfer("deposit", "cobblestone", 63), /window closed under the transfer/);
  assert.equal(scene.clicks(), 5);
  assert.deepEqual(scene.chest(), []);
});

test("a correct click the server sends nothing back for completes once the world age has moved 40 ticks, and once per source stack", async () => {
  const scene = await openChest(slotted(["cobblestone x64", "cobblestone x64"]));
  const sentAt = scene.age();
  await scene.transfer("withdraw", "cobblestone", 128);
  const waited = scene.age() - sentAt;
  assert.ok(waited >= 2 * SERVER_ANSWER_TICKS && waited < 2 * SERVER_ANSWER_TICKS + 20, `${waited} ticks for two source stacks: one wait each`);
});

test("a transfer in which no source stack settles within its bound fails with the cause, the stack in hand put back", async () => {
  // Each click the server receives costs 2 s of wall time on the transfer's clock (a blocked event loop): the stack of 63 never settles inside 3 s.
  const scene = await openChest([], { cobblestone: 64 });
  let received = 0;
  scene.windows.onClickReceived(() => void (received += 1));
  const slowClock = { now: () => scene.clock.now() + received * 2_000, sleep: scene.clock.sleep };
  await assert.rejects(scene.transfer("deposit", "cobblestone", 63, { wallMs: 3_000, timing: slowClock }), /took longer than 3000 ms/);
  assert.equal(scene.cursor(), null);
});

test("a transfer of 27 stacks on a server at 8 ticks a second finishes: the bound renews at each settled stack", async () => {
  const scene = await openChest(slotted(Array.from({ length: CHEST_SLOTS }, () => "cobblestone x64")), {}, { ticksPerSecond: 8 });
  const startedAt = scene.clock.now();
  await scene.transfer("withdraw", "cobblestone", 27 * 64);
  assert.ok(scene.clock.now() - startedAt > 90_000, `took ${scene.clock.now() - startedAt} ms: longer than the 90 s a fixed bound allowed`);
  assert.deepEqual(scene.chest(), []);
  assert.equal(Object.keys(scene.player()).length, CHEST_SLOTS);
  assert.equal(scene.cursor(), null);
});

test("a server that stops after the 10th stack fails the transfer at the click's stall bound, naming what moved so far", async () => {
  const scene = await openChest(slotted(Array.from({ length: 12 }, () => "cobblestone x64")));
  let received = 0;
  // A stack of 64 onto an empty slot is two clicks: the stop falls with the 11th stack's pick-up.
  scene.windows.onClickReceived(() => void (++received === 21 && scene.server.stop()));
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 12 * 64), /did not answer the click on slot 10: the world age did not move for 5 s.*640 of 768 were moved before this stack.*Reopen/s);
  assert.equal(scene.cursor(), null, "the stack was placed before the wait");
  assert.ok(scene.clock.now() < 100_000);
});

test("63 of a stack of 64 into an empty slot takes the half-pickup path's clicks and one wait", async () => {
  const scene = await openChest([], { cobblestone: 64 });
  const sentAt = scene.age();
  await scene.transfer("deposit", "cobblestone", 63);
  // pick-up, left onto the destination, right to take the larger half, 31 single rights, the one left over back
  assert.equal(scene.clicks(), 1 + 1 + 1 + 31 + 1);
  assert.ok(scene.age() - sentAt < 2 * SERVER_ANSWER_TICKS, "one wait for the stack");
  assert.deepEqual(scene.chest(), ["0: cobblestone x63"]);
  assert.deepEqual(scene.player(), { 54: "cobblestone x1" });
});

test("a renamed stack moved by right clicks stays renamed on both sides once the server has answered", async () => {
  const scene = await openChest(slotted(["renamed_first_cobblestone x20"]));
  await scene.transfer("withdraw", "cobblestone", 3);
  assert.deepEqual(scene.player(), { 27: 'cobblestone x3 "first"' });
  assert.deepEqual(scene.chest(), ["0: renamed_first_cobblestone x17"]);
  assert.equal(scene.cursor(), null);
});

test("a stack the server left in hand after its answer (the source slot taken meanwhile) goes back by what the server says it holds", async () => {
  const scene = await openChest(slotted(["cobblestone x10", "dirt x5"]));
  // Another player puts a stack in slot 0 as soon as ours was picked up: the put-back cannot use it.
  let received = 0;
  scene.windows.onClickReceived(() => {
    if (++received === 1) scene.server.answer(() => scene.windows.setContainerStacks(CELL, [{ slot: 0, name: "oak_log", count: 3 }, { slot: 1, name: "dirt", count: 5 }]));
  });
  await scene.transfer("withdraw", "cobblestone", 4);
  assert.deepEqual(scene.player(), { 27: "cobblestone x4" });
  assert.equal(scene.cursor(), null);
  // The put-back landed on the other player's stack and swapped: the server left that stack in hand, and it went to the first empty slot.
  assert.deepEqual(scene.chest(), ["0: cobblestone x6", "1: dirt x5", "2: oak_log x3"]);
});

test("a stack that has nowhere to go back fails naming what the cursor holds", async () => {
  const filler = Array.from({ length: CHEST_SLOTS - 1 }, (_, slot): ContainerStack => ({ slot: slot + 1, name: "dirt", count: 64 }));
  const scene = await openChest([{ slot: 0, name: "cobblestone", count: 10 }, ...filler]);
  let received = 0;
  scene.windows.onClickReceived(() => {
    if (++received === 1) scene.server.answer(() => scene.windows.setContainerStacks(CELL, [{ slot: 0, name: "oak_log", count: 3 }, ...filler]));
  });
  await assert.rejects(scene.transfer("withdraw", "cobblestone", 4), /cursor holds 3 oak_log.*goes to your inventory/s);
});

test("planPlacement picks one left click, the half-pickup path or single clicks as Mineflayer's transfer does", () => {
  assert.deepEqual(planPlacement(10, 64, 0, 10), { kind: "whole", moved: 10 }, "all of it");
  assert.deepEqual(planPlacement(64, 64, 60, 30), { kind: "whole", moved: 4 }, "what fits");
  assert.deepEqual(planPlacement(10, 64, 0, 3), { kind: "singles", moved: 3 }, "a few");
  assert.deepEqual(planPlacement(64, 64, 0, 63), { kind: "half", moved: 63, afterLeftClick: 0, rights: 31 });
  assert.deepEqual(planPlacement(1, 1, 0, 1), { kind: "whole", moved: 1 }, "an unstackable item");
});
