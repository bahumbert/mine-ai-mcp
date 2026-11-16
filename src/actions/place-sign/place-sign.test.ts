// Sign placement, server answers, refusals and request-owned cleanup.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince, type FakeBotOptions } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { placeBlock } from "../../world/placement.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { createPlaceSignAction, parsePlaceSignRequest, placeSignResultSchema } from "./index.js";

const target = new Vec3(2, 64, 0);
const input = { x: 2, y: 64, z: 0, facing: "north", lines: ["Builder", "Hello"] };

/** Use the real placement path and a shared fake whose server owns every answer. */
function setup(t: TestContext, options: FakeBotOptions = {}) {
  const clock = options.clock ?? createFakeClock({ mode: "mocked" });
  const h = createFakeBot({ carried: { oak_sign: 2, cobblestone: 1 }, ...options, server: { startAge: 0, ...options.server }, clock });
  const data = temporaryBotData({ closeAfter: t });
  const action = createPlaceSignAction({ bot: h.bot, botData: data, navigation: { navigate: async () => { throw new Error("unexpected route"); } } as never });
  const run = (request: unknown = input, signal?: AbortSignal) => action.begin(action.parse(request), signal ?? new AbortController().signal, () => {})({ ...(signal && { signal }) });
  return { ...h, data, action, run };
}

/** Count only packets that can place or edit a block. */
function changes(h: ReturnType<typeof setup>) {
  return h.server.packets.filter(({ name }) => name === "block_place" || name === "update_sign");
}

/** Every request-owned observer stays released after its former deadline. */
async function assertReleased(h: ReturnType<typeof setup>, added: (event: string) => number) {
  for (const event of ["signOpen", "blockEntityData", "error", "end", "death"]) assert.equal(added(event), 0, event);
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
  for (const event of ["signOpen", "blockEntityData", "error", "end", "death"]) assert.equal(added(event), 0, event);
  assert.equal(h.clock.pendingTimers(), 0);
}

/** A blank or written sign must leave the body free for the next ordinary placement. */
async function placeNext(h: ReturnType<typeof setup>) {
  const cell = target.offset(1, 0, 0);
  const item = h.bot.inventory.items().find((item) => item.name === "cobblestone")!;
  const result = await h.clock.settle(placeBlock(h.bot, { item, support: h.bot.blockAt(cell.offset(0, -1, 0))!, face: new Vec3(0, 1, 0), expectedCells: [cell], matches: (block) => block.name === "cobblestone" }), 6_000);
  assert.equal(result.kind, "placed");
  assert.equal(h.bot.blockAt(cell)?.name, "cobblestone");
}

for (const ticksPerSecond of [20, 10]) {
  for (const lines of [input.lines, ["Builder"]]) test(`places a ground sign facing north and confirms ${lines.length} lines (${ticksPerSecond} tps)`, async (t) => {
    const h = setup(t, { server: { ticksPerSecond } });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    let openedBeforeSlot = false;
    h.bot.once("signOpen", () => { openedBeforeSlot = h.bot.inventory.items().find((item) => item.name === "oak_sign")?.count === 2; });
    const result = await h.clock.settle(h.run({ ...input, lines }), 6_000);
    const expected = [lines[0], lines[1] ?? "", "", ""];
    assert.equal(openedBeforeSlot, true);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.sign, { target: { x: 2, y: 64, z: 0 }, block: "oak_sign", facing: "north", attach: "ground", lines: expected, confirmed: true, placed: true });
    assert.equal(h.bot.blockAt(target)?.getProperties().rotation, "8");
    assert.equal(h.bot.blockAt(target)?.getSignText()[0], expected.join("\n"));
    const row = h.data.read("SELECT * FROM observed_signs")[0]!;
    assert.equal(row.placed_by_bot_id, h.bot.username);
    assert.equal(row.front_json, JSON.stringify(expected));
    assert.ok(placeSignResultSchema.safeParse(result).success);
    assert.ok(h.bot.time.age < 40);
    assert.ok(h.server.gameTime > h.bot.time.age);
    await assertReleased(h, added);
    await placeNext(h);
  });

  test(`no editor answer: partial unconfirmed, the sign named, no update_sign sent (${ticksPerSecond} tps)`, async (t) => {
    const h = setup(t, { signs: { withheld: true }, server: { ticksPerSecond } });
    using _timers = h.clock.install();
    const result = await h.clock.settle(h.run(), 6_000);
    assert.equal(result.status, "partial");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNCONFIRMED/);
    assert.equal(result.sign.block, "oak_sign");
    assert.equal(result.sign.placed, true);
    assert.equal(result.sign.confirmed, false);
    assert.equal(changes(h).filter(({ name }) => name === "update_sign").length, 0);
    assert.ok(h.bot.time.age >= 40);
    const row = h.data.read("SELECT * FROM observed_signs")[0]!;
    assert.equal(row.placed_by_bot_id, h.bot.username);
    assert.equal(row.front_json, '["","","",""]');
    await placeNext(h);
  });

  test(`the world clock stopped: the wait ends on the helper's real-time bound (${ticksPerSecond} tps)`, async (t) => {
    const h = setup(t, { signs: { withheld: true }, server: { ticksPerSecond } });
    using _timers = h.clock.install();
    const stopped = new Promise<void>((resolve) => h.inventory.once("updateSlot", () => { h.server.stop(); resolve(); }));
    const pending = h.run();
    await h.clock.settle(stopped, 6_000);
    const stoppedAge = h.bot.time.age;
    const stoppedAt = h.clock.now();
    const result = await h.clock.settle(pending, SERVER_CLOCK_STOPPED_MS + 50);
    assert.equal(result.status, "partial");
    assert.equal(h.bot.time.age, stoppedAge);
    assert.ok(h.clock.now() - stoppedAt >= SERVER_CLOCK_STOPPED_MS);
    h.server.resume();
    await placeNext(h);
  });
}

