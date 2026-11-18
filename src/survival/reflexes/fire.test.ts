import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/index.js";
import { observeMineflayerBlock, type WorldView } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { ActionRunner, type ActionRunnerOptions } from "../../session/action-runner.js";
import {
  type FakeBot,
  type FakeCell,
  type FakeClock,
  createFakeBot,
  createFakeClock,
  flush,
  listenersAddedSince,
} from "../../test-support/fake-bot/index.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { attachFootingReflex } from "./footing.js";
import { ReflexDriver } from "../control/driver.js";
import { decideFireResponse } from "../policy/environment.js";
import { attachFireReflex, fireEscapeFacts } from "./fire.js";
import { recordFireContact } from "../perception/burn.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { confirmFakeDigs } from "../../test-support/life-saving-placements.js";
import { pendingLifeSavingPlacements, recordLifeSavingPlacement, setLifeSavingRemovalContext } from "../../world/life-saving-placements.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { placeSolidBlockInto } from "../../world/placement.js";
import { FootingRecovery } from "../responses/footing.js";

interface LandingOptions { held?: boolean; slowRelease?: boolean; noFooting?: boolean; stoppedPlacement?: boolean; fightRecovery?: (signal: AbortSignal) => Promise<unknown> }

/** Script only the dependency result; the optional placement uses the shared server's real answer seam. */
function createLandingRecovery(bot: FakeBot, options: LandingOptions) {
  let calls = 0;
  let finishLanding = false;
  let released = 0;
  let landingSignal: AbortSignal | undefined;
  const footing = {
    needed: !options.noFooting,
    async recover(signal: AbortSignal): Promise<"landed"> {
      calls++;
      landingSignal = signal;
      try {
        if (options.stoppedPlacement)
          await placeSolidBlockInto(bot, new Vec3(1, 64, 0), bot.inventory.items()[0]!, { signal, lifeSaving: true });
        while (!finishLanding) await waitForPhysicsTicks(bot, 1, signal);
        bot.entity.onGround = true;
        footing.needed = false;
        return "landed";
      } finally { released++; bot.clearControlStates(); }
    },
  };
  return {
    footing, get calls() { return calls; }, get released() { return released; }, get landingSignal() { return landingSignal; },
    land() { finishLanding = true; bot.entity.onGround = true; setBurning(bot, false); },
  };
}

/** A resumable walk suspended by a fight, optionally still releasing or held by its owner. */
async function startLandingWalk(bot: FakeBot, runner: ActionRunner, options: LandingOptions) {
  let attempts = 0;
  let settlements = 0;
  let finishFight = !options.slowRelease;
  const action = defineAction({
    name: "walk_after_fire", description: "Finish the walk's next step after the landing.",
    inputSchema: z.object({}), resultSchema: actionResultSchema({}), formatResult: result => result.status,
    execution: { kind: "resumable_task" }, parse: () => ({}),
    begin: () => async context => {
      if (++attempts > 1) return { status: "succeeded" as const };
      await waitForPhysicsTicks(bot, 1_000, context.signal!);
      return { status: "succeeded" as const };
    },
  });
  const caller = new AbortController();
  const output = runner.run(action, {}, caller.signal, undefined, "fire-walk");
  void output.then(() => { settlements++; });
  await flush();
  const fight = runner.claim("hostile_reflex", "Fixture fight interrupts the walk", async signal => {
    if (!options.held) {
      try {
        if (options.fightRecovery) await options.fightRecovery(signal);
        else await waitForPhysicsTicks(bot, 1_000, signal);
      } catch { /* Physical release follows its abort. */ }
      while (!finishFight) await waitForPhysicsTicks(bot, 1, new AbortController().signal);
    }
    return { value: null, continuation: options.held
      ? { kind: "hold" as const, owner: "hostile_reflex", backstopTicks: 600, reason: "The threat is still observed." }
      : { kind: "resume" as const } };
  });
  assert.equal(fight.kind, "claimed");
  await flush();
  return {
    action, caller, output, get attempts() { return attempts; }, get settlements() { return settlements; },
    releaseFight() { finishFight = true; },
  };
}

/** A walk and fight on a dry floor; fire claims while the impulse still carries the scripted body. */
async function fireLandingScene(resources: AsyncDisposableStack, rate: number, options: LandingOptions = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  resources.use(clock.install());
  const h = createFakeBot({ clock, server: { ticksPerSecond: rate }, carried: options.stoppedPlacement ? { cobblestone: 1 } : {} });
  const { bot } = h;
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 62; y <= 68; y++) {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  }
  const runner = new ActionRunner({ clock, worldAge: () => bot.time.age });
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  let ceilingTicks = 0;
  const register = driver.register.bind(driver);
  driver.register = definition => register({ ...definition, limits(response) {
    const limits = definition.limits(response);
    ceilingTicks = limits.ceilingTicks;
    return limits;
  } });
  let writes = 0;
  let clears = 0;
  const control = bot.setControlState.bind(bot);
  bot.setControlState = (key, state) => { writes++; control(key, state); };
  const clear = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => { clears++; clear(); };
  const placementRequest = new Promise<void>(resolve => h.server.onPacket("block_place", () => {
    if (options.stoppedPlacement) { h.server.stop(); resolve(); }
  }));
  const landing = createLandingRecovery(bot, options);
  const fire = resources.use(attachFireReflex(bot, driver, world, landing.footing));
  // Burn attribution keeps one bot-lifetime death listener, outside each escape's resource scope.
  recordFireContact(bot, "fire", bot.time.age);
  const added = listenersAddedSince(bot);
  const walk = await startLandingWalk(bot, runner, options);
  const outcomes: Record<string, unknown>[] = [];
  driver.onTransition(t => {
    if (t.reflex !== "fire_reflex") return;
    if (t.kind === "claim") {
      // The impulse carried the body out of its fire cell before the new owner starts.
      bot.entity.position.y = 66;
      bot.entity.onGround = false;
      h.world.setCell(new Vec3(0, 64, 0), "air");
      world.load(new Vec3(0, 64, 0), observeMineflayerBlock(bot.blockAt(new Vec3(0, 64, 0))!));
    }
    if (t.kind === "outcome") outcomes.push(t.evidence as Record<string, unknown>);
  });
  setBurning(bot, true);
  h.world.setCell(new Vec3(0, 64, 0), "fire");
  world.load(new Vec3(0, 64, 0), observeMineflayerBlock(bot.blockAt(new Vec3(0, 64, 0))!));
  await clock.advance(50);
  resources.defer(async () => {
    walk.releaseFight();
    landing.land();
    setBurning(bot, false);
    await clock.advance(100);
  });
  return {
    ...h, runner, driver, footing: landing.footing, caller: walk.caller, output: walk.output, fire, action: walk.action, outcomes, placementRequest,
    get calls() { return landing.calls; }, get released() { return landing.released; }, get attempts() { return walk.attempts; },
    get ceilingTicks() { return ceilingTicks; },
    get landingSignal() { return landing.landingSignal; }, land: landing.land, releaseFight: walk.releaseFight,
    async assertReleased() {
      assert.equal(landing.released, landing.calls, "every recovery scope released once");
      assert.equal(walk.settlements, 1);
      for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
      setBurning(bot, false);
      bot.entity.onGround = true;
      const before = { writes, clears, outcomes: outcomes.length };
      await clock.advance(16_000);
      assert.deepEqual({ writes, clears, outcomes: outcomes.length }, before, "retired deadline makes no control writes or second verdict");
      assert.equal(Object.values(bot.controlState).some(Boolean), false);
      for (const event of ["physicsTick", "death", "respawn"]) assert.equal(added(event), 0, event);
    },
  };
}

