// Request-owned sign progress across cuts, late answers and terminal exits.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince, type FakeBotOptions } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import type { RequestEvidence } from "../../session/request.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { createPlaceSignAction } from "./index.js";
import { placeSignCheckpointSchema } from "../checkpoint-schemas.js";

const target = new Vec3(2, 64, 0);
const input = { x: 2, y: 64, z: 0, facing: "north", lines: ["Builder", "Hello"] };

/** Keep the same executor, as the action runner does when a reflex releases the body. */
function setup(t: TestContext, ticksPerSecond: number, options: FakeBotOptions = {}, request: unknown = input) {
  const clock = createFakeClock({ mode: "mocked" });
  const h = createFakeBot({ carried: { oak_sign: 3 }, ...options, server: { startAge: 0, ticksPerSecond }, clock });
  const data = temporaryBotData({ closeAfter: t });
  const action = createPlaceSignAction({ bot: h.bot, botData: data, navigation: { navigate: async () => { throw new Error("unexpected route"); } } as never });
  const lifetime = new AbortController();
  let progress!: () => RequestEvidence;
  const run = action.begin(action.parse(request), lifetime.signal, (read) => { progress = read; });
  return { ...h, action, data, lifetime, run, checkpoint: () => placeSignCheckpointSchema.parse(progress().checkpoint) };
}

/** A second sign request must work after every resumed end state. */
async function nextSign(h: ReturnType<typeof setup>) {
  h.server.resume();
  const request = h.action.parse({ ...input, x: 3 });
  const next = h.action.begin(request, new AbortController().signal, () => {});
  const result = await h.clock.settle(next({}), 6_000);
  assert.equal(result.status, "succeeded");
  assert.equal(h.bot.blockAt(target.offset(1, 0, 0))?.getSignText()[0], "Builder\nHello\n\n");
}

/** Check terminal cleanup after the old waits' deadlines, with no observer resurrection. */
async function released(h: ReturnType<typeof setup>, added: (event: string) => number) {
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
  for (const event of ["signOpen", "blockEntityData", "end", "death", "error"]) assert.equal(added(event), 0, event);
  assert.equal(h.clock.pendingTimers(), 0);
}

const cuts = [
  ["before the send: places again", "approach"],
  ["after the send, before the block: settles the send, the sign is ours, writes", "sent"],
  ["after the block, before the slot: writes once", "sent"],
  ["after the edit, before the text: reads the asked lines and succeeds", "edit_sent"],
] as const;

