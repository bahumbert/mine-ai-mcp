import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { movementStep } from "../test-support/navigation.js";
import { airSupplyTicks, watchAirHistory } from "../world/air-supply.js";
import { AGE_PACKET_TICKS, serverPacedWallMs } from "../world/world-age.js";
import { Diving } from "./diving.js";
import { FirstDiveAir, provisionalAirAllows } from "./diving-first-air.js";
import { exactBlockGoal } from "./goals/index.js";
import type { NavigateOptions, NavigationResult } from "./navigate.js";
import { createMovementPolicy } from "./movements/policy.js";
import { MemoryWorld } from "./world/memory-world.js";
import { DIVE_RESERVE_TICKS, swimAscent } from "./world/swimming.js";
import { UNLOADED, type WorldView } from "./world/world.js";

// Plan 2026-11-18-scenario-reds-part5-a2 T31c-air: the first air packet of a dive from a dry start. The client's physics can see
// the head wet one tick before the server has received the position and counted the first breath, so for that gap the dive
// has nothing to stop on. These cases run the real `Diving.run` on the shared fake with the server's feet kept apart from the client's.

const RATES = [20, 10] as const;
const DRY = new Vec3(0.5, 60, 0.5);
const WET = new Vec3(5.5, 60, 0.5);
const LOST_CORRIDOR = "Dive lost its verified ascent corridor";

/** A roofed tunnel: an air pocket x -2..0 and water x 1..8 (y 60-61) under a roof (y 62) on a floor (y 59), z 0 only. */
function tunnelScene(ticksPerSecond: number) {
  const harness = createFakeBot({ position: DRY, groundY: null, server: { ticksPerSecond }, clock: createFakeClock({ mode: "mocked" }) });
  const { bot } = harness;
  Object.assign(bot.entity, { onGround: true });
  const cells = new MemoryWorld();
  for (let x = -2; x <= 8; x++) for (let y = 59; y <= 62; y++) {
    const kind = y === 59 || y === 62 ? "stone" : x <= 0 ? "air" : "water";
    cells.load({ x, y, z: 0 }, kind === "stone" ? { stateId: 1 } : kind === "air" ? { stateId: 0 }
      : { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } });
    harness.world.setCell(new Vec3(x, y, 0), kind);
  }
  // The client's view of the world: the cells, until a chunk column leaves (`hideUpTo`) and its cells read as unloaded.
  let hiddenUpTo = -Infinity;
  const world: WorldView = {
    blockAt: (x, y, z) => x <= hiddenUpTo ? UNLOADED : cells.blockAt(x, y, z),
    subscribe: (listener) => cells.subscribe(listener),
    get revision() { return cells.revision; },
  };
  Reflect.set(bot.entity, "metadata", []);
  watchAirHistory(bot);
  const unloadUpTo = (x: number) => { hiddenUpTo = x; bot.emit("chunkColumnUnload", { x: 0, z: 0 } as never); };
  // `bot.time` is the fake server's age, which only moves on. A test that needs the client to read an age that regresses or is
  // no number reads it through this seam, the server's own age untouched, until `setAge(undefined)`.
  let ageRead: number | undefined;
  const time = Object.getOwnPropertyDescriptor(bot, "time")!.get!;
  Object.defineProperty(bot, "time", { get: () => ({ ...time.call(bot), ...(ageRead === undefined ? {} : { age: ageRead }) }), configurable: true });
  const setAge = (age: number | undefined) => { ageRead = age; };
  return { ...harness, world, cells, unloadUpTo, setAge, packetMs: 20_000 / ticksPerSecond, tickMs: 1_000 / ticksPerSecond, left: listenersAddedSince(bot) };
}
type Scene = ReturnType<typeof tunnelScene>;

