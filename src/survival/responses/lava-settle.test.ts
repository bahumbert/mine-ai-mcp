import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, flush, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { awaitLavaSettled, escapeThenSettle, type LavaSettle } from "./lava-settle.js";

for (const rate of [20, 10]) for (const contact of ["none", "lava", "fire"] as const) {
  test(`a second escape at the settle deadline ${contact === "none" ? "out of lava is spreading" : `still in ${contact} stays timed_out`} (${rate} tps)`, async () => {
    const scene = settleScene({ ticksPerSecond: rate });
    using _timers = scene.clock.install();
    const added = listenersAddedSince(scene.bot);
    const timers = scene.clock.pendingGlobalTimers();
    let result: unknown;
    const output = escapeThenSettle(scene.bot, new MemoryWorld(), scene.abort.signal, "contact", () => scene.bot.time.age);
    void output.then(value => { result = value; });
    await flush();
    // Re-enter lava after the first escape; freeze physics once the second swim starts.
    Object.assign(scene.bot.entity, { isInLava: true, onGround: false });
    await scene.advance(1);
    scene.bot.physicsEnabled = false;
    if (contact !== "lava") Object.assign(scene.bot.entity, { isInLava: false });
    if (contact === "fire") scene.fake.setCell(scene.bot.entity.position.floored(), "fire");
    const endMs = rate === 20 ? 11_050 : 22_050;
    await scene.clock.advance(endMs - scene.clock.now() - 1);
    assert.equal(result, undefined, "rerun keeps the original settle budget");
    await scene.clock.advance(1);
    assert.deepEqual(await output, contact === "none"
      ? { escape: "escaped", settle: "spreading" }
      : { escape: "timed_out", settle: null });
    assert.equal(Object.values(scene.bot.controlState).some(Boolean), false);
    assert.equal(scene.bot.time.age, 1_220, "the entire settle phase is within 239 ticks");
    assert.equal(scene.clock.pendingGlobalTimers(), timers);
    for (const event of ["physicsTick", "death", "respawn", "entityHurt"]) assert.equal(added(event), 0, event);
    await scene.clock.advance(48_000);
    assert.equal(scene.clock.pendingGlobalTimers(), timers);
  });
}

/** A bot standing on dry ground; `lastChange` is the world age of the last lava change the reflex heard of. */
function settleScene(options: { dimension?: string; lavaBeside?: boolean; attacker?: boolean; ticksPerSecond?: number } = {}) {
  // Install the mocked clock only for tests that wait on the wall clock.
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, combat, server, world: fake } = createFakeBot({
    clock,
    dimension: options.dimension,
    server: { startAge: 1000, ticksPerSecond: options.ticksPerSecond ?? 20 },
    cells: options.lavaBeside ? { "-1,64,0": { name: "lava", properties: { level: 0 } } } : {},
    entities: options.attacker ? { 9: { name: "zombie", position: new Vec3(5.5, 64, 0.5) } } : {},
  });
  const playerKeys = bot.registry.entitiesByName.player!.metadataKeys!;
  const airSupplyIndex = playerKeys.indexOf("air_supply");
  const sharedFlagsIndex = playerKeys.indexOf("shared_flags");
  const metadata: number[] = [];
  metadata[airSupplyIndex] = 300;
  metadata[sharedFlagsIndex] = 0;
  Object.assign(bot.entity, { metadata });
  const scene = {
    bot,
    fake,
    combat,
    clock,
    server,
    metadata,
    airSupplyIndex,
    sharedFlagsIndex,
    /** The fake's own physics plugin listens on these; a wait must leave exactly what it found. */
    listeners: { physicsTick: bot.listenerCount("physicsTick"), death: bot.listenerCount("death"), respawn: bot.listenerCount("respawn") },
    lastChange: null as number | null,
    abort: new AbortController(),
    result: undefined as LavaSettle | undefined,
    error: undefined as unknown,
    /** Let `ticks` of world age pass, 20 a second as the server's time packets bring them, with a physics tick every 50 ms. */
    async advance(ticks: number) {
      await clock.advance(ticks * 1000 / (options.ticksPerSecond ?? 20));
    },
    start(maximumTicks?: number) {
      awaitLavaSettled(bot, scene.abort.signal, () => scene.lastChange, { maximumTicks }).then(
        (value) => (scene.result = value),
        (error) => (scene.error = error),
      );
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return scene;
}

for (const lastChange of [null, 940]) {
test(`settled at once when ${lastChange === null ? "no lava changed" : "the last change is two flow steps old"}`, async () => {
  const scene = settleScene();
  scene.lastChange = lastChange;
  await scene.start();
  assert.equal(scene.result, "settled", "no physics tick has run");
});
}

for (const rate of [20, 10]) for (const { dimension, lastChange, before, after } of [
  { dimension: "overworld", lastChange: 1000, before: 40, after: 20 },
  { dimension: "the_nether", lastChange: 1010, before: 20, after: 20 },
]) {
test(`${dimension} lava waits two flow steps after the last change (${rate} tps)`, async () => {
  const scene = settleScene({ dimension, ticksPerSecond: rate });
  using _timers = scene.clock.install();
  const added = listenersAddedSince(scene.bot);
  scene.lastChange = lastChange;
  await scene.start();
  assert.equal(added("entityHurt"), 1, "damage is observed throughout the quiet window");
  await scene.advance(before);
  assert.equal(scene.result, undefined);
  await scene.advance(after);
  assert.equal(scene.result, "settled");
  for (const event of ["physicsTick", "death", "respawn", "entityHurt"]) assert.equal(added(event), 0, event);
  assert.equal(scene.clock.pendingGlobalTimers(), 0);
});
}

test("a change during the wait restarts the quiet window", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  await scene.advance(40);
  scene.lastChange = 1040;
  await scene.advance(40);
  assert.equal(scene.result, undefined, "age 1080 is only 40 ticks after the change at 1040");
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1100 is 60 ticks after the change");
});