for (const rate of [20, 10]) {
  for (const [name, phase] of cuts) test(`cut ${name} (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const abort = () => cut.abort(new Error("reflex cut"));
    const duringCut = phase === "edit_sent"
      ? new Promise<void>((resolve) => h.bot.on("blockEntityData", function text(block) {
        if (block?.position.equals(target) && block.getSignText()[0] === "Builder\nHello\n\n") { h.bot.removeListener("blockEntityData", text); resolve(); }
      }))
      : name.startsWith("after the block") ? new Promise<void>((resolve) => h.inventory.once("updateSlot", () => resolve())) : null;
    let remove = () => {};
    if (phase === "approach") abort();
    else if (name.startsWith("after the block")) h.bot.once("signOpen", abort);
    else remove = h.server.onPacket(phase === "edit_sent" ? "update_sign" : "block_place", abort);
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    assert.equal(h.checkpoint().phase, phase);
    // The server's queued block/editor/text may arrive while the reflex owns the body.
    if (duringCut) await h.clock.settle(duringCut, 1_000);
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "succeeded");
    assert.equal(result.sign.placed, true);
    assert.equal(result.sign.confirmed, true);
    assert.equal(h.server.packets.filter(({ name }) => name === "block_place").length, 1);
    assert.equal(h.server.packets.filter(({ name }) => name === "update_sign").length, 1);
    assert.equal(h.bot.inventory.items().find(({ name }) => name === "oak_sign")?.count, 2);
    assert.equal(h.data.read("SELECT * FROM observed_signs")[0]?.placed_by_bot_id, h.bot.username);
    const checkpoint = h.checkpoint();
    assert.equal(checkpoint.mode, "place");
    assert.equal(checkpoint.clicked, false);
    assert.deepEqual(checkpoint.target, { x: 2, y: 64, z: 0 });
    assert.equal(typeof checkpoint.sentAge, "number");
    assert.ok(h.action.checkpointSchema?.safeParse(checkpoint).success);
    await released(h, added);
    await nextSign(h);
  });

  test(`cut after the edit, text never came, cell blank: partial unconfirmed, clicked false (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("update_sign", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    const age = h.bot.time.age;
    const result = await h.clock.settle(h.run({}), SERVER_CLOCK_STOPPED_MS + 100);
    assert.equal(result.status, "partial");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNCONFIRMED/);
    assert.equal(result.sign.placed, true);
    assert.deepEqual(result.sign.lines, ["", "", "", ""]);
    assert.equal(h.checkpoint().clicked, false);
    assert.equal(h.bot.time.age, age);
    assert.equal(h.server.packets.filter(({ name }) => name === "update_sign").length, 1);
    await released(h, added);
    await nextSign(h);
  });

  test(`a sign appearing that our send did not make: cell taken (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const cut = new AbortController();
    cut.abort(new Error("reflex cut"));
    await assert.rejects(h.run({ signal: cut.signal }), /reflex cut/);
    assert.deepEqual(h.checkpoint(), { mode: "place", phase: "approach", target: { x: 2, y: 64, z: 0 }, sentAge: null, clicked: false });
    h.world.setCell(target, "oak_sign");
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_CELL_TAKEN/);
    assert.equal(result.sign.placed, false);
    assert.equal(h.server.packets.length, 0);
    await nextSign(h);
  });

  test(`resume in an unloaded chunk: unloaded, no packet (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("block_place", () => cut.abort(new Error("reflex cut")));
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    assert.equal(h.checkpoint().mode, "place");
    assert.equal(h.checkpoint().clicked, false);
    assert.equal(typeof h.checkpoint().sentAge, "number");
    h.server.stop();
    h.world.setCell(target, "void");
    const packets = h.server.packets.length;
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_UNLOADED/);
    assert.equal(h.server.packets.length, packets);
    await released(h, added);
    h.world.setCell(target, "air");
    await nextSign(h);
  });

  for (const stage of ["send", "editor"]) test(`death between placement and write at ${stage}: the next place_sign at another cell succeeds (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const death = () => { h.bot.emit("death"); };
    const remove = stage === "send" ? h.server.onPacket("block_place", death) : () => {};
    if (stage === "editor") h.bot.once("signOpen", death);
    await assert.rejects(h.clock.settle(h.run({}), 6_000), /Died/);
    remove();
    assert.equal(h.checkpoint().mode, "place");
    assert.equal(h.checkpoint().clicked, false);
    assert.equal(typeof h.checkpoint().sentAge, "number");
    assert.equal(h.server.packets.filter(({ name }) => name === "update_sign").length, 0);
    await released(h, added);
    await nextSign(h);
  });

  test(`cancel a suspended sign request releases its observers and prevents resume (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("block_place", () => cut.abort(new Error("reflex cut")));
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    assert.equal(added("signOpen"), 1);
    assert.equal(added("blockEntityData"), 1);
    h.lifetime.abort(new Error("request cancelled during handoff"));
    for (const event of ["signOpen", "blockEntityData", "end", "death", "error"]) assert.equal(added(event), 0, event);
    await released(h, added);
    const packets = h.server.packets.length;
    await assert.rejects(h.run({}), /request cancelled during handoff/);
    assert.equal(h.server.packets.length, packets);
    await nextSign(h);
  });

  for (const answered of [false, true]) test(`empty edit cut needs its own entity answer: answered ${answered} (${rate} tps)`, async (t) => {
    const h = setup(t, rate, {}, { ...input, lines: [""] });
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const cut = new AbortController();
    const remove = h.server.onPacket("update_sign", () => { h.server.stop(); cut.abort(new Error("reflex cut")); });
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    remove();
    if (answered) {
      const entity = new Promise<void>((resolve) => h.bot.once("blockEntityData", () => resolve()));
      h.server.resume();
      await h.clock.settle(entity, 1_000);
    }
    const age = h.bot.time.age;
    const result = await h.clock.settle(h.run({}), SERVER_CLOCK_STOPPED_MS + 100);
    assert.equal(result.status, answered ? "succeeded" : "partial");
    assert.equal(result.sign.confirmed, answered);
    assert.equal(h.bot.time.age, age);
    assert.equal(h.server.packets.filter(({ name }) => name === "update_sign").length, 1);
    await released(h, added);
    await nextSign(h);
  });
}
