import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { type FakeBotOptions, type FakeClock, blockUpdateEventOf, createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { cellKey } from "../../utils/index.js";
import { pendingLifeSavingPlacements } from "../../world/life-saving-placements.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { FootingRecovery } from "./footing.js";
import { forgetVehicle, resumePhysics } from "../../actions/navigate/vehicle-sync.js";
import { createNavigateAction } from "../../actions/navigate/navigate.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { ReflexDriver } from "../control/driver.js";
import { attachFootingReflex } from "../reflexes/footing.js";
import { waterLandingActive } from "../../navigation/mineflayer/water-landing.js";

/** C11 physics rows 41.339–41.693, paired position/velocity from incident 65f5f7b6 (2026-11-17). */
const cornerFlight = [
  [[-2.8266026718261186, 100.90825187307134, -6.459799643930218], [-0.06739036796730159, 0.04691330409737672, -0.2355562481369469]],
  [[-2.891746317478183, 100.95516517716871, -6.675482486751562], [-0.05928071754337844, -0.03242496261564946, -0.1962713869674235]],
  [[-2.966894101827387, 100.92274021455306, -6.883929102299159], [-0.06838448375777587, -0.11017646550767246, -0.18968642014831283]],
  [[-3.019129077475467, 100.81256374904538, -7.061817497705386], [-0.047533827839752824, -0.18637293982484723, -0.1618784398196666]],
  [[-3.0504518445481534, 100.62619080922053, -7.211982632747728], [-0.02850371803614479, -0.2610454861090109, -0.1366502728885316]],
  [[-3.0626833935942814, 100.36514532311152, -7.337004641949864], [-0.011130709631976507, -0.3342245828917571, -0.11377002837394413]],
  [[-3.0574210577826206, 100.03092074021976, -7.439317442863255], [0.004788725588611274, -0.4059400991346289, -0.09310464883118615]],
  [[-3.0362093480113344, 99.62498064108513, -7.521007820340754], [0.019302655891870576, -0.4762213064205082, -0.07433824350452403]],
] as const;

/** The shared fake supplies native placement answers; navigation observes only their block_change packets. */
function catchingFixture(clock: FakeClock, ticksPerSecond: number) {
  const f = fixture(false, clock, {
    gameMode: "creative", carried: { cobblestone: 8 }, cells: { "0,46,0": "stone" },
    server: { ticksPerSecond }, lagMs: 1000 / ticksPerSecond,
  });
  for (let x = -3; x <= 5; x++) for (let z = -3; z <= 3; z++)
    f.world.load({ x, y: 46, z }, { stateId: x === 0 && z === 0 ? 1 : 0 });
  const answers: { cell: string; at: number; age: number }[] = [];
  f.bot._client.on("block_change", (packet: { location: Vec3; type: number }) => {
    f.world.load(packet.location, { stateId: packet.type });
    answers.push({ cell: cellKey(packet.location), at: clock.now(), age: f.server.gameTime });
  });
  return { ...f, answers };
}

/** Physics ticks `clock` runs until `pending` settles (at most `max`), as Mineflayer's ticks would drive it. */
async function ticksUntilSettled(clock: FakeClock, pending: Promise<unknown>, max = 20): Promise<number> {
  const settled = watch(pending);
  let ticks = 0;
  while (!settled.over && ticks < max) {
    await clock.advance(50);
    ticks++;
  }
  return ticks;
}

function fixture(wide = false, clock?: FakeClock, extra: FakeBotOptions = {}) {
  const world = new MemoryWorld();
  for (let x = -3; x <= 5; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 46; y <= 49; y++) world.load({ x, y, z }, { stateId: y === 46 && (wide || x === 0) ? 1 : 0 });
  // The recovery reads its geometry from `world`; the fake bot's own cells are open air, so its ticks always run.
  const harness = createFakeBot({
    position: new Vec3(0.8, 47, 0.5),
    groundY: null,
    clock,
    ...extra,
  });
  const { bot } = harness;
  const entity = bot.entity;
  const controls = new Map<string, boolean>();
  bot.setControlState = (name, value) => void controls.set(name, value);
  bot.clearControlStates = () => controls.clear();
  /** What the server and the body do on each physics tick, before the recovery hears it; nothing until a test says. */
  let onTick = () => {};
  bot.on("physicsTick", () => onTick());
  const impulse = (entityId = 1) =>
    bot._client.emit("entity_velocity", { entityId, velocity: { x: 2125, y: 2201, z: 0 } });
  return {
    ...harness,
    gameWorld: harness.world,
    world,
    entity,
    controls,
    impulse,
    onEachTick: (script: () => void) => {
      onTick = script;
    },
  };
}

/** Check each owner's settled cleanup before another owner or disposal can conceal a leak. */
function recoveryScope(f: ReturnType<typeof fixture>, recovery: FootingRecovery, throwOnFirstClear = false) {
  const added = listenersAddedSince(f.bot);
  const clientAdded = listenersAddedSince(f.bot._client);
  const botEvents = f.bot.eventNames().map(String);
  const clientEvents = f.bot._client.eventNames().map(String);
  const clear = f.bot.clearControlStates;
  let clears = 0;
  let settlements = 0;
  f.bot.clearControlStates = () => {
    clears++;
    clear();
    if (throwOnFirstClear && clears === 1) throw new Error("cleanup failed");
  };
  const departed = (expected: number, phase: string) => {
    assert.equal(clears, expected, "each owner clears controls once");
    assert.equal(settlements, expected, "each owner settles once");
    assert.equal(recovery.active, false);
    assert.equal(recovery.snapshot()?.phase, phase);
    assert.equal(f.controls.size, 0, "the departing owner's controls are already released");
  };
  return {
    departed,
    track<T>(pending: Promise<T>): Promise<T> {
      return pending.then(value => { settlements++; return value; }, cause => { settlements++; throw cause; });
    },
    check(expected: number, phase: string) {
      departed(expected, phase);
      const cell = recovery.snapshot()?.placement?.cell;
      if (cell) assert.equal(added(blockUpdateEventOf(new Vec3(cell.x, cell.y, cell.z))), 0, "destination block updates released");
      for (const event of new Set([...botEvents, ...f.bot.eventNames().map(String)])) assert.equal(added(event), 0, event);
      for (const event of new Set([...clientEvents, ...f.bot._client.eventNames().map(String)])) assert.equal(clientAdded(event), 0, event);
    },
  };
}

test("an edge alone, another entity's impulse, and an impulse over wide safe ground all leave movement alone", async () => {
  for (const row of [
    { name: "standing on an edge, with someone else's impulse", wide: false, entityId: 2 },
    { name: "a native impulse over wide safe ground", wide: true, entityId: 1 },
  ]) {
    const fixtureBot = fixture(row.wide);
    using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
    await fixtureBot.clock.advance(50);
    fixtureBot.impulse(row.entityId);
    assert.equal(recovery.needed, false, row.name);
    assert.equal(fixtureBot.controls.size, 0, row.name);
  }
});

test("an idle edge hit retains the departure support after the bot becomes airborne", async () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  fixtureBot.entity.onGround = false;
  fixtureBot.entity.position.x = 1.2;
  await fixtureBot.clock.advance(50);
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
  assert.equal(fixtureBot.controls.size, 0, "observation never drives before a body owner calls recover");
});