/** Await an observed recovery phase on the same fake clock, including while the server is stopped. */
async function advanceUntil(clock: FakeClock, observed: () => boolean, maximumMs = 2_000): Promise<void> {
  for (let waited = 0; !observed() && waited < maximumMs; waited += 50) await clock.advance(50);
  assert.equal(observed(), true, "the required recovery phase was observed within the bound");
}

/** Real D14 handoff: a fight owns recovery until fire reserves its body, then the same instance must land it. */
async function realFireLandingScene(resources: AsyncDisposableStack, rate: number, placing: boolean) {
  const clock = createFakeClock({ mode: "mocked" });
  resources.use(clock.install());
  const h = createFakeBot({ clock, position: new Vec3(0.8, 64, 0.5), groundY: null, cells: { "0,63,0": "stone" },
    carried: { cobblestone: 4 }, server: { ticksPerSecond: rate } });
  const { bot } = h;
  const world = new MemoryWorld();
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 62; y <= 68; y++) {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  }
  bot.on("blockUpdate", (_before, after) => { if (after) world.load(after.position, observeMineflayerBlock(after)); });
  const recovery = resources.use(new FootingRecovery(bot, world));
  const runner = new ActionRunner({ clock, worldAge: () => bot.time.age });
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world, recovery));
  recordFireContact(bot, "fire", bot.time.age);
  const added = listenersAddedSince(bot);
  bot._client.emit("entity_velocity", { entityId: bot.entity.id, velocity: { x: 2400, y: 3200, z: 0 } });
  assert.equal(recovery.needed, true);
  bot.entity.onGround = false;
  bot.entity.position.y = placing ? 64.5 : 65.5;
  bot.entity.velocity.set(0.3, 0, 0);
  let preempted: string | undefined;
  if (placing) h.server.onPacket("block_place", () => h.server.stop());
  const walk = await startLandingWalk(bot, runner, { fightRecovery: async signal => {
    try { return await recovery.recover(signal); }
    finally { if (signal.aborted) preempted = recovery.snapshot()?.phase; }
  } });
  await advanceUntil(clock, () => recovery.snapshot()?.phase === (placing ? "placing" : "steering"));
  if (placing) assert.equal(h.server.isRunning, false, "the placement answer is outstanding at takeover");
  const outcomes: Record<string, unknown>[] = [];
  driver.onTransition(t => {
    if (t.reflex !== "fire_reflex") return;
    if (t.kind === "claim") { bot.entity.position.set(0.5, 65.5, 0.5); }
    if (t.kind === "outcome") outcomes.push(t.evidence as Record<string, unknown>);
  });
  setBurning(bot, true);
  h.world.setCell(new Vec3(1, placing ? 64 : 65, 0), "fire");
  await advanceUntil(clock, () => preempted !== undefined);
  assert.equal(preempted, "pending", "D14 carries the interrupted flight to the fire owner");
  h.server.resume();
  await advanceUntil(clock, () => runner.status().activeAction?.action === "fire_reflex" && recovery.active);
  resources.defer(async () => {
    bot.entity.position.set(0.5, 64, 0.5); bot.entity.velocity.set(0, 0, 0); bot.entity.onGround = true;
    setBurning(bot, false);
    await clock.advance(100);
  });
  return { ...h, recovery, runner, driver, walk, outcomes, added };
}

