import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { type FakeCell, type FakeClock, type FakeEntitySpec, createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { isInLava } from "../perception/body.js";
import { escapeFire, lavaStepCells, type FireEscapeOutcome } from "./fire.js";
import { buildLavaEscapeStep } from "./fire.js";
import { pendingLifeSavingPlacements } from "../../world/life-saving-placements.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { ticksOnTime } from "../../world/world-age.js";

test("lava contact includes the shallow body overlap missed by the swimming flag", () => {
  const lavaCell = new Vec3(1, 63, 0);
  const { bot, world } = createFakeBot({ position: new Vec3(0.761841334797, 63.875, 0.5), cells: { "1,63,0": "lava" }, groundY: null });
  const setLevel = (level: number | string) => world.setCell(lavaCell, { name: "lava", properties: { level } });
  assert.equal(isInLava(bot), true);
  bot.entity.position.x = 0.69;
  assert.equal(isInLava(bot), false, "beside lava without body overlap is safe");
  bot.entity.position.x = 0.76;
  bot.entity.position.y = 63.95;
  assert.equal(isInLava(bot), false, "above the source surface is safe");
  bot.entity.position.y = 63.875;
  setLevel(7);
  assert.equal(isInLava(bot), false, "a low flowing layer does not fill the whole cell");
  setLevel("7");
  assert.equal(isInLava(bot), false, "Prismarine string levels retain the same shallow surface");
  setLevel("8");
  assert.equal(isInLava(bot), true, "a falling stream fills back up to source height");
});

/** Lava at `level` (a flowed layer below 8). */
const lavaAt = (level: number): FakeCell => ({ name: "lava", properties: { level } });

/**
 * A burning body at `position` on a stone floor to y 64, with `cells` on it, and a navigation world observed from the
 * same cells. The default is the lava-escape-to-water scene: a one-cell lava pit at (0,64,0), water at (2,64,0), the
 * body on the west bank.
 */
function burningScene(
  options: {
    cells?: Record<string, FakeCell>;
    position?: Vec3;
    entities?: Record<number, FakeEntitySpec>;
    clock?: FakeClock;
    carried?: Record<string, number>;
    simulatePhysics?: boolean;
    ticksPerSecond?: number;
  } = {},
) {
  const harness = createFakeBot({
    position: options.position ?? new Vec3(-0.5, 65, 0.5),
    cells: options.cells ?? { "0,64,0": "lava", "2,64,0": "water" },
    groundY: 64,
    entities: options.entities,
    clock: options.clock,
    carried: options.carried,
    simulatePhysics: options.simulatePhysics,
    server: { ticksPerSecond: options.ticksPerSecond ?? 20 },
  });
  const { bot } = harness;
  const controls = bot.controlState;
  const cleared = { count: 0 };
  const clear = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => {
    cleared.count++;
    clear();
  };
  setBurning(bot, true);
  const world = new MemoryWorld();
  const load = (x: number, y: number, z: number) => {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  };
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 62; y <= 68; y++) load(x, y, z);
  /** Change a cell for the bot and for the navigation world that observed it. */
  const setCell = (x: number, y: number, z: number, cell: FakeCell) => {
    harness.world.setCell(new Vec3(x, y, z), cell);
    load(x, y, z);
  };
  bot.on("blockUpdate", (_before, after) => {
    if (after) load(after.position.x, after.position.y, after.position.z);
  });
  /** Client ticks one at a time, letting the escape's waits settle between them. */
  const physicsTicks = (count: number) => harness.clock.advance(50 * count);
  return { bot, clock: harness.clock, server: harness.server, world, controls, cleared, setCell, physicsTicks };
}

const burningOnTheBank = (position?: Vec3) => burningScene({ position });