test("a wall attach places the wall block on the face behind", async (t) => {
  const h = setup(t, { cells: { "3,64,0": "stone" } });
  using _timers = h.clock.install();
  const result = await h.clock.settle(h.run({ ...input, attach: "wall", facing: "west" }), 6_000);
  assert.equal(result.status, "succeeded");
  assert.equal(result.sign.block, "oak_wall_sign");
  assert.equal(h.bot.blockAt(target)?.getProperties().facing, "west");
  const packet = changes(h).find(({ name }) => name === "block_place")!.data as { location: Vec3; direction: number };
  assert.deepEqual(packet.location, new Vec3(3, 64, 0));
  assert.equal(packet.direction, 4);
});

test("no sign carried lists the family", async (t) => {
  const h = setup(t, { carried: { cobblestone: 1 } });
  using _timers = h.clock.install();
  const result = await h.clock.settle(h.run(), 1_000);
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /PLACE_SIGN_NO_SIGN_ITEM/);
  assert.ok(result.members?.includes("oak_sign"));
  assert.equal(changes(h).length, 0);
});

test("a sign at the cell is read and never overwritten", async (t) => {
  const h = setup(t, { cells: { "2,64,0": "oak_sign" } });
  using _timers = h.clock.install();
  const block = h.bot.blockAt(target)!;
  block.setSignText("someone\nelse\n\n", "back\n\n\n");
  h.world.setCell(target, { name: block.name, properties: {}, entity: block.entity! });
  const result = await h.clock.settle(h.run({ ...input, fill_blank: true }), 1_000);
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
  assert.deepEqual(result.existing, { block: "oak_sign", front: ["someone", "else", "", ""], back: ["back", "", "", ""] });
  assert.equal(changes(h).length, 0);
});

test("a blank sign without fill_blank is cell taken", async (t) => {
  const h = setup(t, { cells: { "2,64,0": "oak_sign" } });
  using _timers = h.clock.install();
  const block = h.bot.blockAt(target)!;
  block.setSignText("\n\n\n", "\n\n\n");
  h.world.setCell(target, { name: block.name, properties: {}, entity: block.entity! });
  const result = await h.clock.settle(h.run(input), 1_000);
  assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
  assert.equal(changes(h).length, 0);
});

for (const [name, options, code] of [
  ["a non-replaceable cell is taken", { cells: { "2,64,0": "stone" } }, "CELL_TAKEN"],
  ["no support refuses before any packet", { cells: { "2,63,0": "air" } }, "NO_SUPPORT"],
  ["an unloaded cell refuses before any packet", { loadedColumns: [] }, "UNLOADED"],
] as const) test(name, async (t) => {
  const h = setup(t, options);
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  const result = await h.clock.settle(h.run(), 1_000);
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", new RegExp(`PLACE_SIGN_${code}`));
  assert.equal(changes(h).length, 0);
  await assertReleased(h, added);
});

test("five lines, a long line, a line with a newline: refused before any packet", (t) => {
  const h = setup(t);
  for (const lines of [[], ["a", "b", "c", "d", "e"], ["a".repeat(46)], ["a\nb"], ["a\rb"]]) assert.throws(() => h.action.parse({ ...input, lines }), /PLACE_SIGN_LINES/);
  for (const lines of [["a".repeat(45)], ["", "", "", ""]]) assert.doesNotThrow(() => parsePlaceSignRequest({ ...input, lines }));
  for (const request of [{ ...input, x: 1.5 }, { ...input, x: Number.MAX_SAFE_INTEGER + 1 }, { ...input, facing: "up" }, { ...input, attach: "ceiling" }]) assert.throws(() => h.action.parse(request));
  assert.equal(changes(h).length, 0);
});