for (const rate of [20, 10]) for (const phase of ["steering", "placing", "burning landing"] as const)
  test(`real recovery preempted during ${phase} is landed by fire (${rate} tps)`, async () => {
    await using resources = new AsyncDisposableStack();
    const s = await realFireLandingScene(resources, rate, phase === "placing");
    const started = s.clock.now();
    if (phase === "burning landing") {
      for (const [x, z] of [[-1, 0], [1, 0], [0, -1], [0, 1]])
        for (let y = 64; y <= 67; y++) s.world.setCell(new Vec3(x!, y, z!), "stone");
      s.world.setCell(new Vec3(0, 64, 0), "fire");
    }
    s.bot.entity.position.set(0.5, 64, 0.5);
    s.bot.entity.velocity.set(0, 0, 0);
    s.bot.entity.onGround = true;
    assert.equal((await s.clock.settle(s.walk.output, 15_000)).result.status, "succeeded");
    assert.equal(s.walk.attempts, 2);
    assert.ok(s.clock.now() - started < 15_000);
    if (phase === "burning landing") assert.equal(s.bot.blockAt(new Vec3(0, 64, 0))?.name, "air");
    else assert.equal(s.recovery.snapshot()?.phase, "landed");
    const outcome = s.outcomes[0]?.outcome as { kind: string; footing: { recovered: number; last: string } };
    assert.equal(outcome.kind, "dry_footing");
    assert.ok(outcome.footing.recovered >= 1);
    if (phase === "burning landing") assert.equal(outcome.footing.last, "interrupted", "renewed contact cut the real landing");
    assert.equal(s.recovery.active, false);
    for (const event of ["physicsTick", "death", "respawn"]) assert.equal(s.added(event), 0, event);
    setBurning(s.bot, false);
    const cleared = Object.values(s.bot.controlState);
    await s.clock.advance(16_000);
    assert.deepEqual(Object.values(s.bot.controlState), cleared);
    assert.equal((await s.runner.run(s.walk.action, {})).result.status, "succeeded");
  });

for (const rate of [20, 10]) {
  test(`a fire claim over a fight lands its obligation and resumes the walk (${rate} tps)`, async () => {
    await using resources = new AsyncDisposableStack();
    const s = await fireLandingScene(resources, rate);
    assert.equal(s.calls, 1, "fire lands before returning a verdict");
    assert.equal(s.ceilingTicks, 1_180, "the claim includes packet margins for escape and settle");
    const refused = s.runner.claim("recover_footing", "same obligation", async () => {
      assert.fail("a lower footing claim cannot drive fire's body");
    });
    assert.equal(refused.kind, "busy");
    resources.use(attachFootingReflex(s.driver, { activeEngagement: () => null }, s.footing, () => {}));
    s.land();
    assert.equal((await s.clock.settle(s.output, 1_000)).result.status, "succeeded");
    assert.equal(s.attempts, 2);
    await s.clock.advance(100);
    assert.equal(s.calls, 1, "a discharged obligation starts no footing claim");
    assert.deepEqual(s.outcomes[0]?.outcome && Reflect.get(s.outcomes[0].outcome as object, "footing"), { recovered: 1, last: "landed" });
    await s.assertReleased();
  });

  for (const exit of ["request", "caller", "death", "close", "handoff"] as const)
    test(`${exit} cancellation during fire landing preserves physical ownership (${rate} tps)`, async () => {
      await using resources = new AsyncDisposableStack();
      const s = await fireLandingScene(resources, rate, { slowRelease: exit === "handoff" });
      assert.equal(s.runner.status().activeAction?.action, "fire_reflex");
      if (exit === "request" || exit === "handoff") s.runner.cancelRequest("fire-walk", "Cancel the suspended walk");
      if (exit === "caller") s.caller.abort(new Error("Caller left"));
      if (exit === "death") s.runner.cancelActive("The bot died", { kind: "death" });
      if (exit === "close") await s.fire[Symbol.asyncDispose]();
      assert.equal(s.attempts, 1);
      if (exit === "request" || exit === "caller" || exit === "handoff") {
        let settled = false;
        void s.output.then(() => { settled = true; });
        await s.clock.advance(500);
        assert.equal(settled, false, "the runner's existing contract awaits the physical verdict before returning cancellation");
        assert.equal(s.landingSignal?.aborted ?? false, false, "objective cancel does not cancel the physical rescue");
        assert.equal(s.runner.status().activeAction?.action, "fire_reflex");
        s.releaseFight();
        await s.clock.advance(50);
        assert.equal(s.calls, 1);
        s.land();
        await s.clock.advance(100);
      } else {
        assert.equal(s.landingSignal?.aborted, true);
      }
      const finished = await s.clock.settle(s.output, 500);
      assert.equal(finished.result.status, "cancelled");
      assert.equal(s.released, 1);
      assert.equal(s.attempts, 1, "a later fire verdict cannot revive the cancelled objective");
      await s.assertReleased();
      setBurning(s.bot, false);
      s.bot.entity.onGround = true;
      assert.equal((await s.runner.run(s.action, {})).result.status, "succeeded", "the next action is admitted after physical release");
    });

  test(`a stopped server bounds landing without advancing world age (${rate} tps)`, async () => {
    await using resources = new AsyncDisposableStack();
    const s = await fireLandingScene(resources, rate, { stoppedPlacement: true });
    await s.clock.settle(s.placementRequest, 1_000);
    assert.equal(s.calls, 1);
    assert.equal(s.server.isRunning, false, "server stopped with the actual placement packet unanswered");
    assert.equal(s.bot.blockAt(new Vec3(1, 64, 0))?.name, "air");
    const age = s.bot.time.age;
    const gameTime = s.server.gameTime;
    let clientTicks = 0;
    const tick = () => { clientTicks++; };
    s.bot.on("physicsTick", tick);
    await s.clock.advance(20_050);
    s.bot.off("physicsTick", tick);
    const finished = await s.output;
    assert.equal(s.bot.time.age, age);
    assert.equal(s.server.gameTime, gameTime);
    assert.ok(clientTicks > 0, "client physics cannot answer the placement");
    assert.equal(finished.result.status, "cancelled");
    assert.match(finished.result.error ?? "", /Fire escape did not establish safe footing/);
    assert.equal(Reflect.get(s.outcomes[0]?.outcome as object, "kind"), "escape_timed_out");
    assert.equal(s.released, 1);
    assert.equal(s.landingSignal?.aborted, true);
    await s.assertReleased();
    assert.equal((await s.runner.run(s.action, {})).result.status, "succeeded");
  });

  test(`a held walk survives an idle fire claim with an airborne hop (${rate} tps)`, async () => {
    await using resources = new AsyncDisposableStack();
    const s = await fireLandingScene(resources, rate, { held: true, noFooting: true });
    await s.clock.advance(200);
    assert.equal(s.runner.status().activeAction?.action, "fire_reflex");
    assert.equal(s.calls, 0);
    s.land();
    await s.clock.advance(50);
    assert.equal(s.attempts, 1, "fire's resume returns the hold to its original owner");
    assert.equal(Reflect.get(s.outcomes[0]?.outcome as object, "kind"), "dry_footing");
    assert.ok(Number(Reflect.get(s.outcomes[0]?.outcome as object, "airborneTicks")) >= 1);
    assert.equal(s.runner.releaseHold("hostile_reflex", "none_observed", "The threat ended."), true);
    assert.equal((await s.clock.settle(s.output, 500)).result.status, "succeeded");
    assert.equal(s.attempts, 2);
    await s.assertReleased();
  });
}