test("mounting clears a pending land impulse", async () => {
  const f = fixture(false, undefined, { entities: { 7: { name: "oak_boat", position: new Vec3(0.8, 47, 0.5) } } });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  assert.equal(recovery.needed, true);
  f.bot.mount(f.bot.entities[7]!);
  await f.clock.advance(50);
  assert.ok(f.bot.vehicle);
  assert.equal(recovery.needed, false, "the old land impulse must not survive mounting");
});

test("a support learned before a mount does not survive the mount and dismount, so a land impulse before the next grounded tick starts no recovery", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture(false, clock, { entities: { 7: { name: "oak_boat", position: new Vec3(0.8, 47, 0.5) } } });
  using recovery = new FootingRecovery(f.bot, f.world);
  await clock.advance(50); // a grounded tick on the edge learns the support at (0, 47, 0)
  f.bot.mount(f.bot.entities[7]!);
  await clock.advance(50);
  assert.ok(f.bot.vehicle);
  f.entity.position.set(1.2, 47, 0.5); // carried off the edge by the boat, airborne: no grounded tick observes it
  f.entity.onGround = false;
  await clock.advance(50);
  forgetVehicle(f.bot);
  assert.equal(f.bot.vehicle, null);
  f.impulse();
  assert.equal(recovery.needed, false, "the pre-mount support is reset by the mount and dismount listeners: no land recovery");
  assert.equal(recovery.snapshot(), null);
  f.entity.position.set(0.8, 47, 0.5);
  f.entity.onGround = true;
  f.bot.emit("physicsTick");
  f.impulse();
  assert.equal(recovery.needed, true, "a grounded tick on the edge learns a fresh support, so the next impulse is recovered");
  assert.equal(recovery.snapshot()?.phase, "pending");
});