/** The air metadata the client holds for itself, as `air-supply.ts` reads it. */
function ownAir(scene: Scene): unknown {
  return scene.bot.entity.metadata[scene.bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply")];
}

/** The way up from the wet position, in ticks, as the dive's own stop policy prices it. */
function ascentTicksFromWet(scene: Scene): number {
  return swimAscent((x, y, z) => scene.world.blockAt(x, y, z), WET.floored())!.ticks;
}

interface LegOptions {
  readonly runOptions?: Partial<NavigateOptions>;
  /** The head went under water once before this run: T31a's inference is spent (`air-supply.ts` latches it). */
  readonly priorWet?: boolean;
  /** The answer to the route asked after the first (its number from 2, the request): by default it completes. */
  readonly later?: (number: number, request: NavigateOptions) => NavigationResult | Promise<NavigationResult>;
}

/** A dive whose first route is held open by the test: the scene's bot dry with 300 inferred, the server's feet kept where the client's are. */
async function openLeg(scene: Scene, { runOptions, priorWet = false, later }: LegOptions = {}) {
  scene.bot.emit("login");
  await scene.clock.advance(3 * scene.packetMs);
  if (priorWet) {
    scene.bot.entity.position.set(WET.x, WET.y, WET.z);
    scene.bot.emit("physicsTick");
    scene.bot.entity.position.set(DRY.x, DRY.y, DRY.z);
    assert.equal(airSupplyTicks(scene.bot), null, "a body that was under water once has no inferred air");
  } else assert.equal(airSupplyTicks(scene.bot), 300, "the dry start's full air is inferred");
  scene.server.setServerPosition(scene.bot.entity.id, DRY);
  const following = scene.breath.followServerFeet();
  const diving = new Diving(scene.bot, scene.world);
  let enter: (request: NavigateOptions) => void = () => {};
  let finishLeg: (result: NavigationResult) => void = () => {};
  const entered = new Promise<NavigateOptions>((resolve) => { enter = resolve; });
  const firstRoute = new Promise<NavigationResult>((resolve) => { finishLeg = resolve; });
  const requests: NavigateOptions[] = [];
  const run = diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), ...runOptions }, async (request) => {
    requests.push(request);
    if (requests.length === 1) enter(request);
    return requests.length === 1 ? firstRoute : later ? later(requests.length, request) : { status: "completed", elapsedMs: 0 };
  });
  const request = await scene.clock.settle(entered, 0);
  return { diving, run, request, requests, following,
    finish: (result: NavigationResult = { status: "completed", elapsedMs: 0 }) => finishLeg(result) };
}
type Leg = Awaited<ReturnType<typeof openLeg>>;

/**
 * The route is committed into the tunnel and the client's own physics sees the head under water, before the server heard of the move.
 * `dryMs` is how long the client was dry, with no physics tick, between its last dry read and this one.
 */
async function wetByPrediction(scene: Scene, diving: Diving, dryMs = 0): Promise<void> {
  scene.bot.emit("physicsTick");
  if (dryMs > 0) {
    // The client's physics stands still while the server's age goes on (`bot.physicsEnabled`), so no dry tick refreshes the proof.
    scene.bot.physicsEnabled = false;
    await scene.clock.advance(dryMs);
    scene.bot.physicsEnabled = true;
  }
  diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
  scene.bot.entity.position.set(WET.x, WET.y, WET.z);
  scene.bot.emit("physicsTick");
}

/** The server hears the wet feet and counts its first breath at its next tick. */
async function serverCountsFirstBreath(scene: Scene): Promise<void> {
  scene.server.setServerPosition(scene.bot.entity.id, WET);
  scene.server.sendPosition(WET);
  await scene.clock.advance(scene.tickMs);
}

/**
 * What a finished leg leaves: the run settled (its breathing stop, when it has one, runs on the clock), no listener or timer
 * added, no key held, and a late event past the old deadline starts nothing. `routes` is how many routes the run asked for:
 * 1 when the leg ended the run, more when the ordinary planned stop swam back and went on (null: not asserted).
 */
