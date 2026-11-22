// A sign click whose packet send throws ends the action at once, and nothing it left behind fires later (F17).
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, flush, listenersAddedSince, type FakeBotOptions } from "../../test-support/fake-bot/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { SERVER_ANSWER_TICKS, SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { createPlaceSignAction } from "./index.js";

const target = new Vec3(2, 64, 0);
const input = { x: 2, y: 64, z: 0, facing: "north", lines: ["Builder", "Hello"], fill_blank: true };
const EVENTS = ["signOpen", "blockEntityData", "end", "death", "error"];

/** A blank sign entity in the cell, as sign-edit measured after a setblock (fill mode), or an empty cell (place mode). */
function setup(t: TestContext, rate: number, options: FakeBotOptions = {}, request: unknown = input) {
  const clock = createFakeClock({ mode: "mocked" });
  const signs = { ...options.signs };
  const h = createFakeBot({ carried: { oak_sign: 3 }, cells: { "2,64,0": "oak_sign" }, ...options, signs, server: { startAge: 0, ticksPerSecond: rate }, clock });
  const data = temporaryBotData({ closeAfter: t });
  const action = createPlaceSignAction({ bot: h.bot, botData: data, navigation: { navigate: async () => { throw new Error("unexpected route"); } } as never });
  const lifetime = new AbortController();
  const run = action.begin(action.parse(request), lifetime.signal, () => {});
  const block = h.bot.blockAt(target);
  if (block?.name === "oak_sign") {
    block.setSignText("\n\n\n", "\n\n\n");
    h.world.setCell(target, { name: block.name, properties: {}, entity: block.entity! });
  }
  return { ...h, signs, action, lifetime, run };
}
type Setup = ReturnType<typeof setup>;

/** Observers taken before the action, and the process's unhandled rejections, restored when the test ends however it ends (T6, T8). */
function watch(t: TestContext, h: Setup) {
  const added = listenersAddedSince(h.bot);
  const seen: unknown[] = [];
  const record = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => void process.off("unhandledRejection", record));
  return { added, unhandled: async () => { await flush(); return seen; } };
}

/** Every observer and wait of the finished action is gone now, and stays gone past its old deadline. */
async function assertReleased(h: Setup, added: (event: string) => number) {
  const check = () => {
    for (const event of EVENTS) assert.equal(added(event), 0, event);
    assert.equal(h.clock.pendingTimers(), 0);
    assert.equal(h.server.packets.filter((packet) => packet.name === "update_sign").length, 0);
  };
  check();
  await h.clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
  check();
}

/** The request after the failed one works (the ordinary placement and edit of a fresh sign). */
async function nextSignWorks(h: Setup) {
  const next = h.action.begin(h.action.parse({ ...input, x: 3, fill_blank: false }), new AbortController().signal, () => {});
  assert.equal((await h.clock.settle(next({}), 6_000)).status, "succeeded");
  assert.equal(h.bot.blockAt(target.offset(1, 0, 0))?.getSignText()[0], "Builder\nHello\n\n");
}

/**
 * Make each `block_place` write throw `error` while armed; `before` runs first (a cut at the throw).
 * stopgap: a throwing client write is unmeasured (minecraft-protocol on a closed socket), waits for a contract.
 */
function throwOnBlockPlace(h: Setup, error: Error, before: () => void = () => {}) {
  const write = h.bot._client.write.bind(h.bot._client);
  let armed = true;
  h.bot._client.write = (name: string, data: unknown) => {
    if (armed && name === "block_place") { before(); throw error; }
    return write(name, data);
  };
  return () => { armed = false; };
}

/**
 * Make the held-item click report "sent" and reject only when the test says so.
 * stopgap: a client write rejecting after the action ended is unmeasured, waits for a contract.
 */
function rejectClickLater(h: Setup) {
  let reject!: (error: Error) => void;
  const late = new Promise<never>((_, fail) => { reject = fail; });
  const bot = h.bot as unknown as { _genericPlace: (block: unknown, face: unknown, options: { onSent(): void }) => Promise<unknown> };
  const original = bot._genericPlace;
  bot._genericPlace = (_block, _face, options) => {
    options.onSent();
    return late;
  };
  return { reject, restore: () => { bot._genericPlace = original; } };
}