/** The shared_flags metadata bit 0 the fire checks read as burning, at the version's index. */
function setBurning(bot: ReturnType<typeof createFakeBot>["bot"], burning: boolean): void {
  Reflect.set(bot.entity.metadata, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags"), burning ? 1 : 0);
}

function watch(promise: Promise<FireEscapeOutcome>) {
  const seen: { outcome: FireEscapeOutcome | null } = { outcome: null };
  void promise.then((outcome) => (seen.outcome = outcome));
  return seen;
}

const anyMoveControl = (controls: Readonly<Record<"forward" | "back" | "left" | "right", boolean>>) =>
  (["forward", "back", "left", "right"] as const).some((control) => controls[control]);

/** A scripted body, not simulated flight: the recorded incident supplies its physics positions. */
function landingScene(ticksPerSecond: number, carried?: Record<string, number>) {
  const clock = createFakeClock({ mode: "mocked" });
  const scene = burningScene({ clock, ticksPerSecond, cells: {}, carried });
  Object.assign(scene.bot.entity, { onGround: false });
  scene.bot.entity.position.y = 66;
  const record = { recovered: 0, last: null as "landed" | "failed" | "interrupted" | null, airborneTicks: 0 };
  return { ...scene, record };
}

/** Inspect the escape scope before whole-scene teardown can hide a leaked listener or timer. */
function observeLandingRelease(s: ReturnType<typeof landingScene>) {
  const added = listenersAddedSince(s.bot);
  let writes = 0;
  const control = s.bot.setControlState.bind(s.bot);
  s.bot.setControlState = (key, state) => { writes++; control(key, state); };
  return async () => {
    for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
    const before = { writes, cleared: s.cleared.count };
    await s.clock.advance(16_000);
    assert.deepEqual({ writes, cleared: s.cleared.count }, before, "retired escape cannot write controls");
    assert.equal(Object.values(s.controls).some(Boolean), false);
    for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
  };
}

for (const rate of [20, 10]) {
  for (const grounded of [false, true])
    test(`an open footing obligation lands before escape (${grounded ? "edge" : "airborne"}, ${rate} tps)`, async () => {
      const s = landingScene(rate);
      using _timers = s.clock.install();
      s.bot.entity.onGround = grounded;
      let calls = 0;
      let tick = 0;
      s.bot.on("physicsTick", () => { tick++; });
      const footing = {
        needed: true,
        async recover(signal: AbortSignal): Promise<"landed"> {
          calls++;
          assert.equal(anyMoveControl(s.controls), false, "escape has not steered over recovery");
          await waitForPhysicsTicks(s.bot, 2, signal);
          s.bot.entity.onGround = true;
          footing.needed = false;
          return "landed";
        },
      };
      const released = observeLandingRelease(s);
      const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { footing, record: s.record });
      assert.equal(await s.clock.settle(pending, 1_000), "escaped");
      assert.equal(calls, 1, "the open obligation must be landed even on an edge");
      assert.equal(tick, 2);
      assert.deepEqual(s.record, { recovered: 1, last: "landed", airborneTicks: 0 });
      assert.equal(s.cleared.count, 2, "entry and final scope each cleared once");
      await released();
    });

  test(`fire contact cuts landing on that physics tick and lands again after extinguishing (${rate} tps)`, async () => {
    const s = landingScene(rate);
    using _timers = s.clock.install();
    let tick = 0;
    let abortedAt = -1;
    let calls = 0;
    s.bot.on("physicsTick", () => {
      if (++tick === 2) s.setCell(-1, 66, 0, "fire");
    });
    for (const [x, z] of [[-2, 0], [0, 0], [-1, -1], [-1, 1]])
      for (let y = 65; y <= 68; y++) s.setCell(x!, y, z!, "stone");
    const footing = {
      needed: true,
      async recover(signal: AbortSignal): Promise<"landed"> {
        if (++calls === 1) {
          signal.addEventListener("abort", () => { abortedAt = tick; }, { once: true });
          await waitForPhysicsTicks(s.bot, 10, signal);
        }
        await waitForPhysicsTicks(s.bot, 2, signal);
        s.bot.entity.onGround = true;
        s.bot.entity.position.y = 65;
        footing.needed = false;
        return "landed";
      },
    };
    const released = observeLandingRelease(s);
    const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { footing, record: s.record });
    assert.equal(await s.clock.settle(pending, 2_000), "escaped");
    assert.equal(abortedAt, 2);
    assert.equal(s.bot.blockAt(new Vec3(-1, 66, 0))?.name, "air", "contact was extinguished before landing again");
    assert.equal(calls, 2);
    assert.deepEqual(s.record, { recovered: 2, last: "landed", airborneTicks: 0 });
    assert.equal(s.cleared.count, 2);
    await released();
  });

  for (const exit of ["recover throws", "cleanup throws"])
    test(`landing releases the escape when ${exit} (${rate} tps)`, async () => {
      const s = landingScene(rate);
      using _timers = s.clock.install();
      const released = observeLandingRelease(s);
      let releases = 0;
      const failure = new Error(exit);
      const footing = {
        needed: true,
        async recover(signal: AbortSignal): Promise<"landed"> {
          try {
            if (exit === "recover throws") throw failure;
            await waitForPhysicsTicks(s.bot, 1, signal);
            return "landed";
          } finally {
            releases++;
            s.bot.clearControlStates();
            if (exit === "cleanup throws") throw failure;
          }
        },
      };
      const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { footing, record: s.record });
      await s.clock.settle(assert.rejects(pending, failure), 1_000);
      assert.equal(releases, 1);
      assert.equal(s.cleared.count, 3, "entry, recovery release and final scope");
      assert.equal(s.record.last, "interrupted");
      await released();
    });

  test(`the escape clock aborts landing and releases each scope once (${rate} tps)`, async () => {
    const s = landingScene(rate);
    using _timers = s.clock.install();
    const added = listenersAddedSince(s.bot);
    let release = 0;
    let abortedAt = -1;
    const footing = {
      needed: true,
      async recover(signal: AbortSignal): Promise<"landed"> {
        try { await waitForPhysicsTicks(s.bot, 1_000, signal); return "landed"; }
        finally { release++; abortedAt = s.clock.now(); s.bot.clearControlStates(); }
      },
    };
    const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { footing, record: s.record });
    const endMs = rate === 20 ? 16_050 : 32_050;
    await s.clock.advance(endMs - 1);
    assert.equal(abortedAt, -1, "landing still owns the body before the packet deadline");
    await s.clock.advance(1);
    assert.equal(await pending, "timed_out");
    assert.equal(abortedAt, endMs);
    assert.equal(s.bot.time.age, 24_320);
    assert.equal(release, 1);
    assert.equal(s.cleared.count, 3, "entry, recovery release, escape finally");
    for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
    await s.clock.advance(16_000);
    assert.equal(s.cleared.count, 3);
    assert.equal(anyMoveControl(s.controls), false);
  });

  test(`lethal burn lands the obligation before sending a pour (${rate} tps)`, async () => {
    const s = landingScene(rate, { water_bucket: 1 });
    using _timers = s.clock.install();
    let landed = false;
    const pours = () => s.server.packets.filter(p => p.name === "use_item");
    s.server.onPacket("use_item", () => assert.equal(landed, true, "the actual pour packet follows landing"));
    const footing = {
      needed: true,
      async recover(signal: AbortSignal): Promise<"landed"> {
        assert.equal(pours().length, 0);
        await waitForPhysicsTicks(s.bot, 2, signal);
        s.bot.entity.position.y = 65;
        s.bot.entity.onGround = true;
        footing.needed = false;
        landed = true;
        return "landed";
      },
    };
    const released = observeLandingRelease(s);
    const pending = escapeFire(s.bot, s.world, new AbortController().signal, "lethal_burn", { footing, record: s.record });
    assert.equal(await s.clock.settle(pending, 1_000), "escaped");
    assert.equal(pours().length, 1, "the refuge is chosen on the landed body's floor");
    assert.equal(s.bot.blockAt(s.bot.entity.position)?.name, "water");
    assert.equal(s.bot.inventory.items().find(item => item.name === "bucket")?.count, 1);
    await released();
  });

  test(`an airborne body with no route waits four ticks for dry landing (${rate} tps)`, async () => {
    const s = landingScene(rate);
    using _timers = s.clock.install();
    let tick = 0;
    s.bot.on("physicsTick", () => {
      if (++tick === 4) { s.bot.entity.onGround = true; s.bot.entity.position.y = 65; }
    });
    const released = observeLandingRelease(s);
    const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { record: s.record });
    assert.equal(await s.clock.settle(pending, 1_000), "escaped");
    assert.equal(tick, 4);
    assert.equal(s.record.airborneTicks, 4);
    assert.equal(s.record.recovered, 0);
    await released();
  });

  for (const failedLanding of [false, true])
    test(`${failedLanding ? "a failed recovery" : "an airborne fall"} enters the lava path (${rate} tps)`, async () => {
      const s = landingScene(rate);
      using _timers = s.clock.install();
      let tick = 0;
      s.bot.on("physicsTick", () => {
        if (++tick === 2) Object.assign(s.bot.entity, { isInLava: true });
      });
      const footing = failedLanding ? {
        needed: true,
        async recover(signal: AbortSignal): Promise<"failed"> {
          await waitForPhysicsTicks(s.bot, 1, signal);
          footing!.needed = false;
          Object.assign(s.bot.entity, { isInLava: true });
          return "failed";
        },
      } : undefined;
      const released = observeLandingRelease(s);
      const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { maximumTicks: ticksOnTime(300), footing, record: s.record });
      await s.clock.advance(150);
      assert.equal(s.controls.jump, true, "lava swims up instead of declaring the airborne body blocked");
      assert.equal(await s.clock.settle(pending, 4_100), "timed_out");
      if (failedLanding) assert.equal(s.record.last, "failed");
      await released();
    });

  for (const contact of ["fire", "lava"] as const)
    test(`no landing starts in ${contact} (${rate} tps)`, async () => {
      const s = landingScene(rate);
      using _timers = s.clock.install();
      s.bot.entity.position.y = 65;
      s.bot.entity.onGround = true;
      let calls = 0;
      if (contact === "fire") s.setCell(-1, 65, 0, "fire");
      else Object.assign(s.bot.entity, { isInLava: true });
      const footing = {
        needed: true,
        async recover(): Promise<"landed"> { calls++; footing.needed = false; return "landed"; },
      };
      if (contact === "fire") {
        for (const [x, z] of [[-2, 0], [0, 0], [-1, -1], [-1, 1]])
          for (let y = 65; y <= 68; y++) s.setCell(x!, y, z!, "stone");
      }
      const released = observeLandingRelease(s);
      const pending = escapeFire(s.bot, s.world, new AbortController().signal, "contact", { maximumTicks: ticksOnTime(contact === "fire" ? 15_000 : 200), footing, record: s.record });
      if (contact === "fire") {
        assert.equal(await s.clock.settle(pending, 500), "escaped");
        assert.equal(s.bot.blockAt(new Vec3(-1, 65, 0))?.name, "air");
      } else {
        await s.clock.advance(50);
        assert.equal(s.controls.jump, true);
        assert.equal(await s.clock.settle(pending, 4_100), "timed_out");
      }
      // Fire contact may reopen dry landing only after its authoritative removal.
      assert.equal(calls, contact === "fire" ? 1 : 0);
      await released();
    });

  for (const body of ["grounded", "water", "airborne"] as const)
    test(`no-route ${body} boundary (${rate} tps)`, async () => {
      const s = landingScene(rate);
      using _timers = s.clock.install();
      s.bot.entity.onGround = body === "grounded";
      if (body === "water") { Object.assign(s.bot.entity, { isInWater: true }); setBurning(s.bot, false); }
      const released = observeLandingRelease(s);
      const pending = escapeFire(s.bot, s.world, new AbortController().signal, "lethal_burn", { maximumTicks: ticksOnTime(200), record: s.record });
      assert.equal(await s.clock.settle(pending, 4_100), body === "grounded" ? "blocked" : body === "water" ? "escaped" : "timed_out");
      await released();
    });
}