test("health at or under the burn left is lethal", async () => {
  const { bot, clock, world } = burningBesidePit(true, { startAge: 1100 });
  recordFireContact(bot, "lava", 1000);
  bot.health = 8;
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, stillRunner(), { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  await clock.advance(50);
  assert.equal(JSON.parse(JSON.stringify(driver.snapshot().find((entry) => entry.name === "fire_reflex")!.danger)).lethalBurn, true);
  bot.health = 15;
  await clock.advance(50);
  assert.equal(JSON.parse(JSON.stringify(driver.snapshot().find((entry) => entry.name === "fire_reflex")!.danger)).lethalBurn, false);
});

test("the fire reflex sees a water bucket only in a dimension that holds water", async () => {
  for (const dimension of ["overworld", "the_nether"]) {
    const { bot, clock } = createFakeBot({ dimension, carried: { water_bucket: 1 }, health: 8 });
    setBurning(bot, true);
    recordFireContact(bot, "lava", bot.time.age);
    await using resources = new AsyncDisposableStack();
    const driver = resources.use(new ReflexDriver(bot, stillRunner(), { now: clock.now }));
    resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
    await clock.advance(50);
    const danger = JSON.parse(JSON.stringify(driver.snapshot().find(entry => entry.name === "fire_reflex")!.danger));
    assert.equal(danger.waterBucket, dimension === "overworld");
  }
});

test("a bucket burn escape keeps ordinary water, reclaims foreign water, and reports a missing empty bucket", async () => {
  for (const { side, foreign, noEmpty } of [
    { side: false, foreign: false, noEmpty: false },
    { side: true, foreign: false, noEmpty: false },
    { side: false, foreign: true, noEmpty: false },
    { side: false, foreign: true, noEmpty: true },
  ]) {
    const { bot, clock, inventory } = createFakeBot({
      carried: { water_bucket: 1 }, health: 8, simulatePhysics: true,
      cells: side ? { "0,63,0": "oak_leaves" } : {},
      entities: side ? { 2: { name: "player", position: new Vec3(1.5, 64, 0.5) } } : {},
    });
    const world = new MemoryWorld();
    for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) for (let y = 62; y <= 67; y++) {
      const at = new Vec3(x, y, z);
      world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
    }
    bot.on("blockUpdate", (_before, after) => { if (after) world.load(after.position, observeMineflayerBlock(after)); });
    const source = bot.entity.position.floored().offset(side ? -1 : 0, 0, 0);
    await using resources = new AsyncDisposableStack();
    const data = resources.use(temporaryBotData());
    if (foreign) setProtectedRegionsProvider(bot, () => [{
      regionId: 7, owner: "Tom", label: "pool", dimension: "overworld",
      min: { x: -8, y: 63, z: -8 }, max: { x: 8, y: 70, z: 8 },
    }]);
    if (noEmpty) bot.on("physicsTick", () => {
      const empty = bot.inventory.items().find(item => item.name === "bucket");
      if (empty) setCarriedCount(inventory, bot.registry, empty.type, 0);
    });
    const runner = stillRunner();
    const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now, lifeSaving: { data } }));
    resources.use(attachFireReflex(bot, driver, world));
    let attempts = 0;
    const interrupted = defineAction({
      name: "work_beside_water", description: "Resume the next step with the poured source still present.",
      inputSchema: z.object({}), resultSchema: actionResultSchema({}), formatResult: result => result.status,
      execution: { kind: "resumable_task" }, parse: () => ({}),
      begin: () => async context => {
        if (++attempts > 1) {
          assert.equal(bot.blockAt(source)?.name, foreign && !noEmpty ? "air" : "water");
          if (!foreign) assert.equal(Reflect.get(bot.entity, "isInWater"), true);
          return { status: "succeeded" as const };
        }
        const signal = context.signal;
        assert.ok(signal);
        await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        throw signal.reason;
      },
    });
    const output = runner.run(interrupted, {});
    await flush();
    setBurning(bot, true);
    recordFireContact(bot, "lava", bot.time.age);
    await clock.advance(2_500);
    const finished = await output;
    assert.equal(finished.result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.equal(bot.inventory.items().filter(item => item.name === "water_bucket").length, foreign && !noEmpty ? 1 : 0);
    assert.equal(bot.inventory.items().find(item => item.name === "bucket")?.count ?? 0, foreign ? 0 : 1);
    assert.equal(pendingLifeSavingPlacements(bot).length, noEmpty ? 1 : 0);
    assert.equal(bot.usingHeldItem, false);
    if (noEmpty) assert.match((finished.interruptions ?? []).join("|"), /left a life-saving block in .*pool/);
    assert.equal(Object.values(bot.controlState).some(Boolean), false);
  }
});