async function assertNothingLeft(scene: Scene, { run, requests, following }: Pick<Leg, "requests" | "following"> & { readonly run: Promise<unknown> },
  routes: number | null = 1): Promise<void> {
  await scene.clock.settle(run, 120_000);
  following[Symbol.dispose](); // the fake's own respawn listener of the controlled body is not the leg's
  const asked = requests.length;
  await scene.clock.advance(3 * scene.packetMs);
  scene.bot.emit("breath");
  scene.bot.emit("physicsTick");
  assert.equal(requests.length, asked, "a late event after the run settled asks for no route");
  if (routes !== null) assert.equal(asked, routes, "the routes the run asked for");
  for (const event of ["breath", "chunkColumnLoad", "chunkColumnUnload", "death", "respawn", "end", "physicsTick"])
    assert.equal(scene.left(event), 0, `no ${event} listener is left`);
  assert.equal(scene.clock.pendingTimers(), 0, "no timer is left");
  assert.equal(scene.bot.getControlState("jump"), false, "no key is held");
}

for (const rate of RATES) {
  test(`a dive from a dry start is not stopped by the client's wet tick before the server counts its first breath, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, following, finish } = await openLeg(scene);
    using _following = following;
    await wetByPrediction(scene, diving);
    assert.equal(scene.breath.airSupply, 300, "the server has not counted a breath yet");
    assert.equal(ownAir(scene), undefined, "no air packet has reached the client");
    assert.equal(airSupplyTicks(scene.bot), null, "the air stays unknown to everyone else");
    assert.equal(request.stopSignal?.aborted, false, "the leg's stop signal is not fired by the client's own wet tick");
    await serverCountsFirstBreath(scene);
    assert.equal(scene.breath.airSupply, 299, "the server counted the first breath at its next tick");
    assert.equal(ownAir(scene), 299);
    assert.equal(request.stopSignal?.aborted, false, "the real air shows a safe dive");
    finish();
    assert.equal((await run).status, "completed");
  });

  for (const [above, stops] of [[1, false], [0, true]] as const)
    test(`a real air of the way up and the reserve${above ? " plus 1" : ""} filed with the physics off ${stops ? "stops" : "does not stop"} the leg on its packet, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, requests, following, finish } = await openLeg(scene);
      using _following = following;
      await wetByPrediction(scene, diving);
      const floor = ascentTicksFromWet(scene) + DIVE_RESERVE_TICKS;
      scene.breath.setAirSupply(floor + above);
      assert.equal(request.stopSignal?.aborted, stops, `air ${floor + above}, the way up plus the reserve being ${floor}, judged on the packet with no physics tick`);
      if (stops) assert.equal(request.stopSignal?.reason, "Planned breathing stop");
      finish();
      await assertNothingLeft(scene, { run, requests, following }, stops ? null : 1);
    });

  test(`a wet leg with no air packet by the first age packet 40 ticks on stops, and not before, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, requests, following, finish } = await openLeg(scene);
    using _following = following;
    await wetByPrediction(scene, diving);
    const entry = scene.bot.time.age;
    await scene.clock.advance(scene.packetMs);
    assert.equal(request.stopSignal?.aborted, false, `age ${scene.bot.time.age} (entry ${entry}): one packet interval in, the window still stands`);
    await scene.clock.advance(scene.packetMs + 100);
    assert.equal(request.stopSignal?.aborted, true, `age ${scene.bot.time.age} (entry ${entry}): the first age packet 40 ticks on ended it`);
    assert.equal(request.stopSignal?.reason, "Planned breathing stop");
    assert.equal(airSupplyTicks(scene.bot), null, "the air stayed unknown to everyone else");
    finish();
    await assertNothingLeft(scene, { run, requests, following }, null);
  });

  test(`a stopped server leaves the window to its wall cap and the leg stops there, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, requests, following, finish } = await openLeg(scene);
    using _following = following;
    await wetByPrediction(scene, diving);
    const entry = scene.bot.time.age;
    scene.server.stop();
    const wall = serverPacedWallMs(AGE_PACKET_TICKS);
    await scene.clock.advance(wall - 100);
    assert.equal(request.stopSignal?.aborted, false, `just before the ${wall} ms cap the window stands`);
    await scene.clock.advance(200);
    assert.equal(request.stopSignal?.aborted, true, "the wall cap ended it");
    assert.equal(scene.bot.time.age, entry, "the world age never moved: the cap, not an age packet, ended it");
    finish();
    await assertNothingLeft(scene, { run, requests, following }, null);
  });

  test(`an air value that is no integer never opens the window, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, following, finish } = await openLeg(scene);
    using _following = following;
    Reflect.set(scene.bot.entity.metadata, scene.bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply"), "300");
    await wetByPrediction(scene, diving);
    assert.equal(request.stopSignal?.aborted, true, "a present value that is no integer is unknown and the planned stop applies");
    finish();
    await scene.clock.settle(run, 120_000);
  });

  test(`a registry with no air_supply key never opens the window, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, following, finish } = await openLeg(scene);
    using _following = following;
    const player = scene.bot.registry.entitiesByName.player!;
    const keys = player.metadataKeys!;
    Reflect.set(player, "metadataKeys", keys.filter((key) => key !== "air_supply"));
    try {
      await wetByPrediction(scene, diving);
      assert.equal(request.stopSignal?.aborted, true, "without the key the first packet cannot be told apart from silence");
    } finally {
      Reflect.set(player, "metadataKeys", keys);
    }
    finish();
    await scene.clock.settle(run, 120_000);
  });

  for (const [dryTicks, allowed] of [[AGE_PACKET_TICKS, true], [2 * AGE_PACKET_TICKS, false]] as const)
    test(`a dry proof ${dryTicks} ticks old at the first wet read ${allowed ? "still opens" : "no longer opens"} the window, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, following, finish } = await openLeg(scene);
      using _following = following;
      await wetByPrediction(scene, diving, dryTicks * 1_000 / rate);
      assert.equal(request.stopSignal?.aborted, !allowed, `proof age ${dryTicks} ticks behind the entry age`);
      finish();
      await scene.clock.settle(run, 120_000);
    });

  test(`a body that was under water before has no proof, so its first wet read stops the leg, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, following, finish } = await openLeg(scene, { priorWet: true });
    using _following = following;
    await wetByPrediction(scene, diving);
    assert.equal(request.stopSignal?.aborted, true);
    finish();
    await scene.clock.settle(run, 120_000);
  });

  for (const lose of ["block close", "chunk unload"] as const) for (const later of ["a later packet", "no packet"] as const)
    test(`a lost ascent (${lose}, then ${later}) ends the leg with the lost-corridor reason and no swim back, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, requests, following, finish } = await openLeg(scene);
      using _following = following;
      await wetByPrediction(scene, diving);
      assert.equal(request.stopSignal?.aborted, false, "the allowance stands while the way up does");
      if (lose === "block close") for (const y of [60, 61]) for (const x of [1, 2, 3]) scene.cells.load({ x, y, z: 0 }, { stateId: 1 });
      else scene.unloadUpTo(3);
      assert.equal(request.stopSignal?.aborted, true, "the leg stops on the change, with no physics tick");
      if (later === "a later packet") await serverCountsFirstBreath(scene);
      finish();
      const result = await scene.clock.settle(run, 120_000);
      assert.deepEqual([result.status, "reason" in result ? result.reason : null], ["stopped", LOST_CORRIDOR]);
      await assertNothingLeft(scene, { run, requests, following });
      const next = new Diving(scene.bot, scene.world).run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) },
        async () => ({ status: "completed", elapsedMs: 0 }));
      assert.equal((await scene.clock.settle(next, 60_000)).status, "completed", "the next navigation from the lost-corridor end state runs normally");
    });

  for (const [label, age] of [["regresses", 1], ["is not a number", Number.NaN]] as const)
    test(`a world age that ${label} while the window stands ends it at once, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, following, finish } = await openLeg(scene);
      using _following = following;
      await wetByPrediction(scene, diving);
      assert.equal(request.stopSignal?.aborted, false);
      scene.setAge(age);
      scene.bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      finish();
      await scene.clock.settle(run, 120_000);
    });

  for (const [label, age] of [["is not a number", Number.NaN], ["regresses behind the proof", 1]] as const)
    test(`a world age that ${label} at the first wet read never opens the window, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, following, finish } = await openLeg(scene);
      using _following = following;
      scene.bot.emit("physicsTick");
      scene.setAge(age);
      diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
      scene.bot.entity.position.set(WET.x, WET.y, WET.z);
      scene.bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      finish();
      await scene.clock.settle(run, 120_000);
    });

  test(`a respawn between the dry proof and the first wet read leaves no proof for the new body, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, following, finish } = await openLeg(scene);
    using _following = following;
    scene.bot.emit("physicsTick"); // the dry proof of the old body
    scene.bot.emit("respawn"); // a new body: the history starts again, its metadata absent
    await wetByPrediction(scene, diving);
    assert.equal(request.stopSignal?.aborted, true, "the old body's proof does not stand for the new one");
    finish();
    await scene.clock.settle(run, 120_000);
  });

  test(`an air value that turns invalid inside the window ends it at once, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, requests, following, finish } = await openLeg(scene);
    using _following = following;
    await wetByPrediction(scene, diving);
    assert.equal(request.stopSignal?.aborted, false, "the window stands first");
    Reflect.set(scene.bot.entity.metadata, scene.bot.registry.entitiesByName.player!.metadataKeys!.indexOf("air_supply"), "299");
    scene.bot.emit("physicsTick");
    assert.equal(request.stopSignal?.aborted, true, "a present value that is no integer is unknown: the planned stop applies before the +40 expiry");
    finish();
    await assertNothingLeft(scene, { run, requests, following }, null);
  });

  test(`a numeric air retires the window at once: no listener of it is left and the leg outlives its deadline, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const { diving, run, request, requests, following, finish } = await openLeg(scene);
    using _following = following;
    const events = ["breath", "chunkColumnLoad", "chunkColumnUnload", "death", "respawn", "end"];
    const own = events.map((event) => scene.left(event)); // the run's own listeners, before any window
    await wetByPrediction(scene, diving);
    assert.ok(events.some((event, i) => scene.left(event) > own[i]!), "the window added listeners");
    await serverCountsFirstBreath(scene);
    assert.equal(ownAir(scene), 299);
    events.forEach((event, i) => assert.equal(scene.left(event), own[i], `the window's ${event} listener is gone`));
    await scene.clock.advance(2 * scene.packetMs + 100);
    assert.equal(request.stopSignal?.aborted, false, "the deadline the window had no longer ends the leg: the real air judges it");
    finish();
    await assertNothingLeft(scene, { run, requests, following });
  });

  test(`a window still open when the route ends is closed before the swim back, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const seen: number[] = [];
    const leg = await openLeg(scene, { later: () => { seen.push(scene.left("breath")); return { status: "completed", elapsedMs: 0 }; } });
    using _following = leg.following;
    const ownBreath = scene.left("breath"); // the run's own, before any window
    await wetByPrediction(scene, leg.diving);
    assert.ok(scene.left("breath") > ownBreath, "the window listens to the breath");
    // the route fails with the head wet and the window open: the swim back to air is the next route asked
    leg.finish({ status: "stopped", reason: "route failed", elapsedMs: 0 });
    await assertNothingLeft(scene, leg, 2);
    assert.deepEqual(seen, [ownBreath], "the swim back ran with no first-air listener on the bot");
  });

  test(`a lost corridor that is back when the route ends does not suppress the final swim back, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate);
    using _timers = scene.clock.install();
    const leg = await openLeg(scene);
    using _following = leg.following;
    await wetByPrediction(scene, leg.diving);
    for (const y of [60, 61]) for (const x of [1, 2, 3]) scene.cells.load({ x, y, z: 0 }, { stateId: 1 });
    assert.equal(leg.request.stopSignal?.aborted, true, "the allowance ended the leg on the lost corridor");
    for (const y of [60, 61]) for (const x of [1, 2, 3]) scene.cells.load({ x, y, z: 0 }, { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } });
    leg.finish();
    const result = await scene.clock.settle(leg.run, 600_000);
    assert.notEqual("reason" in result ? result.reason : null, LOST_CORRIDOR, "the corridor was back: the run went on to breathe");
    assert.ok(leg.requests.length >= 3, `the run asked ${leg.requests.length} routes: the surface and the final swim back followed the first leg`);
  });

  for (const event of ["death", "respawn"] as const)
    test(`a ${event} during the window ends it: the next physics tick stops the leg, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const { diving, run, request, following, finish } = await openLeg(scene);
      using _following = following;
      await wetByPrediction(scene, diving);
      assert.equal(request.stopSignal?.aborted, false);
      scene.bot.emit(event);
      scene.bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true, "the proof of the old body does not stand for the new one");
      finish();
      await scene.clock.settle(run, 120_000);
    });

  for (const [label, abort] of [
    ["a cancel of the action", (leg: { diving: Diving }) => leg.diving.cancel("cancelled by the request")],
    ["a takeover cancel", (leg: { diving: Diving }) => leg.diving.cancel("the breath reflex took the body")],
  ] as const)
    test(`${label} during the window clears it: no jump, no resume, nothing left, a normal next navigation, at ${rate} tps`, async () => {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const leg = await openLeg(scene);
      using _following = leg.following;
      await wetByPrediction(scene, leg.diving);
      abort(leg);
      assert.equal(leg.request.stopSignal?.aborted, true);
      leg.finish();
      await assertNothingLeft(scene, leg);
      const next = new Diving(scene.bot, scene.world).run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) },
        async () => ({ status: "completed", elapsedMs: 0 }));
      assert.equal((await scene.clock.settle(next, 60_000)).status, "completed");
    });

  test(`a stop signal and a request abort during the window clear it the same way, at ${rate} tps`, async () => {
    for (const how of ["stopSignal", "signal"] as const) {
      const scene = tunnelScene(rate);
      using _timers = scene.clock.install();
      const abort = new AbortController();
      const leg = await openLeg(scene, { runOptions: { [how]: abort.signal } });
      using _following = leg.following;
      await wetByPrediction(scene, leg.diving);
      abort.abort(`${how} aborted`);
      leg.finish();
      await leg.run.catch(() => undefined);
      await assertNothingLeft(scene, { ...leg, run: leg.run.catch(() => undefined) });
    }
  });
}

test("the allowance's reserve is strict at its two neighbours: the same-age charge 60 leaves 240, so a way up of 174 goes on and 175 stops", () => {
  assert.equal(provisionalAirAllows(174, 60), true);
  assert.equal(provisionalAirAllows(175, 60), false);
  assert.equal(DIVE_RESERVE_TICKS, 65);
});

for (const rate of RATES) for (const [ascent, opens] of [[174, true], [175, false]] as const)
  test(`the window ${opens ? "opens" : "stays shut"} for an ascent of ${ascent} ticks when proof and entry share an age, at ${rate} tps`, async () => {
    const scene = tunnelScene(rate); // one body per case: the first wet read latches its history
    using _timers = scene.clock.install();
    scene.bot.emit("login");
    await scene.clock.advance(3 * scene.packetMs);
    using firstAir = new FirstDiveAir({ bot: scene.bot, world: scene.world, leg: () => new AbortController().signal, decide: () => {} });
    firstAir.captureDry(DRY);
    scene.bot.entity.position.set(WET.x, WET.y, WET.z); // the first wet read, at the age of the proof
    assert.equal(firstAir.permits(ascent), opens);
    firstAir.end();
    assert.equal(scene.left("breath"), 0, "ending the window removed its listeners");
  });

test("a spent proof is not taken again after the head was under water: a dry bob opens no second window", async () => {
  const scene = tunnelScene(20);
  using _timers = scene.clock.install();
  scene.bot.emit("login");
  await scene.clock.advance(3 * scene.packetMs);
  using firstAir = new FirstDiveAir({ bot: scene.bot, world: scene.world, leg: () => new AbortController().signal, decide: () => {} });
  firstAir.captureDry(DRY);
  scene.bot.entity.position.set(WET.x, WET.y, WET.z);
  assert.equal(firstAir.permits(100), true);
  firstAir.end();
  scene.bot.entity.position.set(DRY.x, DRY.y, DRY.z);
  firstAir.captureDry(DRY);
  assert.equal(firstAir.permits(100), false, "the wet tick latched the body: its silence proves no full air any more");
});