test("a lethal burn walks to water seven blocks away", async () => {
  const { bot, world, controls, physicsTicks } = burningScene({ position: new Vec3(0.5, 65, 0.5), cells: { "7,65,0": "water" } });
  for (let x = -9; x <= 9; x++) for (let z = -9; z <= 9; z++) for (let y = 62; y <= 68; y++) {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  }
  bot.health = 8;
  const seen = watch(escapeFire(bot, world, new AbortController().signal, "lethal_burn"));
  await physicsTicks(3);
  assert.equal(seen.outcome, null);
  assert.equal(anyMoveControl(controls), true);
  bot.entity.position.set(7.5, 65, 0.5);
  await physicsTicks(2);
  assert.equal(seen.outcome, "escaped");
});

test("extinguishing during an unanswered pour releases the body before the receipt deadline", async () => {
  const { bot, world, clock } = burningScene({ cells: {}, carried: { water_bucket: 1 }, clock: createFakeClock({ mode: "mocked" }) });
  using _installed = clock.install();
  let issued = false;
  bot.activateItem = () => { issued = true; };
  const seen = watch(escapeFire(bot, world, new AbortController().signal, "lethal_burn", { maximumTicks: ticksOnTime(300) }));
  await clock.advance(50);
  assert.equal(issued, true);
  assert.equal(seen.outcome, null);
  setBurning(bot, false);
  await clock.advance(100);
  assert.equal(seen.outcome, "escaped");
  assert.equal(anyMoveControl(bot.controlState), false);
});