/** Reuse the interrupted-pit scene, with a foreign region and the existing dig/server contract. */
function foreignPoolScene(resources: AsyncDisposableStack) {
  const clock = createFakeClock({ mode: "mocked" });
  const data = resources.use(temporaryBotData());
  const scene = lavaWaitScene(resources, clock, { clock });
  resources.use(clock.install());
  setProtectedRegionsProvider(scene.bot, () => [{
    regionId: 7, owner: "Tom", label: "pool", dimension: "overworld",
    min: { x: -20, y: 62, z: -20 }, max: { x: 20, y: 70, z: 20 },
  }]);
  confirmFakeDigs({ bot: scene.bot, server: scene.server });
  setLifeSavingRemovalContext(scene.bot, { data });
  scene.bot.game.gameMode = "creative";
  // The driver already exists; supply the same note store runtime composition normally sets.
  return { ...scene, clock, data };
}

test("a lava step placed in a foreign region is removed before the action resumes", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = foreignPoolScene(resources);
  // The placement site is exercised by the response tests; this scene pins cleanup's ordering within the hold.
  const cell = scene.bot.entity.position.floored().offset(1, 0, 0);
  scene.fake.setCell(cell, "cobblestone");
  recordLifeSavingPlacement(scene.bot, cell, "block");
  const { output } = await scene.startInterrupted();
  await scene.leavePit();
  await scene.clock.advance(500);
  assert.equal((await output).result.status, "succeeded");
  assert.equal(scene.bot.blockAt(cell)?.name, "air");
  assert.deepEqual(pendingLifeSavingPlacements(scene.bot), []);
});

test("a removal that cannot reach the step reports its region and retries at the next safe moment", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = foreignPoolScene(resources);
  const cell = new Vec3(12, 65, 0);
  scene.fake.setCell(cell, "cobblestone");
  recordLifeSavingPlacement(scene.bot, cell, "block");
  const outcomes: unknown[] = [];
  scene.driver.onTransition(event => { if (event.kind === "outcome") outcomes.push(event.evidence); });
  const { output } = await scene.startInterrupted();
  await scene.leavePit();
  await scene.clock.advance(100);
  const finished = await output;
  assert.match((finished.interruptions ?? []).join("|"), /left a life-saving block in .* at 12 65 0/);
  assert.match(JSON.stringify(outcomes), /leftInRegion.*12.*65.*pool/);
  assert.equal(pendingLifeSavingPlacements(scene.bot).length, 1);
  assert.equal(scene.data.read("SELECT * FROM notes").length, 1);
  scene.bot.entity.position.set(10.5, 65, 0.5);
  await scene.clock.advance(500);
  scene.bot.emit("physicsTick");
  await scene.clock.advance(500);
  assert.equal(scene.bot.blockAt(cell)?.name, "air");
  assert.deepEqual(pendingLifeSavingPlacements(scene.bot), []);
});

test("lava returning during fire cleanup stops the dig and retains the step for the next safe moment", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = foreignPoolScene(resources);
  scene.bot.game.gameMode = "survival";
  const cell = scene.bot.entity.position.floored().offset(1, 0, 0);
  scene.fake.setCell(cell, "cobblestone");
  recordLifeSavingPlacement(scene.bot, cell, "block");
  const { output } = await scene.startInterrupted();
  await scene.leavePit();
  await scene.clock.advance(100);
  assert.ok(scene.bot.targetDigBlock, "cleanup is digging when lava returns");
  Object.assign(scene.bot.entity, { isInLava: true });
  scene.bot.emit("physicsTick");
  await scene.clock.advance(100);
  const finished = await output;
  assert.equal(finished.result.status, "cancelled");
  assert.match((finished.interruptions ?? []).join("|"), /in danger again/);
  assert.equal(scene.bot.targetDigBlock, null);
  assert.equal(pendingLifeSavingPlacements(scene.bot).length, 1);
  assert.equal(scene.bot.blockAt(cell)?.name, "cobblestone");
  Object.assign(scene.bot.entity, { isInLava: false });
  setBurning(scene.bot, false);
  scene.bot.game.gameMode = "creative";
  scene.bot.emit("physicsTick");
  await scene.clock.advance(500);
  assert.deepEqual(pendingLifeSavingPlacements(scene.bot), []);
  assert.equal(scene.bot.blockAt(cell)?.name, "air");
});

test("fire response selection replays from the observed escape availability", () => {
  const recorded = JSON.parse(
    JSON.stringify({
      reason: "contact",
      advancing: false,
      inLava: false,
      inFire: false,
      burning: true,
      escapeAvailable: false,
    }),
  );
  assert.equal(decideFireResponse(recorded).kind, "stand_down");
  assert.equal(decideFireResponse({ ...recorded, escapeAvailable: true }).kind, "respond");
  assert.equal(decideFireResponse({ ...recorded, inLava: true }).kind, "respond");
  assert.equal(
    decideFireResponse({ ...recorded, inFire: true }).kind,
    "respond",
    "active fire cannot be mistaken for residual burning",
  );
  const lethal = { ...recorded, reason: "lethal_burn" as const, lethalBurn: true, waterBucket: false, health: 8, burnTicks: 200 };
  const response = decideFireResponse({ ...lethal, escapeAvailable: true });
  assert.equal(response.kind, "respond");
  if (response.kind === "respond") assert.equal(response.response, "lethal_burn");
  const decision = decideFireResponse(lethal);
  assert.equal(decision.kind, "stand_down");
  if (decision.kind === "stand_down") {
    const excluded = decision.candidates[0]!.excluded;
    assert.equal(excluded.kind, "infeasible_now");
    if (excluded.kind === "infeasible_now") assert.match(excluded.premise, /Burning with 8 HP and about 10 s of burn left/);
  }
});