test("an editor or entity event for another cell is ignored", async (t) => {
  const h = setup(t, { signs: { withheld: true }, cells: { "4,64,0": "oak_sign" } });
  using _timers = h.clock.install();
  const other = h.bot.blockAt(target.offset(2, 0, 0))!;
  h.server.onPacket("block_place", () => { h.bot.emit("signOpen", other); h.bot.emit("blockEntityData", other); });
  const result = await h.clock.settle(h.run(), 6_000);
  assert.equal(result.status, "partial");
  assert.equal(changes(h).filter(({ name }) => name === "update_sign").length, 0);
});

test("a foreign region refuses with no packet", async (t) => {
  const h = setup(t);
  using _timers = h.clock.install();
  setProtectedRegionsProvider(h.bot, () => [{ regionId: 1, owner: "Other", label: "Other's house", dimension: h.bot.game.dimension, min: target, max: target, createdAt: "fixture" }]);
  const result = await h.clock.settle(h.run(), 1_000);
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /protected region/);
  assert.equal(changes(h).length, 0);
});

for (const ticksPerSecond of [20, 10]) test(`unconfirmed edit is partial and unrelated entity text cannot confirm it (${ticksPerSecond} tps)`, async (t) => {
  const h = setup(t, { server: { ticksPerSecond }, cells: { "4,64,0": "oak_sign" } });
  using _timers = h.clock.install();
  const other = h.bot.blockAt(target.offset(2, 0, 0))!;
  other.setSignText("Builder\nHello\n\n", "\n\n\n");
  h.world.setCell(other.position, { name: other.name, properties: {}, entity: other.entity! });
  h.server.onPacket("update_sign", () => { h.server.stop(); h.bot.emit("blockEntityData", h.bot.blockAt(other.position)!); });
  const pending = h.run();
  const result = await h.clock.settle(pending, SERVER_CLOCK_STOPPED_MS + 6_000);
  assert.equal(result.status, "partial");
  assert.equal(result.sign.confirmed, false);
  assert.deepEqual(result.sign.lines, ["", "", "", ""]);
  const age = h.bot.time.age;
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS);
  assert.equal(h.bot.time.age, age);
  h.server.resume();
  await placeNext(h);
});

test("a synchronous updateSign error returns partial and releases the one-call error listener", async (t) => {
  const h = setup(t, { overrides: { updateSign() { this.emit?.("error", new Error("write rejected")); } } });
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  const result = await h.clock.settle(h.run(), 6_000);
  assert.equal(result.status, "partial");
  assert.match("error" in result ? result.error : "", /write rejected/);
  for (const event of ["signOpen", "blockEntityData", "error"]) assert.equal(added(event), 0, event);
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
  await placeNext(h);
});

test("an all-empty write needs a fresh entity answer after the write", async (t) => {
  const h = setup(t);
  using _timers = h.clock.install();
  h.server.onPacket("update_sign", () => h.server.stop());
  const result = await h.clock.settle(h.run({ ...input, lines: [""] }), SERVER_CLOCK_STOPPED_MS + 6_000);
  assert.equal(result.status, "partial");
  assert.equal(result.sign.confirmed, false);
});

test("an incomplete entity answer cannot confirm empty lines", async (t) => {
  const h = setup(t);
  using _timers = h.clock.install();
  h.server.onPacket("update_sign", () => {
    h.server.stop();
    h.world.setCell(target, "oak_sign");
    h.bot.emit("blockEntityData", h.bot.blockAt(target));
  });
  const result = await h.clock.settle(h.run({ ...input, lines: [""] }), SERVER_CLOCK_STOPPED_MS + 6_000);
  assert.equal(result.status, "partial");
  assert.equal(result.sign.confirmed, false);
  assert.deepEqual(h.data.read("SELECT * FROM observed_signs"), []);
});

for (const ticksPerSecond of [20, 10]) test(`a late placement answer starts its own editor wait (${ticksPerSecond} tps)`, async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  // The sign is already held: delay the otherwise empty equip before sending.
  const h = setup(t, { clock, overrides: { equip: () => clock.sleep(5_000) }, signs: { withheld: true }, server: { ticksPerSecond } });
  using _timers = h.clock.install();
  let placementAnswerAge = -1;
  h.inventory.once("updateSlot", () => { placementAnswerAge = h.bot.time.age; });
  const result = await h.clock.settle(h.run(), 15_000);
  assert.equal(result.status, "partial");
  assert.ok(placementAnswerAge >= 40);
  assert.ok(h.bot.time.age >= placementAnswerAge + 40, `waited ${h.bot.time.age - placementAnswerAge} ticks after placement answer`);
});

for (const exit of ["abort", "disconnect"] as const) test(`listeners released after ${exit}`, async (t) => {
  const h = setup(t);
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  const controller = new AbortController();
  const trigger = () => {
    if (exit === "abort") controller.abort(new Error("cancelled"));
    if (exit === "disconnect") h.bot.emit("end", "disconnected");
  };
  const remove = h.server.onPacket("block_place", trigger);
  const promise = h.run(input, controller.signal);
  await assert.rejects(h.clock.settle(promise, 6_000), /cancelled|Disconnected|Died/);
  remove();
  await assertReleased(h, added);
});