const blockPlaces = (h: Setup) => h.server.packets.filter((packet) => packet.name === "block_place").length;

for (const rate of [20, 10]) {
  test(`fill click whose send throws: no unhandled rejection, settles before the editor deadline, next sign works (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const { added, unhandled } = watch(t, h);
    const reconnect = throwOnBlockPlace(h, new Error("write exploded"));
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_NO_EDITOR.*click was not sent: write exploded/);
    assert.ok(h.bot.time.age < SERVER_ANSWER_TICKS, `settled at world age ${h.bot.time.age}, before the ${SERVER_ANSWER_TICKS}-tick editor wait`);
    assert.deepEqual(await unhandled(), []);
    await assertReleased(h, added);
    reconnect();
    await nextSignWorks(h);
  });

  test(`fill click cancelled, then its rejection arrives after the cancellation settled: nothing changes (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const { added, unhandled } = watch(t, h);
    const click = rejectClickLater(h);
    const pending = h.run({});
    const settled = assert.rejects(h.clock.settle(pending, 6_000), /request cancelled/);
    await flush();
    h.lifetime.abort(new Error("request cancelled"));
    await settled;
    await assertReleased(h, added);
    click.reject(new Error("late write error"));
    assert.deepEqual(await unhandled(), []);
    await assertReleased(h, added);
    assert.equal(blockPlaces(h), 0);
    click.restore();
    await nextSignWorks(h);
  });

  for (const stopped of [false, true]) test(`click failed at a reflex cut: the resume reports it at once, sends nothing, next sign works (${rate} tps, stopped ${stopped})`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const { added, unhandled } = watch(t, h);
    const cut = new AbortController();
    const reconnect = throwOnBlockPlace(h, new Error("write exploded"), () => cut.abort(new Error("reflex cut")));
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    reconnect();
    if (stopped) h.server.stop();
    const result = await h.clock.settle(h.run({}), 1_000);
    assert.equal(result.status, "failed");
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_NO_EDITOR.*click was not sent: write exploded/);
    assert.equal(blockPlaces(h), 0, "the spent click is never sent again");
    assert.deepEqual(await unhandled(), []);
    h.server.resume();
    await assertReleased(h, added);
    await nextSignWorks(h);
  });

  test(`empty-hand click whose send throws: the throw reaches the action as before (${rate} tps)`, async (t) => {
    const h = setup(t, rate);
    using _timers = h.clock.install();
    const { added, unhandled } = watch(t, h);
    h.bot.setQuickBarSlot(1);
    const reconnect = throwOnBlockPlace(h, new Error("empty hand write exploded"));
    await assert.rejects(h.clock.settle(h.run({}), 6_000), /empty hand write exploded/);
    assert.deepEqual(await unhandled(), []);
    await assertReleased(h, added);
    reconnect();
    await nextSignWorks(h);
  });

  test(`place path reopening click whose send throws: partial, the sign stays ours (${rate} tps)`, async (t) => {
    const h = setup(t, rate, { cells: {}, signs: { withheld: true } }, { ...input, fill_blank: false });
    using _timers = h.clock.install();
    const { added, unhandled } = watch(t, h);
    const cut = new AbortController();
    const removeCut = h.server.onPacket("block_place", () => cut.abort(new Error("reflex cut")));
    await assert.rejects(h.clock.settle(h.run({ signal: cut.signal }), 6_000), /reflex cut/);
    removeCut();
    const reconnect = throwOnBlockPlace(h, new Error("write exploded"));
    const result = await h.clock.settle(h.run({}), 6_000);
    assert.equal(result.status, "partial");
    assert.equal(result.sign.placed, true);
    assert.match("error" in result ? result.error : "", /PLACE_SIGN_TEXT_UNCONFIRMED.*click was not sent: write exploded/);
    assert.deepEqual(await unhandled(), []);
    reconnect();
    h.signs.withheld = false;
    await assertReleased(h, added);
    await nextSignWorks(h);
  });
}