/** The shared_flags metadata bit 0 the fire checks read as burning, at the version's index. */
function setBurning(bot: FakeBot, burning: boolean): void {
  Reflect.set(bot.entity.metadata, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags"), burning ? 1 : 0);
}

/** Lava at `level` (a flowed layer below 8). */
const lavaAt = (level: number): FakeCell => ({ name: "lava", properties: { level } });

/**
 * A runner whose stall clock never moves: its 30 s ceiling and 6 s without progress cannot trip. The fire tests tick the
 * client by hand (one tick per time packet), so a runner on the bot's clock would see a stall the game does not.
 */
const stillRunner = (options: ActionRunnerOptions = {}) =>
  new ActionRunner({ clock: createFakeClock({ mode: "manual" }), ...options });

/** The client ticks by hand, `count` of them, letting what each one starts settle before the next. */
async function tick(bot: FakeBot, count = 1): Promise<void> {
  for (let done = 0; done < count; done++) {
    bot.emit("physicsTick");
    await flush();
  }
}

test("burning with no reachable water does not lock a Nether fight out of the body", async () => {
  const { bot, clock } = createFakeBot();
  setBurning(bot, true);
  const runner = stillRunner();
  let release!: () => void;
  let cancelled = false;
  const claim = runner.claim("hostile_reflex", "fight", async (signal) => {
    signal.addEventListener("abort", () => {
      cancelled = true;
    });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { value: undefined, continuation: { kind: "return" as const, reason: null } };
  });
  if (claim.kind !== "claimed") throw new Error("Expected claim");
  await Promise.resolve();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  await clock.advance(250);
  assert.equal(cancelled, false);
  assert.equal(runner.status().activeAction?.action, "hostile_reflex");
  release();
  await claim.outcome;
});

/**
 * A body in lava with nothing around it to swim up to (nothing loaded): the escape holds jump until its server budget
 * ends it, which the reflex answers `no_escape`. It used to fail at once; `fire-lava-escape.md` "A body in a deep pool
 * swims up" (plan 2026-11-07-p4-06b T1) replaced that.
 */
const SWIM_UP_UNTIL_THE_PACKET_DEADLINE_MS = 16_100;

test("a failed airborne fire escape does not suppress a fresh attempt after landing", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ clock });
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const observe = () => clock.advance(250);
  await clock.advance(SWIM_UP_UNTIL_THE_PACKET_DEADLINE_MS);
  await observe();
  const first = driver.answered.snapshot()[0];
  assert.equal(first?.failure.kind, "no_escape");
  await observe();
  assert.equal(driver.answered.snapshot()[0]?.id, first.id, "unchanged failure facts prevent repeated claims");
  bot.entity.onGround = true;
  await observe();
  assert.equal(runner.status().activeAction?.action, "fire_reflex", "landing changes the escape's physical premises: a fresh claim");
  await clock.advance(SWIM_UP_UNTIL_THE_PACKET_DEADLINE_MS);
  assert.notEqual(driver.answered.snapshot()[0]?.id, first.id);
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "no_escape");
});

/** A burning body on the west bank of the one-cell lava pit; the water 2 cells east is `ringed` by lava or open. */
function burningBesidePit(ringed: boolean, options: { clock?: FakeClock; startAge?: number } = {}) {
  const cells: Record<string, FakeCell> = { "0,64,0": "lava", "2,64,0": "water" };
  if (ringed)
    Object.assign(cells, {
      "2,64,0": "lava",
      "3,64,0": "water",
      "4,64,0": "lava",
      "3,64,1": "lava",
      "3,64,-1": "lava",
    });
  const harness = createFakeBot({
    cells,
    groundY: 64,
    position: new Vec3(-0.5, 65, 0.5),
    clock: options.clock,
    server: { startAge: options.startAge },
  });
  const { bot } = harness;
  setBurning(bot, true);
  const memory = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++)
      for (let y = 62; y <= 68; y++) {
        const at = new Vec3(x, y, z);
        memory.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  let reads = 0;
  const world: WorldView = {
    blockAt: (x, y, z) => (reads++, memory.blockAt(x, y, z)),
    subscribe: (listener) => memory.subscribe(listener),
    get revision() {
      return memory.revision;
    },
  };
  return { bot, clock: harness.clock, server: harness.server, fake: harness.world, world, memory, reads: () => reads };
}

test("a burning bot near reachable water is answered", async () => {
  const { bot, clock, world } = burningBesidePit(false);
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  await clock.advance(150);
  assert.equal(runner.status().activeAction?.action, "fire_reflex", "the way round the lava is a reachable escape");
});

test("a still body in one world revision searches once", async () => {
  const { bot, clock, world, reads } = burningBesidePit(true);
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  await clock.advance(50);
  const afterFirst = reads();
  assert.ok(afterFirst > 0, "the first tick searches");
  await clock.advance(250);
  assert.equal(reads(), afterFirst, "the same cell and revision read nothing more");
  assert.ok(!runner.status().activeAction, "water behind lava is no escape: the reflex stands down");
});

test("a walk that outlasts its server budget is reported as out of time, not as no escape", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, world } = burningBesidePit(false, { clock });
  // Client steering would stall before the server budget: freeze physics to isolate the deadline.
  bot.physicsEnabled = false;
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  await tick(bot, 3);
  assert.equal(runner.status().activeAction?.action, "fire_reflex");
  await clock.advance(16_050);
  await tick(bot, 3);
  const failure = driver.answered.snapshot()[0]?.failure;
  assert.equal(failure?.kind, "no_escape");
  assert.match(String(failure && "why" in failure ? failure.why : ""), /ran out of time/);
});

/**
 * A resumable action running while a burning body leaves a lava pit, in a world where lava can still spread: the
 * reflex claims the body, the escape ends on the first tick after `leavePit()`, then it waits for the lava. The body
 * is ticked by hand, once per time packet (`tickTo`): it never moves, so 20 ticks a second would end the escape as
 * stalled (40 ticks) before the scene says so. World ages move in jumps of 20, as the server's time packets do.
 */