test("after seated combat the next navigate is not interrupted by old footing", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture(false, clock, { groundY: 46, entities: { 7: { name: "oak_boat", position: new Vec3(0.8, 47, 0.5) } } });
  using recovery = new FootingRecovery(f.bot, f.world);
  const runner = new ActionRunner({ clock: f.clock });
  await using driver = new ReflexDriver(f.bot, runner, { now: f.clock.now });
  let fighting = true;
  let released = false;
  const reflex = attachFootingReflex(driver, { activeEngagement: () => fighting ? {} as never : null }, recovery, () => { released = true; });
  try {
    f.bot.mount(f.bot.entities[7]!);
    await f.clock.advance(50);
    f.entity.position.set(0.8, 47, 0.5);
    f.impulse();
    assert.equal(recovery.needed, false, "a seated hit must not queue land recovery");
    fighting = false;
    forgetVehicle(f.bot);
    resumePhysics(f.bot);
    const navigation = { cancel: () => {}, onEvent: () => () => {} } as unknown as NavigationRuntime;
    const action = createNavigateAction(f.bot, navigation, {
      createMovements: (() => ({})) as never,
      navigate: async ({ signal }) => {
        await f.clock.sleep(100);
        signal?.throwIfAborted();
        f.entity.position.set(2.5, 47, 0.5);
        return { status: "completed", elapsedMs: 100 };
      },
    });
    const pending = runner.run(action, { x: 2, y: 47, z: 0, range: 0 });
    await f.clock.advance(50);
    assert.equal(released, false, "Footing recovery is taking control of the airborne body");
    const result = await f.clock.settle(pending, 10_000);
    assert.equal(result.result.status, "succeeded", JSON.stringify(result.result));
  } finally {
    await reflex[Symbol.asyncDispose]();
  }
});

test("mount interrupts active recovery, releases controls and allows a fresh recovery", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture(false, clock, { entities: { 7: { name: "oak_boat", position: new Vec3(0.8, 47, 0.5) } } });
  const added = listenersAddedSince(f.bot);
  const clientAdded = listenersAddedSince(f.bot._client);
  const recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  const pending = recovery.recover(new AbortController().signal);
  pending.catch(() => {});
  assert.equal(recovery.active, true);
  f.bot.mount(f.bot.entities[7]!);
  await clock.advance(50);
  await assert.rejects(clock.settle(pending, 1_000), /vehicle context changed/);
  assert.equal(recovery.active, false);
  assert.equal(f.controls.size, 0);
  assert.equal(recovery.needed, false, "a vehicle change cannot reopen land recovery");
  forgetVehicle(f.bot);
  resumePhysics(f.bot);
  f.entity.position.set(0.8, 47, 0.5);
  f.entity.onGround = true;
  f.bot.emit("physicsTick");
  f.impulse();
  const next = recovery.recover(new AbortController().signal);
  await clock.advance(50);
  assert.equal(await next, "landed");
  recovery[Symbol.dispose]();
  for (const event of ["mount", "dismount", "physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
  assert.equal(clientAdded("entity_velocity"), 0);
  await clock.advance(31_000);
  assert.equal(f.controls.size, 0);
});

test("mount interrupts an active water landing", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture(true, clock, { carried: { water_bucket: 1 }, entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 51, 0.5) } } });
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++)
    for (let y = 50; y <= 53; y++) f.world.load({ x, y, z }, { stateId: 0 });
  f.entity.position.set(0.5, 51, 0.5);
  f.entity.velocity.set(0, -1, 0);
  f.entity.onGround = false;
  using recovery = new FootingRecovery(f.bot, f.world);
  assert.equal(recovery.bucketNeeded, true);
  const pending = recovery.recover(new AbortController().signal);
  pending.catch(() => {});
  assert.equal(recovery.active, true);
  f.bot.mount(f.bot.entities[7]!);
  await clock.advance(50);
  await assert.rejects(clock.settle(pending, 1_000), /vehicle context changed/);
  assert.equal(recovery.active, false);
  assert.equal(waterLandingActive(f.bot), false);
  forgetVehicle(f.bot);
  resumePhysics(f.bot);
  for (let x = 1; x <= 5; x++) for (let z = -3; z <= 3; z++) f.world.load({ x, y: 46, z }, { stateId: 0 });
  f.entity.position.set(0.5, 47, 0.5);
  f.entity.velocity.set(0, 0, 0);
  f.entity.onGround = true;
  f.bot.emit("physicsTick");
  f.entity.position.x = 0.8;
  f.impulse();
  const next = recovery.recover(new AbortController().signal);
  await clock.advance(50);
  assert.equal(await next, "landed");
  await clock.advance(31_000);
  assert.equal(f.controls.size, 0);
});