for (const [rate, endMs] of [[20, 11_050], [10, 22_050]] as const) {
test(`still changing after 200 server ticks is spreading (${rate} tps)`, async () => {
  const scene = settleScene({ ticksPerSecond: rate });
  using _timers = scene.clock.install();
  scene.lastChange = 1000;
  // The lava goes on changing: each physics tick hears of a change at the current age.
  scene.bot.on("physicsTick", () => { scene.lastChange = scene.bot.time.age; });
  const added = listenersAddedSince(scene.bot);
  const timers = scene.clock.pendingGlobalTimers();
  await scene.start();
  await scene.clock.advance(endMs - 1);
  assert.equal(scene.result, undefined);
  await scene.clock.advance(1);
  assert.equal(scene.result, "spreading");
  assert.equal(scene.bot.time.age, 1_220);
  assert.equal(scene.clock.now(), endMs);
  assert.equal(scene.clock.pendingGlobalTimers(), timers);
  for (const event of ["physicsTick", "death", "respawn", "entityHurt"]) assert.equal(added(event), 0, event);
  await scene.clock.advance(48_000);
  assert.equal(scene.result, "spreading");
});
}

test("the wall clock ends the wait when physics ticks stop", async () => {
  const scene = settleScene();
  using _timers = scene.clock.install();
  scene.lastChange = 1000;
  await scene.start();
  // A server that stopped answering: the world age stands still and the client runs no physics tick.
  scene.server.stop();
  scene.bot.physicsEnabled = false;
  await scene.clock.advance(19_999);
  assert.equal(scene.result, undefined);
  await scene.clock.advance(1);
  assert.equal(scene.result, "spreading", "no physicsTick was emitted at all");
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick, "the tick listener is gone");
  assert.equal(scene.bot.listenerCount("death"), scene.listeners.death);
  assert.equal(scene.bot.listenerCount("respawn"), scene.listeners.respawn);
  assert.equal(scene.bot.time.age, 1_000);
  assert.equal(scene.clock.pendingGlobalTimers(), 0);
});

test("lava advancing into the body is advancing", async () => {
  const scene = settleScene({ lavaBeside: true });
  scene.lastChange = 1000;
  await scene.start();
  assert.equal(scene.result, "advancing", "lava level 0 beside the body can spread into it");
});

test("lava under the body is advancing", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  Object.assign(scene.bot.entity, { isInLava: true });
  await scene.advance(20);
  assert.equal(scene.result, "advancing");
});

test("damage during the wait is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.bot.health = 16;
  await scene.advance(20);
  assert.equal(scene.result, "endangered");
});