function lavaWaitScene(
  resources: AsyncDisposableStack,
  clock: FakeClock = createFakeClock({ mode: "manual" }),
  runnerOptions: ActionRunnerOptions = {},
) {
  const { bot, server, fake, world, memory } = burningBesidePit(false, { clock, startAge: 1000 });
  Object.assign(bot.entity, { isInLava: true });
  bot.physicsEnabled = false;
  const runner = stillRunner(runnerOptions);
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  const attempts = { count: 0 };
  const action = defineAction({
    name: "dig_beside_lava",
    description: "A resumable action the fire reflex interrupts.",
    inputSchema: z.object({}),
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    execution: { kind: "resumable_task" },
    parse: () => ({}),
    begin: () => async (context) => {
      attempts.count += 1;
      if (attempts.count > 1) return { status: "succeeded" as const };
      await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
      throw context.signal?.reason;
    },
  });
  let lavaFlips = 0;
  const scene = {
    bot,
    fake,
    runner,
    driver,
    server,
    attempts,
    /** Starts the action and lets the reflex take the body from it: the bot is in the lava, burning. */
    async startInterrupted() {
      const output = runner.run(action, {});
      for (let turn = 0; turn < 50 && attempts.count < 1; turn++) await flush();
      await tick(bot);
      assert.equal(runner.status().activeAction?.action, "fire_reflex", "the reflex has the body");
      return { output };
    },
    /** A lava level changes inside the reflex's scan volume at the current world age. */
    lavaChanges() {
      const at = bot.entity.position.floored().offset(2, 0, 0);
      fake.setCell(at, lavaAt(lavaFlips++ % 2 === 0 ? 6 : 7));
    },
    /** Lava of level 2 appears at the cell east of the body, in the bot's reads and in the escape's world. */
    lavaSpreadsBesideTheBody() {
      const at = bot.entity.position.floored().offset(1, 0, 0);
      fake.setCell(at, lavaAt(2));
      memory.load(at, observeMineflayerBlock(bot.blockAt(at)!));
    },
    /** One time packet (20 ticks of world age) and one client tick at a time, up to world age `age`. */
    async tickTo(age: number) {
      for (let next = server.age + 20; next <= age; next += 20) {
        await clock.advance(1_000);
        await tick(bot);
      }
    },
    /** Out of the lava and not burning: the escape ends on the next tick. */
    async leavePit() {
      Object.assign(bot.entity, { isInLava: false });
      setBurning(bot, false);
      await scene.tickTo(server.age + 20);
    },
    /** The clock jumps with the server frozen (the world age as it was) and the client not ticking: only timers move. */
    async jump(ms: number) {
      server.stop();
      await clock.advance(ms);
      server.resume();
    },
  };
  return scene;
}

/** The lava changes as the bot leaves the pit and at each of the next five flow steps: it is still spreading. */
async function leavePitWhileLavaSpreads(scene: ReturnType<typeof lavaWaitScene>): Promise<void> {
  scene.lavaChanges();
  await scene.leavePit();
  for (let step = 0; step < 5; step++) {
    scene.lavaChanges();
    await scene.tickTo(scene.server.age + 20);
  }
}

test("an escape from spreading lava resumes the action only after the lava settles", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.tickTo(1020);
  scene.lavaChanges();
  await scene.leavePit();
  assert.equal(scene.server.age, 1040);
  await scene.tickTo(1060);
  assert.equal(scene.attempts.count, 1, "age 1060: 40 ticks after the last change, 60 needed");
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "the reflex still holds the body");
  await scene.tickTo(1080);
  const finished = await output;
  assert.equal(scene.attempts.count, 2, "age 1080: two flow steps without a change");
  assert.equal(finished.result.status, "succeeded");
});

test("lava still spreading when the server stops returns the action with the spreading message", async () => {
 for (const reescape of [false, true]) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources, clock);
  const { output } = await scene.startInterrupted();
  if (reescape) {
    scene.lavaChanges();
    await scene.leavePit();
    scene.lavaSpreadsBesideTheBody();
    await scene.tickTo(scene.server.age + 20);
    assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "walking away from the lava");
  } else await leavePitWhileLavaSpreads(scene);
  assert.equal(scene.attempts.count, 1);
  // The first budget look after the last time packet observes its move 50 ms into the freeze.
  await scene.jump(20_050);
  const finished = await output;
  assert.equal(scene.attempts.count, 1, "the action was not resumed");
  assert.equal(finished.result.status, "cancelled");
  assert.match((finished.interruptions ?? []).join("|"), /still spreading/);
  assert.deepEqual(scene.driver.answered.snapshot(), [], "nothing is remembered for this outcome");
  const next = defineAction({
    name: "look_around",
    description: "A plain action started after the lava wait gave up.",
    inputSchema: z.object({}),
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    execution: { kind: "task" },
    parse: () => ({}),
    execute: async () => ({ status: "succeeded" as const }),
  });
  assert.equal((await scene.runner.run(next, {})).result.status, "succeeded");
  assert.ok(!scene.runner.status().activeAction, "the next action releases the body again");
 }
});

test("static lava or changes older than two flow steps resume at once", async () => {
 for (const oldChange of [false, true]) {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  if (oldChange) { scene.lavaChanges(); await scene.tickTo(1100); }
  await scene.leavePit();
  const finished = await output;
  assert.equal(scene.attempts.count, 2, "no recent change: the change at 1000 is 120 ticks old, or absent");
  assert.equal(finished.result.status, "succeeded");
 }
});

test("an endangered body during the wait returns the action with the danger message", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  scene.bot.health = 14;
  await scene.tickTo(scene.server.age + 20);
  const finished = await output;
  assert.equal(scene.attempts.count, 1);
  assert.match((finished.interruptions ?? []).join("|"), /in danger again/);
});