test("missing catching geometry reports failure and releases movement instead of claiming a landing", async () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  fixtureBot.onEachTick(() => {
    fixtureBot.entity.position.y = 46.9;
    fixtureBot.entity.onGround = false;
  });
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(fixtureBot.clock, recovered);
  assert.equal(await recovered, "failed");
  assert.equal(recovery.snapshot()?.phase, "failed");
  assert.equal(recovery.active, false);
  assert.equal(fixtureBot.controls.size, 0);
});

test("a cancel ends the first wait for a tick at once when physics has stopped, not at Mineflayer's 5 s tick timeout", async () => {
  const f = fixture();
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.bot.physicsEnabled = false; // a death turns physics off (`physics.js:480`)
  const abort = new AbortController();
  f.clock.after(100, () => abort.abort(new Error("bot died")));
  await assert.rejects(f.clock.settle(recovery.recover(abort.signal), 1_000), /bot died/);
  assert.equal(f.controls.size, 0);
});

test("a cancel ends the wait inside the steering loop at once when physics stops after the first tick", async () => {
  const f = fixture();
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  let ticks = 0;
  f.onEachTick(() => {
    ticks++;
    f.entity.position.y = 48; // above the support, in the air, nothing to place: the loop only waits for the next tick
    f.entity.onGround = false;
    if (ticks === 1) f.bot.physicsEnabled = false;
  });
  const abort = new AbortController();
  f.clock.after(200, () => abort.abort(new Error("bot died")));
  await assert.rejects(f.clock.settle(recovery.recover(abort.signal), 1_000), /bot died/);
  assert.equal(ticks, 1, "the loop was waiting on its second tick, not past it");
  assert.equal(f.controls.size, 0);
});

test("recover on a never-safe support inside a fight returns failed after 30 s", async () => {
  const mocked = createFakeClock({ mode: "mocked" });
  using _installed = mocked.install();
  const f = fixture(false, mocked);
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  // Above the support and in the air, nothing to place: the loop only waits for the next tick, as a fight's recover does.
  f.onEachTick(() => {
    f.entity.position.y = 48;
    f.entity.onGround = false;
  });
  let protectCalls = 0;
  const recovered = recovery.recover(new AbortController().signal, async () => { protectCalls++; });
  const settled = watch(recovered);
  let slices = 0;
  while (!settled.over && slices < 800) {
    await mocked.advance(50);
    slices++;
  }
  assert.equal(await recovered, "failed");
  assert.ok(slices >= 590 && slices <= 620, `failed after ${slices * 50} ms of clock, not at the 30 s bound`);
  assert.match(recovery.snapshot()?.reason ?? "", /footing not recovered in 30 s/);
  assert.equal(recovery.snapshot()?.phase, "failed");
  assert.ok(protectCalls > 100, "the fight's protection ran each tick until the bound");
  assert.equal(f.controls.size, 0);
  assert.equal(recovery.active, false);
});