test("a burn tick on dry ground while burning does not end the wait", async () => {
  const scene = settleScene();
  scene.lastChange = 1020;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  for (const health of [19, 18, 17]) {
    scene.bot.health = health;
    await scene.advance(20);
  }
  assert.equal(scene.result, undefined, "burning ticks lost 3 HP by age 1060 and the wait goes on");
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1080: two flow steps since the change at 1020");
});

test("a mob hit while burning is endangered", async () => {
  const scene = settleScene({ attacker: true });
  scene.lastChange = 1000;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  assert.equal(scene.result, undefined, "the burn tick alone does not end it");
  scene.combat.hurtBot(4, 9);
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "a hit with a source entity is not the burn");
});

test("health lost after the fire is out is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  scene.metadata[scene.sharedFlagsIndex] = 0;
  await scene.advance(20);
  assert.equal(scene.result, undefined, "the fire went out in the same second as its last burn tick");
  scene.bot.health = 18;
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "a loss with no fire on the body is something else");
});

test("air at 10 is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.metadata[scene.airSupplyIndex] = 150;
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "150 ticks of air is 10 points of 20");
});

test("death during the wait is died immediately and leaves no budget", async () => {
  const scene = settleScene();
  using _timers = scene.clock.install();
  const added = listenersAddedSince(scene.bot);
  scene.lastChange = 1000;
  await scene.start();
  scene.bot.health = 0;
  scene.bot.emit("death");
  await flush();
  assert.equal(scene.result, "died");
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick);
  assert.equal(scene.clock.now(), 0);
  assert.equal(scene.clock.pendingGlobalTimers(), 0);
  await scene.clock.advance(48_000);
  for (const event of ["physicsTick", "death", "respawn", "entityHurt"]) assert.equal(added(event), 0, event);
});

test("an aborted signal rejects and leaves no listeners", async () => {
  const scene = settleScene();
  using _timers = scene.clock.install();
  scene.lastChange = 1000;
  await scene.start();
  scene.abort.abort(new Error("cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(scene.error), /cancelled/);
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick);
  assert.equal(scene.bot.listenerCount("death"), scene.listeners.death);
  assert.equal(scene.clock.pendingGlobalTimers(), 0);
});

for (const phase of ["settle", "rerun"] as const) for (const exit of ["death", "respawn", "abort", "observation throws"] as const) {
  test(`${exit} during ${phase} releases the shared settle budget`, async () => {
    const scene = settleScene({ ticksPerSecond: 10 });
    using _timers = scene.clock.install();
    const added = listenersAddedSince(scene.bot);
    let throws = false;
    const failure = new Error(exit);
    const output = escapeThenSettle(scene.bot, new MemoryWorld(), scene.abort.signal, "contact", () => {
      if (throws) throw failure;
      return scene.bot.time.age;
    });
    const result = output.then(value => value, (error: unknown) => error);
    await flush();
    if (phase === "rerun") {
      Object.assign(scene.bot.entity, { isInLava: true, onGround: false });
      await scene.clock.advance(50);
      // Returning to safe ground re-enters the settle observer, where its callback can throw.
      if (exit === "observation throws") Object.assign(scene.bot.entity, { isInLava: false, onGround: true });
    }
    if (exit === "death") { scene.bot.health = 0; scene.bot.emit("death"); }
    if (exit === "respawn") scene.bot.emit("respawn");
    if (exit === "abort") scene.abort.abort(failure);
    if (exit === "observation throws") { throws = true; await scene.clock.advance(50); }
    await flush();
    const answer = await result;
    if (exit === "death" || exit === "respawn") assert.deepEqual(answer, phase === "settle"
      ? { escape: "escaped", settle: "died" }
      : { escape: exit === "death" ? "died" : "blocked", settle: null });
    else assert.equal(answer, failure);
    assert.equal(scene.clock.pendingGlobalTimers(), 0);
    assert.equal(Object.values(scene.bot.controlState).some(Boolean), false);
    for (const event of ["physicsTick", "death", "respawn", "entityHurt"]) assert.equal(added(event), 0, event);
    await scene.clock.advance(48_000);
    assert.equal(scene.clock.pendingGlobalTimers(), 0);
  });
}