test("in the Nether the bucket is not poured", async () => {
  const { bot, world } = burningScene({ cells: {}, carried: { water_bucket: 1 } });
  bot.game.dimension = "the_nether";
  let poured = false;
  bot.activateItem = () => { poured = true; };
  await escapeFire(bot, world, new AbortController().signal, "lethal_burn");
  assert.equal(poured, false);
  assert.equal(bot.inventory.items().find(item => item.name === "water_bucket")?.count, 1);
});

test("death mid-pour ends died, controls cleared", async () => {
  const { bot, world, physicsTicks } = burningScene({ cells: {}, carried: { water_bucket: 1 } });
  bot.lookAt = async () => { bot.health = 0; bot.emit("death"); };
  const pending = escapeFire(bot, world, new AbortController().signal, "lethal_burn");
  await physicsTicks(2);
  assert.equal(await pending, "died");
  assert.equal(anyMoveControl(bot.controlState), false);
  assert.equal(bot.inventory.items().find(item => item.name === "water_bucket")?.count, 1);
});

test("an abort between the pour and the step in leaves the controls clear", async () => {
  const { bot, world, physicsTicks } = burningScene({ cells: {}, carried: { water_bucket: 1 } });
  const abort = new AbortController();
  bot.on("blockUpdate", (_before, after) => { if (after?.name === "water") abort.abort(new Error("cancel after pour")); });
  const pending = escapeFire(bot, world, abort.signal, "lethal_burn");
  const result = pending.then(() => null, (error: Error) => error);
  await physicsTicks(3);
  assert.match((await result)?.message ?? "resolved", /cancel after pour/);
  assert.equal(bot.inventory.items().find(item => item.name === "bucket")?.count, 1);
  assert.equal(anyMoveControl(bot.controlState), false);
});

