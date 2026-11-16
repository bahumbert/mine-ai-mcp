// Server packets, rather than client air predictions, confirm each swing of a falling column.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince, type FakeCell } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { MineflayerBot, mineflayerBotSurface } from "./bot.js";
import { MineflayerWorldView } from "./world.js";
import { createNavigator } from "../orchestration/navigator.js";
import { exactBlockGoal } from "../goals/index.js";
import { createMovementPolicy } from "../movements/policy.js";

const CELL = new Vec3(1, 64, 0);
const TOKEN = { runId: "column", planId: "column", stepId: "dig", attempt: 0 };

/** Stage the measured packet order: client blockUpdate first, covering packet second (12b trace, 2026-11-15). */
function column(ticksPerSecond = 5, broughtBlocks = 2, tool = "iron_shovel", simulatePhysics = false) {
  const clock = createFakeClock({ mode: "mocked" });
  const fake = createFakeBot({ clock, simulatePhysics, server: { ticksPerSecond, startAge: 0 }, cells: { "1,64,0": "sand" }, slots: { 36: { name: tool, count: 1 } } });
  fake.server.resendTime();
  const surface = mineflayerBotSurface(fake.bot);
  const resyncs: unknown[] = [];
  surface.requestCellResync = async (cell) => { resyncs.push(cell); return "resent"; };
  const actuator = new MineflayerBot(surface, { revision: 1 });
  const operation = { kind: "break", position: CELL, expectedStateId: fake.world.blockAt(CELL)!.stateId,
    toolType: fake.bot.registry.itemsByName[tool]!.id,
    brings: Array.from({ length: broughtBlocks }, (_, index) => CELL.offset(0, index + 1, 0)), } as const;
  const packet = (state: FakeCell) => {
    fake.world.setCell(CELL, state);
    fake.bot._client.emit("block_change", { location: CELL, type: fake.world.blockAt(CELL)?.stateId ?? 0 });
  };
  const start = (signal = new AbortController().signal) => actuator.startEffect(operation, TOKEN, signal);
  const digs = () => fake.server.packets.filter(p => p.name === "block_dig" && (p.data as { status: number }).status === 0);
  return { ...fake, clock, actuator, operation, packet, start, digs, resyncs };
}

test("two brought blocks need three server-confirmed digs; unbroken sand is not the next landing", async () => {
  const run = column();
  using _clock = run.clock.install();
  run.clock.after(400, () => run.packet("air"));
  run.clock.after(1_800, () => run.packet("sand"));
  run.clock.after(2_000, () => run.packet("sand"));
  run.clock.after(2_600, () => run.packet("air"));
  run.clock.after(4_000, () => run.packet("sand"));
  run.clock.after(4_800, () => run.packet("air"));
  assert.deepEqual(await run.clock.settle(run.start().completion, 8_000), { kind: "accepted" });
  assert.equal(run.digs().length, 3);
  assert.ok(run.digs()[2]!.atMs >= 2_600, "third swing follows the second removal, never its unbroken resend");
  assert.equal(run.world.blockAt(CELL)?.stateId, 0);
});

for (const missing of ["refill", "first", "unloaded"] as const) {
  test(`${missing} removal is unconfirmed despite a resend or predicted air; asks for resync at +40 age`, async () => {
    const run = column(5, missing === "refill" ? 1 : 0);
    using _clock = run.clock.install();
    const added = listenersAddedSince(run.bot._client);
    if (missing === "refill") {
      run.clock.after(400, () => run.packet("air"));
      run.clock.after(1_800, () => run.packet("sand"));
      run.clock.after(2_000, () => run.packet("sand"));
    } else run.clock.after(100, () => {
      if (missing !== "unloaded") return run.packet("sand");
      run.world.setCell(CELL, "void");
      run.bot._client.emit("map_chunk", { x: 0, z: 0 });
    });
    const completion = await run.clock.settle(run.start().completion, 9_000);
    assert.equal(completion.kind, "failed");
    assert.match(completion.kind === "failed" ? completion.observation : "", /server did not confirm breaking the block at 1,64,0/);
    assert.match(completion.kind === "failed" ? completion.observation : "", /asked it to resend the cell/);
    assert.equal(run.bot.time.age, 40);
    assert.ok(run.clock.now() >= 8_000 && run.clock.now() <= 8_800, "40 ticks at 5 tps, after the swing");
    assert.deepEqual(run.resyncs, [CELL]);
    for (const name of ["block_change", "multi_block_change", "map_chunk"]) assert.equal(added(name), 0);
  });
}