// The retry pause counts world ticks (plan 2026-11-16-reflex-limits-ticks T3): 40 ticks from the age cached when the failure
// was answered, plus one packet: the packet of age A + 60. Old code: 2 000 ms after the answer (20 ticks at 10 tps).
for (const ticksPerSecond of [20, 10])
  test(`no escape in static lava is tried again after the packet of age A + 60, not 2 s later (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond } });
    Object.assign(bot.entity, { isInLava: true, onGround: false });
    const runner = stillRunner(); // its claim watch is inert on purpose (see stillRunner): the retry pause is the subject, the limits are tested in driver-limits
    await using resources = new AsyncDisposableStack();
    const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
    resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
    // The answer is made in the slice the loop stops at: `answeredAge` is the age cached when it was remembered.
    while (driver.answered.snapshot().length === 0) await clock.advance(50);
    const answeredAge = bot.time.age;
    const first = driver.answered.snapshot()[0];
    assert.equal(first?.failure.kind, "no_escape");
    while (bot.time.age < answeredAge + 60) {
      assert.equal(driver.answered.snapshot()[0]?.id, first?.id, `the same lava at age ${bot.time.age}, short of A + 60: still answered`);
      await clock.advance(50);
    }
    await clock.advance(100);
    assert.equal(runner.status().activeAction?.action, "fire_reflex", "still burning in the same cells: tried again");
    await clock.advance(ticksPerSecond === 20 ? 16_100 : 32_100);
    assert.notEqual(driver.answered.snapshot()[0]?.id, first?.id, "and the second try is answered in its turn");
    assert.equal(driver.answered.snapshot()[0]?.failure.kind, "no_escape");
  });

test("a throwing blockUpdate handler does not throw out of the emit", async () => {
  const { bot, clock } = createFakeBot();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, stillRunner(), { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const hostile = { name: "lava", stateId: 1, get position(): never { throw new Error("chunk unloaded"); } } as never;
  assert.doesNotThrow(() => bot.emit("blockUpdate", null, hostile));
});

test("lava spreading toward the body during the wait runs the escape again before the action resumes", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  scene.lavaSpreadsBesideTheBody();
  await scene.tickTo(scene.server.age + 20);
  assert.equal(scene.attempts.count, 1, "the action is not returned: the escape runs again");
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "still the same hold on the body");
  scene.bot.entity.position.set(-2.5, 65, 0.5);
  await scene.tickTo(scene.server.age + 20);
  assert.equal(scene.attempts.count, 1, "safe again, but the lava changed only just now");
  await scene.tickTo(scene.server.age + 80);
  assert.equal((await output).result.status, "succeeded", "resumed once two flow steps passed with no change");
  assert.equal(scene.attempts.count, 2);
});

/**
 * The lava-wait scene with the runner on the scene's own clock: `pass(ms)` moves it with the client ticking 20 times a
 * second (and a time packet each second), or with the client frozen when `ticking` is false.
 */
function limitedLavaScene(resources: AsyncDisposableStack, clock: FakeClock) {
  const scene = lavaWaitScene(resources, clock, { clock, cancelGraceMs: 500 });
  const pass = async (ms: number, ticking = true) => {
    scene.bot.physicsEnabled = ticking;
    await clock.advance(ms);
    scene.bot.physicsEnabled = false;
  };
  return { ...scene, pass };
}

for (const inWater of [false, true]) {
test(`after an escape onto ${inWater ? "water" : "dry ground"} the settle wait is not cut at 6 s`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  Object.assign(scene.bot.entity, { onGround: !inWater, isInWater: inWater });
  for (let second = 0; second < 7; second++) {
    scene.lavaChanges();
    await scene.pass(1_000);
  }
  await scene.pass(1_000);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "still waiting at 8 s in water");
  await scene.pass(1_100);
  const finished = await output;
  assert.equal(scene.attempts.count, 2, "the settled wait resumes the action");
  assert.equal(finished.result.status, "succeeded");
  assert.doesNotMatch((finished.interruptions ?? []).join("|"), /REFLEX_LIMIT/);
});
}

test("rising in lava is progress, after sinking first", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  const { bot } = scene;
  const entered = bot.entity.position.y;
  bot.physicsEnabled = true;
  // The body sinks 1.4 blocks in the first second, as it does entering lava (no progress), then rises 0.1 every second.
  for (let tickNumber = 1; tickNumber <= 20; tickNumber++) {
    bot.entity.position.y = entered - (1.4 * tickNumber) / 20;
    await clock.advance(50);
  }
  const lowest = bot.entity.position.y;
  for (let second = 1; second <= 8; second++)
    for (let tickNumber = 0; tickNumber < 20; tickNumber++) {
      if (tickNumber === 0) bot.entity.position.y = lowest + 0.1 * second;
      await clock.advance(50);
    }
  bot.physicsEnabled = false;
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "9 s in the lava, rising: the claim is kept");
  bot.entity.position.y = entered;
  await scene.leavePit();
  const finished = await output;
  assert.doesNotMatch((finished.interruptions ?? []).join("|"), /REFLEX_LIMIT/, "no limit released the body while it rose");
  assert.equal(finished.result.status, "succeeded", "the action resumed once the body was out");
});

test("the escape facts read two rows below and three above the feet", async () => {
  const { bot, fake } = burningBesidePit(false);
  const before = fireEscapeFacts(bot).cells;
  assert.equal(before.length, 17 * 17 * 6, "17 x 17 columns, y -2 to +3");
  const origin = bot.entity.position.floored();
  fake.setCell(origin.offset(2, 3, 0), "stone");
  assert.notDeepEqual(fireEscapeFacts(bot).cells, before, "the row three above the feet is read");
  const withRowThree = fireEscapeFacts(bot).cells;
  fake.setCell(origin.offset(2, 4, 0), "stone");
  assert.deepEqual(fireEscapeFacts(bot).cells, withRowThree, "the row four above the feet is not");
});

test("an escape with no ticks is released after its 6 s window of world ticks (120 and one packet: 7 s at 20 tps)", async () => {
  const clock = createFakeClock({ mode: "manual" });
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  await scene.pass(6_800, false);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "6.8 s: the window is still open, it ends at the packet of age A + 140");
  await scene.pass(1_300, false); // the limit's check (7 s plus up to 250 ms), then the 500 ms grace
  const finished = await output;
  assert.match((finished.interruptions ?? []).join("|"), /\[REFLEX_LIMIT\] fire_reflex .*without progress/);
  assert.equal(scene.runner.status().owner, "idle");
});