test("fire out before arriving ends the escape", async () => {
  const { bot, world, controls, cleared, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(3);
  assert.equal(seen.outcome, null, "still burning with water in reach: the walk is on");
  assert.equal(anyMoveControl(controls), true, "a move control is set toward the way round");
  const clearedWhileWalking = cleared.count;
  setBurning(bot, false);
  await physicsTicks(2);
  assert.equal(seen.outcome, "escaped", "the flag cleared: ended within 2 ticks");
  assert.equal(anyMoveControl(controls), false);
  assert.ok(cleared.count > clearedWhileWalking, "the controls were cleared at the end");
});

test("water drained mid-route ends the walk", async () => {
  const { world, setCell, bot, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(3);
  assert.equal(seen.outcome, null, "still walking to the water");
  setCell(2, 64, 0, "stone");
  await physicsTicks(3);
  assert.equal(seen.outcome, "escaped", "dry ground and no water left: the same end as with no water");
});

test("a cancel mid-route stops at once", async () => {
  const { bot, world, cleared, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const result = escapeFire(bot, world, escape.signal).then(
    () => "returned",
    (error: unknown) => error,
  );
  await physicsTicks(3);
  const before = cleared.count;
  escape.abort(new Error("cancelled by the test"));
  assert.match(String(await result), /cancelled by the test/);
  assert.ok(cleared.count > before, "the controls are released");
  assert.equal(bot.listenerCount("physicsTick"), 0, "no physics listener is left");
});

test("a stopped route or lava swim ends at the stopped-server bound and releases its scopes", async () => {
 for (const swimming of [false, true]) {
  const { bot, server, world, clock, controls } = burningScene({ clock: createFakeClock({ mode: "mocked" }),
    ...(swimming ? { cells: walledTwoCellPit(), position: IN_THE_PIT } : {}) });
  using _installed = clock.install();
  const added = listenersAddedSince(bot);
  const timers = clock.pendingGlobalTimers();
  bot.physicsEnabled = false;
  server.stop();
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await clock.advance(19_999);
  assert.equal(seen.outcome, null);
  await clock.advance(1);
  const outcome = seen.outcome;
  assert.equal(outcome, "timed_out", "the clock ended it: not the same as a walk with nowhere to go");
  assert.equal(Object.values(controls).some(Boolean), false);
  for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
  assert.equal(clock.pendingGlobalTimers(), timers);
  assert.equal(bot.time.age, 24_000);
  await clock.advance(48_000);
  assert.equal(seen.outcome, "timed_out");
 }
});

test("a death mid-route or lava swim ends died and releases its scopes", async () => {
 for (const rate of [20, 10]) for (const swimming of [false, true]) {
  const { bot, clock, world, physicsTicks, controls } = burningScene({ ticksPerSecond: rate,
    clock: createFakeClock({ mode: "mocked" }), ...(swimming ? { cells: walledTwoCellPit(), position: IN_THE_PIT } : {}) });
  using _timers = clock.install();
  const added = listenersAddedSince(bot);
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(5);
  if (swimming) assert.equal(bot.getControlState("jump"), true, "swimming up with no bank, no step");
  bot.health = 0;
  bot.emit("death");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(seen.outcome, "died");
  assert.equal(Object.values(controls).some(Boolean), false);
  for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
  assert.equal(clock.pendingGlobalTimers(), 0);
  await clock.advance(48_000);
  assert.equal(Object.values(controls).some(Boolean), false);
 }
});

test("a burning bot goes on from cell to cell of the way round the lava", async () => {
  const { bot, world, controls, physicsTicks } = burningOnTheBank();
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  for (const [x, z] of [[-0.5, 1.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]] as const) {
    await physicsTicks(2);
    assert.equal(seen.outcome, null, `still walking before (${x}, ${z})`);
    assert.equal(anyMoveControl(controls), true, "water is reachable and the walk keeps steering");
    bot.entity.position.set(x, 65, z);
  }
  await physicsTicks(2);
  assert.equal(seen.outcome, null, "on the bank beside the water, still burning");
  assert.equal(anyMoveControl(controls), true);
  Object.assign(bot.entity, { isInWater: true });
  bot.entity.position.set(2.5, 64, 0.5);
  setBurning(bot, false);
  await physicsTicks(1);
  assert.equal(seen.outcome, "escaped");
});

test("a burning bot beside lava that can spread into its cell is not escaped there, whatever woke the reflex", async () => {
  for (const reason of ["contact", "advancing_lava"] as const) {
    const { bot, world, controls, physicsTicks } = burningScene({ cells: { "1,65,0": lavaAt(2) }, position: new Vec3(0.5, 65, 0.5) });
    const seen = watch(escapeFire(bot, world, new AbortController().signal, reason));
    await physicsTicks(3);
    assert.equal(seen.outcome, null, `${reason}: beside level 2 lava the escape goes on`);
    assert.equal(anyMoveControl(controls), true, `${reason}: it walks to a cell lava cannot spread into`);
    bot.entity.position.set(0.5, 65, 1.5);
    await physicsTicks(2);
    assert.equal(seen.outcome, "escaped", `${reason}: one cell away from the lava's reach`);
  }
});

test("burning on safe dry ground with no water in reach is escaped at once, whatever woke the reflex", async () => {
  for (const reason of ["contact", "advancing_lava"] as const) {
    const { bot, world, physicsTicks } = burningScene({ cells: {}, position: new Vec3(-4.5, 65, 5.5) });
    const seen = watch(escapeFire(bot, world, new AbortController().signal, reason, { maximumTicks: ticksOnTime(2_000) }));
    await physicsTicks(5);
    assert.equal(seen.outcome, "escaped", `${reason}: not held until the wall clock ends it`);
  }
});

test("a burning bot on an unsafe dry cell with no safe cell in reach is told blocked, not held", async () => {
  const { bot, world, physicsTicks } = burningScene({
    cells: { "1,65,0": lavaAt(2), "-1,65,0": lavaAt(2), "0,65,1": lavaAt(2), "0,65,-1": lavaAt(2) },
    position: new Vec3(0.5, 65, 0.5),
  });
  const seen = watch(escapeFire(bot, world, new AbortController().signal, "advancing_lava", { maximumTicks: ticksOnTime(2_000) }));
  await physicsTicks(3);
  assert.equal(seen.outcome, "blocked", "the four neighbours are lava and the cell is its own: no way on");
});

test("a lava cell beside the body with room above it can take a step, whatever the room is made of", () => {
  const { bot, world } = burningScene({
    cells: { "1,65,0": "lava", "1,66,0": "torch", "-1,65,0": "lava", "-1,66,0": "stone", "0,65,1": "lava", "0,66,1": "lava", "0,65,-1": "stone" },
    position: new Vec3(0.5, 65, 0.5),
  });
  assert.deepEqual(
    lavaStepCells(bot, world).map((cell) => cell.toString()),
    [new Vec3(1, 65, 0).toString()],
    "a torch above is a passable cell, a stone or lava above is not; a stone is no lava cell",
  );
});

test("a lava cell holding a creature takes no step", () => {
  const { bot, world } = burningScene({
    cells: { "1,65,0": "lava" },
    position: new Vec3(0.5, 65, 0.5),
    entities: { 7: { type: "mob", name: "zombie", position: new Vec3(1.5, 65, 0.5), width: 0.6, height: 1.95 } },
  });
  assert.deepEqual(lavaStepCells(bot, world), []);
});

/** A `size` x `size` lava pool (odd `size`) `depth` cells deep, centred on column (0, 0), its top row at y 64: the ground's surface. */
function lavaPool(depth: number, size = 3): Record<string, FakeCell> {
  const reach = (size - 1) / 2;
  const cells: Record<string, FakeCell> = {};
  for (let x = -reach; x <= reach; x++)
    for (let z = -reach; z <= reach; z++) for (let y = 65 - depth; y <= 64; y++) cells[`${x},${y},${z}`] = "lava";
  return cells;
}

/** The body stands on the floor of a 3 x 3 pool two deep: the bank is two cells above its feet. */
const ON_THE_POOL_FLOOR = new Vec3(0.5, 63, 0.5);

test("in a lava pool two deep with no blocks, the escape holds jump and does not return blocked", async () => {
  const { bot, world, controls, physicsTicks } = burningScene({ cells: lavaPool(2), position: ON_THE_POOL_FLOOR });
  assert.equal(isInLava(bot), true);
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(20);
  assert.equal(seen.outcome, null, "a way up exists: the escape is not over");
  assert.equal(bot.getControlState("jump"), true, "jump is held to swim up");
  assert.equal(anyMoveControl(controls), true, "and the body steers toward the bank");
  bot.entity.position.set(0.5, 64.8, 0.5);
  await physicsTicks(2);
  assert.equal(seen.outcome, null, "the surface row is still lava");
  bot.entity.position.set(2.5, 65, 0.5);
  bot.entity.onGround = true;
  await physicsTicks(2);
  assert.equal(seen.outcome, "escaped", "on the bank");
});

/**
 * A one-deep, two-cell pit at (0,64,0) and (1,64,0) walled around (to y 66 by default, `wallHeight` rows from y 65) up to
 * `wallRadius` cells from the pit: no natural bank, one lava cell to step on.
 */
function walledTwoCellPit(wallRadius = 5, wallHeight = 2): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = { "0,64,0": "lava", "1,64,0": "lava" };
  for (let x = -wallRadius; x <= wallRadius; x++)
    for (let z = -wallRadius; z <= wallRadius; z++)
      for (let y = 65; y < 65 + wallHeight; y++) if (!(z === 0 && (x === 0 || x === 1))) cells[`${x},${y},${z}`] = "stone";
  return cells;
}

const IN_THE_PIT = new Vec3(0.5, 64, 0.5);

for (const [rate, endMs] of [[20, 16_050], [10, 32_050]] as const) {
  test(`a walled lava escape gets 300 server ticks (${rate} tps)`, async () => {
    const s = burningScene({ clock: createFakeClock({ mode: "mocked" }), ticksPerSecond: rate,
      cells: walledTwoCellPit(), position: IN_THE_PIT });
    using _timers = s.clock.install();
    const added = listenersAddedSince(s.bot);
    const timers = s.clock.pendingGlobalTimers();
    const age = s.bot.time.age;
    const seen = watch(escapeFire(s.bot, s.world, new AbortController().signal));
    await s.clock.advance(endMs - 1);
    assert.equal(seen.outcome, null, "client ticks must not spend the server budget early");
    assert.equal(s.controls.jump, true);
    await s.clock.advance(1);
    assert.equal(seen.outcome, "timed_out");
    assert.equal(s.bot.time.age - age, 320);
    assert.equal(s.clock.now(), endMs);
    assert.equal(s.cleared.count, 2);
    assert.equal(Object.values(s.controls).some(Boolean), false);
    for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
    assert.equal(s.clock.pendingGlobalTimers(), timers);
    await s.clock.advance(48_000);
    assert.equal(s.cleared.count, 2, "retired budget cannot release the body twice");
  });
}

for (const owner of ["Tom", "own", "none"]) {
  test(`a lava step in ${owner === "Tom" ? "a foreign" : owner} region ${owner === "Tom" ? "is recorded" : "needs no removal"}`, async () => {
    const { bot, clock, world } = burningScene({ cells: walledTwoCellPit(), position: IN_THE_PIT, carried: { cobblestone: 8 } });
    setProtectedRegionsProvider(bot, () => owner === "none" ? [] : [{
      regionId: 7, owner: owner === "own" ? bot.username : owner, label: "pool", dimension: "overworld",
      min: { x: -5, y: 63, z: -5 }, max: { x: 5, y: 70, z: 5 },
    }]);
    const step = await clock.settle(buildLavaEscapeStep(bot, world, new AbortController().signal), 3_000);
    assert.ok(step, "emergency placement is admitted");
    assert.equal(bot.blockAt(step.offset(0, -1, 0).floored())?.name, "cobblestone");
    assert.equal(pendingLifeSavingPlacements(bot).length, owner === "Tom" ? 1 : 0);
  });
}

test("a hop that goes nowhere in lava is dropped after 2 s for a lava step, asked once", async () => {
  // The ledge is one row over the lava top: its feet cell is two above the body's (a hop the scan admits), behind a wall.
  const { bot, world, physicsTicks } = burningScene({ cells: walledTwoCellPit(5, 1), position: IN_THE_PIT, carried: { cobblestone: 8 } });
  const placements = { count: 0 };
  const placeAgainst = (bot as unknown as { _placeBlockWithOptions: (...args: unknown[]) => Promise<void> })._placeBlockWithOptions;
  // Counts the placements through Mineflayer's internal entry point: the fake has no hook that counts `block_place`.
  Reflect.set(bot, "_placeBlockWithOptions", (...args: unknown[]) => {
    placements.count++;
    return placeAgainst.apply(bot, args);
  });
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(30);
  assert.equal(placements.count, 0, "inside the 2 s the body keeps trying the bank");
  await physicsTicks(30);
  assert.equal(placements.count, 1, "past 2 s without closing the distance, one lava step is placed");
  assert.equal(seen.outcome, null, "and the escape goes on");
  assert.equal(bot.getControlState("jump"), true);
});

test("in lava with no bank and no step, the body swims up toward the nearest bank it cannot hop to yet", async () => {
  const { bot, world, controls, physicsTicks } = burningScene({ cells: walledTwoCellPit(3), position: IN_THE_PIT });
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(10);
  assert.equal(seen.outcome, null, "not blocked: the swim up goes on");
  assert.equal(bot.getControlState("jump"), true);
  assert.equal(anyMoveControl(controls), true, "steering toward the bank four cells out, beyond the wall");
});

test("a lava step whose placement gets no answer is not retried from the same cell, and jump stays held", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, server, world, physicsTicks } = burningScene({
    cells: walledTwoCellPit(),
    position: IN_THE_PIT,
    clock,
    carried: { cobblestone: 8 },
  });
  const attempts = { count: 0 };
  // Counts the placements through Mineflayer's internal entry point: the fake has no hook that counts `block_place`.
  const placeAgainst = (bot as unknown as { _placeBlockWithOptions: (...args: unknown[]) => Promise<void> })._placeBlockWithOptions;
  Reflect.set(bot, "_placeBlockWithOptions", (...args: unknown[]) => {
    attempts.count++;
    return placeAgainst.apply(bot, args);
  });
  server.stop(); // the server answers nothing
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(20);
  assert.equal(attempts.count, 1, "the step is tried once");
  assert.equal(bot.getControlState("jump"), true, "jump is held during the wait for the answer");
  await clock.advance(12_000); // the 5 s wait ended with no answer, and the loop came round again
  assert.equal(attempts.count, 1, "no second placement into the same cell from the same body cell and world");
  assert.equal(bot.getControlState("jump"), true, "the body keeps swimming up");
  assert.equal(seen.outcome, null);
  await clock.advance(6_999);
  assert.equal(seen.outcome, null, "the stopped term has not ended yet");
  await clock.advance(1);
  assert.equal(seen.outcome, "timed_out", "the 20 s stopped-server bound ends it");
  assert.equal(bot.getControlState("jump"), false, "controls cleared");
});