test("removal and landing packets between looks are retained separately", async () => {
  const run = column(5, 1);
  using _clock = run.clock.install();
  run.clock.after(400, () => { run.packet("air"); run.packet("sand"); });
  run.clock.after(1_000, () => run.packet("air"));
  assert.deepEqual(await run.clock.settle(run.start().completion, 8_000), { kind: "accepted" });
  assert.equal(run.digs().length, 2);
  assert.equal(run.world.blockAt(CELL)?.stateId, 0);
});

for (const ticksPerSecond of [5, 10, 20]) {
  test(`no landing waits 40 world ticks at ${ticksPerSecond} tps`, async () => {
    const run = column(ticksPerSecond, 1);
    using _clock = run.clock.install();
    run.clock.after(400, () => run.packet("air"));
    const completion = run.start().completion;
    const pending = watch(completion);
    const wallMs = 40_000 / ticksPerSecond;
    await run.clock.advance(wallMs - 25, 25);
    assert.equal(pending.over, false);
    assert.deepEqual(await run.clock.settle(completion, 25, 25), { kind: "accepted" });
    assert.equal(run.clock.now(), wallMs);
    assert.equal(run.bot.time.age, 40);
  });
}

test("abort in a refill answer wait removes listeners and timers; a late packet changes no completion", async () => {
  const run = column(5, 1);
  using _clock = run.clock.install();
  const added = listenersAddedSince(run.bot._client);
  const controller = new AbortController();
  run.clock.after(400, () => run.packet("air"));
  run.clock.after(1_800, () => run.packet("sand"));
  const completion = run.start(controller.signal).completion;
  await run.clock.advance(2_200);
  controller.abort(new Error("stop column"));
  const result = await run.clock.settle(completion, 50);
  assert.deepEqual(result, { kind: "failed", observation: "stop column" });
  for (const name of ["block_change", "multi_block_change", "map_chunk"]) assert.equal(added(name), 0);
  assert.equal(run.clock.pendingTimers(), 0);
  run.packet("air");
  assert.deepEqual(await completion, result);
});

test("a pickaxe lost between swings fails with the inventory fact and disposes the watch", async () => {
  const run = column(5, 1, "iron_pickaxe");
  using _clock = run.clock.install();
  const added = listenersAddedSince(run.bot._client);
  run.clock.after(1_000, () => run.packet("air"));
  run.clock.after(1_800, () => { run.inventory.tossStack(run.bot.heldItem!); run.packet("sand"); });
  const result = await run.clock.settle(run.start().completion, 9_000);
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.observation : "", /not in the inventory/);
  assert.equal(added("block_change"), 0);
});

test("after a stopped column clock, resumed sand is broken and the next navigation walks on", async () => {
  const run = column(5, 1, "iron_shovel", true);
  using _clock = run.clock.install();
  const added = listenersAddedSince(run.bot._client);
  for (let x = -1; x <= 4; x++) {
    for (const y of [64, 65]) for (const z of [-1, 1]) run.world.setCell(new Vec3(x, y, z), "bedrock");
    run.world.setCell(new Vec3(x, 66, 0), "bedrock");
  }
  run.clock.after(400, () => { run.packet("air"); run.server.stop(); });
  const completion = run.start().completion;
  const pending = watch(completion);
  await run.clock.advance(20_375, 25);
  assert.equal(pending.over, false);
  const failed = await run.clock.settle(completion, 25, 25);
  assert.equal(failed.kind, "failed");
  assert.match(failed.kind === "failed" ? failed.observation : "", /server clock stood still.*column/);
  assert.equal(run.bot.time.age, 0);
  assert.equal(added("block_change"), 0);
  assert.equal(run.clock.pendingTimers(), 0);
  run.server.resume();
  run.packet("sand");
  const stop = run.server.onPacket("block_dig", data => {
    if ((data as { status: number }).status === 2) run.server.answer(() => run.packet("air"));
  });
  const world = new MineflayerWorldView(run.bot);
  const navigator = createNavigator({ world, bot: run.actuator });
  const next = navigator.startRun({ goal: exactBlockGoal({ x: 3, y: 64, z: 0 }), policy: createMovementPolicy() });
  if (next.kind !== "started") assert.fail("next run busy");
  try {
    assert.equal((await run.clock.settle(next.handle.outcome, 30_000)).kind, "completed");
    assert.equal(run.world.blockAt(CELL)?.stateId, 0);
    assert.equal(Math.floor(run.bot.entity.position.x), 3);
    assert.equal(navigator.active, null);
  } finally { next.handle.cancel(); await next.handle.outcome; stop(); world.close(); }
});
