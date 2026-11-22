/** The sign editor and its answers, as measured by contract sign-edit. */
import assert from "node:assert/strict";
import { once, type EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, type FakeHarness } from "./fake-bot.js";

const SUPPORT = new Vec3(0, 63, 0);
const SIGN = new Vec3(0, 64, 0);
const ANSWER_BOUND = 6_000;

function click(harness: FakeHarness, location: Vec3): void {
  harness.bot._client.write("block_place", { location, direction: 1, hand: 0, cursorY: 0.5, sequence: 1 });
}

function answer(harness: FakeHarness, name: string): Promise<unknown[]> {
  return once(harness.bot._client as EventEmitter, name);
}

/** Wait on server ticks, including for an absent packet, instead of a predicted wall delay. */
function ticks(harness: FakeHarness, count: number): Promise<void> {
  const start = harness.server.gameTime;
  return new Promise((resolve) => {
    const remove = harness.server.onTick(() => {
      if (harness.server.gameTime - start >= count) { remove(); resolve(); }
    });
  });
}

async function place(harness: FakeHarness): Promise<void> {
  const done = answer(harness, "acknowledge_player_digging");
  click(harness, SUPPORT);
  await harness.clock.settle(done, ANSWER_BOUND);
}

async function write(harness: FakeHarness, text: string): Promise<void> {
  const done = answer(harness, "tile_entity_data");
  harness.bot.updateSign(harness.bot.blockAt(SIGN)!, text);
  await harness.clock.settle(done, ANSWER_BOUND);
}

test("editor delivery, text and client updates follow the measured answer at both rates", async () => {
  for (const ticksPerSecond of [20, 10]) {
    for (const inventoryPlugin of [false, true]) {
      const h = createFakeBot({ carried: { oak_sign: 2 }, server: { ticksPerSecond } });
      if (inventoryPlugin) h.bot.updateHeldItem();
      const slots: number[] = [];
      h.inventory.on("updateSlot", (slot: number) => slots.push(slot));
      const phases: { name: string; tick: number }[] = [];
      for (const name of ["open_sign_entity", "tile_entity_data", "set_slot"]) {
        (h.bot._client as EventEmitter).on(name, () => phases.push({ name, tick: h.server.gameTime }));
      }
      const opened = new Promise<ReturnType<typeof h.bot.blockAt>>((resolve) => h.bot.once("signOpen", resolve));
      await place(h);
      const block = await opened;
      assert.ok(block);
      assert.ok(block.position.equals(SIGN));
      assert.deepEqual(slots, [36]);
      assert.deepEqual(phases.map(({ name }) => name), ["open_sign_entity", "tile_entity_data", "set_slot"]);
      assert.ok(phases[1]!.tick > phases[0]!.tick);
      let updates = 0;
      h.bot.on("blockUpdate", (_old, block) => { if (block?.position.equals(SIGN)) updates++; });
      await write(h, "one\ntwo");
      assert.equal(updates, 1);
      assert.deepEqual(h.bot.blockAt(SIGN)!.getSignText(), ["one\ntwo\n\n", "\n\n\n"]);
    }
  }
});

test("withheld editor on placement and click rejects a write and permits the next placement", async () => {
  for (const ticksPerSecond of [20, 10]) {
    const h = createFakeBot({ carried: { oak_sign: 1, cobblestone: 1 }, signs: { withheld: true }, server: { ticksPerSecond } });
    let opened = 0;
    h.bot.on("signOpen", () => { opened++; });
    await place(h);
    const ack = answer(h, "acknowledge_player_digging");
    click(h, SIGN);
    await h.clock.settle(ack, ANSWER_BOUND);
    h.bot.updateSign(h.bot.blockAt(SIGN)!, "ignored");
    await h.clock.settle(ticks(h, 40), ANSWER_BOUND);
    assert.equal(opened, 0);
    assert.equal(h.bot.blockAt(SIGN)!.getSignText()[0], "\n\n\n");
    h.bot.setQuickBarSlot(1);
    const next = h.bot._placeBlockWithOptions(h.bot.blockAt(SUPPORT.offset(1, 0, 0))!, new Vec3(0, 1, 0), { forceLook: "ignore" });
    await h.clock.settle(next, ANSWER_BOUND);
    assert.equal(h.bot.blockAt(SIGN.offset(1, 0, 0))!.name, "cobblestone");
  }
});

test("a stopped server holds a pending edit until it resumes", async () => {
  for (const ticksPerSecond of [20, 10]) {
    const h = createFakeBot({ carried: { oak_sign: 1 }, server: { ticksPerSecond } });
    await place(h);
    const age = h.bot.time.age;
    const done = answer(h, "tile_entity_data");
    h.server.stop();
    h.bot.updateSign(h.bot.blockAt(SIGN)!, "after stall");
    await h.clock.advance(12_000);
    assert.equal(h.bot.time.age, age);
    assert.equal(h.bot.blockAt(SIGN)!.getSignText()[0], "\n\n\n");
    h.server.resume();
    await h.clock.settle(done, ANSWER_BOUND);
    assert.equal(h.bot.blockAt(SIGN)!.getSignText()[0], "after stall\n\n\n");
  }
});