test("an observed lower terrace preserves protection and resumes only after actual landing", async () => {
  const f = fixture();
  f.world.load({ x: 1, y: 45, z: 0 }, { stateId: 1 });
  f.world.load({ x: 1, y: 44, z: 0 }, { stateId: 1 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.entity.position.x = 1.5;
  f.entity.position.y = 51;
  await f.clock.advance(50);
  let ticks = 0;
  let protection = 0;
  f.bot.deactivateItem = () => assert.fail("landing must not reset its continuing combat owner's shield readiness");
  f.onEachTick(() => {
    ticks++;
    f.entity.position.y = ticks === 1 ? 46.9 : 46;
    f.entity.onGround = ticks > 1;
  });
  const recovered = recovery.recover(new AbortController().signal, async () => { protection++; });
  await ticksUntilSettled(f.clock, recovered);
  assert.equal(await recovered, "landed");
  assert.ok(protection >= 2);
  assert.equal(ticks, 2, "a predicted landing alone must not resume the request");
  assert.equal(f.controls.size, 0);
});

/** The footing block's cell (1, 46, 0) lies in a region of Tom; the floor ends at x 0, the impulse carries the body past it. */
async function footingBlockInForeignRegion() {
  const clock = createFakeClock({ mode: "mocked" });
  const f = fixture(false, clock, {
    username: "Ayla", gameMode: "creative", carried: { cobblestone: 8 }, cells: { [cellKey(new Vec3(0, 46, 0))]: "stone" },
  });
  setProtectedRegionsProvider(f.bot, () => [
    { regionId: 6, dimension: "overworld", min: { x: 1, y: 40, z: -3 }, max: { x: 3, y: 60, z: 3 }, owner: "Tom", label: "a build" },
  ]);
  using _timers = clock.install();
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.entity.position = new Vec3(0.8, 47.5, 0.5);
  f.entity.velocity = new Vec3(0.3, 0, 0);
  f.entity.onGround = false;
  const placed = () => f.server.packets.some((packet) => packet.name === "block_place");
  f.onEachTick(() => {
    if (!placed()) return;
    // The server has the block: the floor is there and the body stands on it.
    f.world.load({ x: 1, y: 46, z: 0 }, { stateId: 1 });
    f.entity.position = new Vec3(1.5, 47, 0.5);
    f.entity.velocity = new Vec3(0, 0, 0);
    f.entity.onGround = true;
  });
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(f.clock, recovered, 60);
  return { outcome: await recovered, placed: placed(), ledger: pendingLifeSavingPlacements(f.bot) };
}

test("a footing block in a foreign region is placed and recorded", async () => {
  const result = await footingBlockInForeignRegion();
  assert.equal(result.outcome, "landed");
  assert.equal(result.placed, true, "the reflex does not wait for a region's leave");
  assert.deepEqual(
    result.ledger.map(({ cell, block, regionId, kind }) => ({ cell: cell.toString(), block, regionId, kind })),
    [{ cell: new Vec3(1, 46, 0).toString(), block: "cobblestone", regionId: 6, kind: "block" }],
  );
});

test("a blast-broken floor can steer onto the adjacent lower cell before releasing the request", async () => {
  const f = fixture();
  for (let y = 44; y <= 46; y++) f.world.load({ x: 1, y, z: 0 }, { stateId: y === 45 ? 1 : 0 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.world.load({ x: 0, y: 46, z: 0 }, { stateId: 0 });
  f.entity.position = new Vec3(0.85, 46.9, 0.5);
  f.entity.velocity = new Vec3(0.04, -0.23, 0);
  f.entity.onGround = false;
  let ticks = 0;
  f.onEachTick(() => {
    ticks++;
    if (ticks === 2) {
      assert.equal(recovery.snapshot()?.phase, "steering", "the projected edge is not a terminal failure");
      f.entity.position = new Vec3(1.5, 46, 0.5);
      f.entity.velocity = new Vec3(0, 0, 0);
      f.entity.onGround = true;
    }
  });
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(f.clock, recovered);
  assert.equal(await recovered, "landed");
  assert.equal(ticks, 2);
});

test("a grounded body overlapping lava retains its last safe scaffold for the next impulse", async () => {
  const fixtureBot = fixture();
  fixtureBot.entity.position.x = 0.5;
  fixtureBot.world.load({ x: 1, y: 46, z: 0 }, { stateId: 0, traits: { liquid: "lava", damaging: true } });
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.entity.position.x = 0.95;
  await fixtureBot.clock.advance(50);
  fixtureBot.impulse();
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
});

for (const rate of [20, 10]) {
  test(`footprint catch uses strict overlap on both axes and signs at ${rate} tps`, async () => {
    for (const axis of ["x", "z"] as const) for (const sign of [1, -1]) for (const overlap of [0, 0.001]) {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const f = catchingFixture(clock, rate);
      using recovery = new FootingRecovery(f.bot, f.world);
      f.impulse();
      f.gameWorld.setCell(new Vec3(0, 46, 0), "air");
      f.world.load({ x: 0, y: 46, z: 0 }, { stateId: 0 });
      const support = new Vec3(0, 46, 0);
      support[axis] = sign > 0 ? 1 : -2;
      f.gameWorld.setCell(support, "stone");
      f.world.load(support, { stateId: 1 });
      let ticks = 0;
      f.onEachTick(() => {
        f.entity.position.set(0.5, 47.5, 0.5);
        f.entity.position[axis] = sign * (0.7 + overlap);
        f.entity.velocity.set(0, 0, 0);
        f.entity.onGround = ++ticks >= 8;
        if (f.entity.onGround) f.entity.position.set(support.x + 0.5, 47, support.z + 0.5);
      });
      assert.equal(await clock.settle(recovery.recover(new AbortController().signal), 5_000), "landed");
      const placed = f.server.packets.filter(packet => packet.name === "block_place");
      assert.equal(placed.length, overlap === 0 ? 1 : 0, `${axis}, sign ${sign}, overlap ${overlap}`);
    }
  });

  test(`a nearest footprint column outside reach is skipped for a reachable neighbour at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = catchingFixture(clock, rate);
    using recovery = new FootingRecovery(f.bot, f.world);
    f.impulse();
    f.world.load({ x: 0, y: 46, z: 0 }, { stateId: 0 });
    f.gameWorld.setCell(new Vec3(0, 46, 0), "air");
    f.gameWorld.setCell(new Vec3(1, 45, 1), "stone");
    f.gameWorld.setCell(new Vec3(0, 46, 2), "stone");
    f.onEachTick(() => {
      const landed = f.answers.some(answer => answer.cell === "0,46,1");
      f.entity.position.set(landed ? 0.5 : 1.05, landed ? 47 : 49, 1.05);
      f.entity.velocity.set(0, 0, 0);
      f.entity.onGround = landed;
    });
    assert.equal(await clock.settle(recovery.recover(new AbortController().signal), 5_000), "landed");
    assert.deepEqual(recovery.snapshot()?.placement?.cell, { x: 0, y: 46, z: 1 });
    assert.equal(f.bot.blockAt(new Vec3(1, 46, 1))?.name, "air");
  });

  test(`an attempted catching cell is not tried again after a refused answer at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = catchingFixture(clock, rate);
    using recovery = new FootingRecovery(f.bot, f.world);
    f.impulse();
    let requests = 0;
    let refused = false;
    f.server.onPacket("block_place", () => {
      requests++;
      f.gameWorld.setCell(new Vec3(1, 46, 0), "stone");
    });
    f.onEachTick(() => {
      refused ||= recovery.snapshot()?.placement?.result === "failed";
      if (refused) f.gameWorld.setCell(new Vec3(1, 46, 0), "air");
      f.entity.position.set(0.8, refused && clock.now() > 10_000 ? 43 : 47.5, 0.5);
      f.entity.velocity.set(0.3, 0, 0);
      f.entity.onGround = false;
    });
    assert.equal(await clock.settle(recovery.recover(new AbortController().signal), 40_000), "failed");
    assert.equal(refused, true);
    assert.equal(requests, 1);
  });

  test(`a diagonal drift past the first catching cell places the footprint's attachable cell at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = catchingFixture(clock, rate);
    using recovery = new FootingRecovery(f.bot, f.world);
    f.impulse();
    let tick = 0;
    const requests: { cell: string; tick: number; feetY: number; at: number; age: number }[] = [];
    f.server.onPacket("block_place", () => {
      const cell = recovery.snapshot()!.placement!.cell;
      requests.push({ cell: cellKey(cell), tick, feetY: f.entity.position.y, at: clock.now(), age: f.server.gameTime });
      assert.equal(f.answers.some(answer => answer.cell === cellKey(cell)), false, "no credit before the server answer");
      assert.equal(recovery.snapshot()?.placement?.result, "pending");
    });
    f.onEachTick(() => {
      const [position, velocity] = cornerFlight[Math.min(tick++, cornerFlight.length - 1)]!;
      f.entity.position.set(position[0] + 3, position[1] - 53, position[2] + 6);
      f.entity.velocity.set(velocity[0], velocity[1], velocity[2]);
      f.entity.onGround = false;
      if (tick >= cornerFlight.length - 1 && f.bot.blockAt(new Vec3(0, 46, -2))?.name === "cobblestone") {
        f.entity.position.set(0.5, 47, -1.5);
        f.entity.velocity.set(0, 0, 0);
        f.entity.onGround = true;
      }
    });
    const outcome = await clock.settle(recovery.recover(new AbortController().signal), 40_000);
    assert.deepEqual(requests.map(request => request.cell), ["0,46,-1", "0,46,-2"], `outcome ${outcome}`);
    assert.ok(requests[1]!.tick < cornerFlight.length && requests[1]!.feetY >= 47);
    for (const request of requests) {
      const answer = f.answers.find(answer => answer.cell === request.cell)!;
      assert.equal(answer.at, request.at + 1000 / rate, `answer time at ${rate} tps`);
      assert.equal(answer.age, 24_000 + Math.floor(answer.at * rate / 1000), "answer's authoritative world age");
      assert.ok(answer.age > request.age);
    }
    assert.equal(outcome, "landed");
  });

  test(`a straight flight places the same first cell at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = catchingFixture(clock, rate);
    using recovery = new FootingRecovery(f.bot, f.world);
    f.impulse();
    f.onEachTick(() => {
      const landed = f.answers.some(answer => answer.cell === "1,46,0");
      f.entity.position.set(landed ? 1.5 : 0.8, landed ? 47 : 47.5, 0.5);
      f.entity.velocity.set(landed ? 0 : 0.3, 0, 0);
      f.entity.onGround = landed;
    });
    assert.equal(await clock.settle(recovery.recover(new AbortController().signal), 5_000), "landed");
    assert.equal(f.answers.find(answer => answer.cell !== "0,46,0")?.cell, "1,46,0");
  });

  for (const stage of ["steering", "placing"] as const) {
    test(`a recovery aborted by its parent during ${stage} reopens its obligation at ${rate} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const f = catchingFixture(clock, rate);
      const added = listenersAddedSince(f.bot);
      const clientAdded = listenersAddedSince(f.bot._client);
      using recovery = new FootingRecovery(f.bot, f.world);
      const scope = recoveryScope(f, recovery);
      f.impulse();
      const initial = recovery.snapshot()!;
      const abort = new AbortController();
      f.onEachTick(() => {
        f.entity.position.set(0.8, 47.5, 0.5);
        f.entity.velocity.set(0.3, 0, 0);
        f.entity.onGround = false;
        if (stage === "steering" && recovery.snapshot()?.placement?.result === "placed") abort.abort(new Error("fire takes the body"));
      });
      f.server.onPacket("block_place", () => { if (stage === "placing") abort.abort(new Error("fire takes the body")); });
      await assert.rejects(clock.settle(scope.track(recovery.recover(abort.signal)), 5_000), /fire takes the body/);
      scope.departed(1, "pending");
      assert.equal(recovery.snapshot()?.phase, "pending");
      assert.equal(recovery.needed, true);
      assert.deepEqual(recovery.snapshot()?.support, initial.support);
      assert.deepEqual(recovery.snapshot()?.impulse, initial.impulse);
      assert.equal(recovery.snapshot()?.startedAt, initial.startedAt);
      const placement = recovery.snapshot()?.placement;
      if (stage === "placing") {
        assert.deepEqual(placement?.cell, { x: 1, y: 46, z: 0 });
        assert.equal(placement?.result, "pending");
        assert.equal(f.bot.blockAt(new Vec3(1, 46, 0))?.name, "air");
        await clock.settle(new Promise<void>(resolve => { f.bot._client.once("block_change", () => resolve()); }), 5_000);
        assert.equal(f.bot.blockAt(new Vec3(1, 46, 0))?.name, "cobblestone", "the late answer survives the former owner");
      }
      scope.check(1, "pending");
      const reopened = recovery.snapshot();
      await clock.advance(31_000);
      scope.check(1, "pending");
      assert.deepEqual(recovery.snapshot(), reopened, "the former deadline cannot settle or rewrite the pending obligation");
      f.onEachTick(() => {
        if (stage === "placing" && f.bot.blockAt(new Vec3(1, 46, 0))?.name !== "cobblestone") return;
        f.entity.position.set(stage === "placing" ? 1.5 : 0.5, 47, 0.5);
        f.entity.velocity.set(0, 0, 0);
        f.entity.onGround = true;
      });
      assert.equal(await clock.settle(scope.track(recovery.recover(new AbortController().signal)), 5_000), "landed");
      scope.check(2, "landed");
      assert.deepEqual(recovery.snapshot()?.placement, placement);
      assert.equal(recovery.needed, false);
      await clock.advance(31_000);
      scope.check(2, "landed");
      recovery[Symbol.dispose]();
      for (const event of ["physicsTick", "mount", "dismount", "respawn", "death"]) assert.equal(added(event), 0, event);
      for (const event of ["entity_velocity", "block_change", "end", "acknowledge_player_digging"]) assert.equal(clientAdded(event), 0, event);
    });
  }

  test(`a stopped server during the second catching placement fails and releases its scope at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = catchingFixture(clock, rate);
    const added = listenersAddedSince(f.bot);
    const clientAdded = listenersAddedSince(f.bot._client);
    const recovery = new FootingRecovery(f.bot, f.world);
    f.impulse();
    let tick = 0;
    let stoppedAge = 0;
    let clears = 0;
    const clear = f.bot.clearControlStates;
    f.bot.clearControlStates = () => { clears++; clear(); };
    f.server.onPacket("block_place", () => {
      if (recovery.snapshot()?.placement?.cell.z !== -2) return;
      stoppedAge = f.server.gameTime;
      f.server.stop();
    });
    f.onEachTick(() => {
      const [position, velocity] = cornerFlight[Math.min(tick++, 1)]!;
      f.entity.position.set(position[0] + 3, position[1] - 53, position[2] + 6);
      f.entity.velocity.set(velocity[0], velocity[1], velocity[2]);
      f.entity.onGround = false;
    });
    assert.equal(await clock.settle(recovery.recover(new AbortController().signal), 40_000), "failed");
    assert.ok(clock.now() > 30_000);
    assert.match(recovery.snapshot()?.reason ?? "", /footing not recovered in 30 s/);
    assert.equal(f.server.gameTime, stoppedAge);
    assert.equal(f.bot.blockAt(new Vec3(0, 46, -2))?.name, "air");
    assert.equal(clears, 1);
    assert.equal(f.controls.size, 0);
    recovery[Symbol.dispose]();
    await clock.advance(31_000);
    for (const event of ["physicsTick", "mount", "dismount", "respawn", "death"]) assert.equal(added(event), 0, event);
    for (const event of ["entity_velocity", "block_change", "end", "acknowledge_player_digging"]) assert.equal(clientAdded(event), 0, event);
    assert.equal(clears, 1);
  });
}

test("ground, fluids, death and respawn do not reopen a cancelled recovery", async () => {
  for (const rate of [20, 10]) for (const exit of ["ground", "water", "lava", "death", "respawn"] as const) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = fixture(false, clock, { server: { ticksPerSecond: rate } });
    const added = listenersAddedSince(f.bot);
    const clientAdded = listenersAddedSince(f.bot._client);
    using recovery = new FootingRecovery(f.bot, f.world);
    const scope = recoveryScope(f, recovery);
    f.impulse();
    f.entity.onGround = false;
    const abort = new AbortController();
    const pending = scope.track(recovery.recover(abort.signal));
    if (exit === "death" || exit === "respawn") f.onEachTick(() => f.bot.emit(exit));
    else {
      if (exit === "ground") f.entity.onGround = true;
      else Reflect.set(f.entity, exit === "water" ? "isInWater" : "isInLava", true);
      abort.abort(new Error(exit));
    }
    await assert.rejects(clock.settle(pending, 1_000));
    scope.check(1, "cancelled");
    assert.equal(recovery.needed, false, exit);
    await clock.advance(31_000);
    scope.check(1, "cancelled");
    recovery[Symbol.dispose]();
    for (const event of ["physicsTick", "mount", "dismount", "respawn", "death"]) assert.equal(added(event), 0, event);
    assert.equal(clientAdded("entity_velocity"), 0);
  }
});

test("a preempted lower landing retains its current support even when cleanup throws", async () => {
  for (const rate of [20, 10]) for (const cleanupThrows of [false, true]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = fixture(false, clock, { server: { ticksPerSecond: rate } });
    f.world.load({ x: 1, y: 45, z: 0 }, { stateId: 1 });
    using recovery = new FootingRecovery(f.bot, f.world);
    const scope = recoveryScope(f, recovery, cleanupThrows);
    f.impulse();
    const abort = new AbortController();
    let ticks = 0;
    f.onEachTick(() => {
      f.entity.position.set(1.5, 46.9, 0.5);
      f.entity.velocity.set(0, 0, 0);
      f.entity.onGround = false;
      if (++ticks === 2) abort.abort(new Error("next owner"));
    });
    await assert.rejects(clock.settle(scope.track(recovery.recover(abort.signal)), 1_000), cleanupThrows ? /cleanup failed/ : /next owner/);
    scope.check(1, "pending");
    assert.equal(recovery.needed, true);
    assert.deepEqual(recovery.snapshot()?.support, { x: 1, y: 46, z: 0 });
    await clock.advance(31_000);
    scope.check(1, "pending");
    f.onEachTick(() => { f.entity.position.y = 46; f.entity.onGround = true; });
    assert.equal(await clock.settle(scope.track(recovery.recover(new AbortController().signal)), 1_000), "landed");
    scope.check(2, "landed");
    await clock.advance(31_000);
    scope.check(2, "landed");
  }
});
