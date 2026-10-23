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
  type FakeBotOptions,
  type FakeCell,
  type FakeClock,
  createFakeBot,
  createFakeClock,
  flush,
} from "../../test-support/fake-bot/index.js";
import { ReflexDriver } from "../control/driver.js";
import { decideFireResponse } from "../policy/environment.js";
import { attachFireReflex } from "./fire.js";

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
});

/** The bot of every scene here: the fire escape releases item use before it walks. */
function fireBot(options: FakeBotOptions = {}) {
  return createFakeBot({
    ...options,
    // Not on the shared fake until M1 merges: the release of item use (a packet, no answer).
    overrides: { deactivateItem: () => undefined },
  });
}

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
  const { bot, clock } = fireBot();
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

test("a failed airborne fire escape does not suppress a fresh attempt after landing", async () => {
  const { bot, clock } = fireBot();
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const observe = () => clock.advance(250);
  await observe();
  const first = driver.answered.snapshot()[0];
  assert.equal(first?.failure.kind, "no_escape");
  await observe();
  assert.equal(driver.answered.snapshot()[0]?.id, first.id, "unchanged failure facts prevent repeated claims");
  bot.entity.onGround = true;
  await observe();
  assert.notEqual(driver.answered.snapshot()[0]?.id, first.id, "landing changes the escape's physical premises");
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
  const harness = fireBot({
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

test("a walk that outlasts the 15 s wall clock is reported as out of time, not as no escape", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, world } = burningBesidePit(false, { clock });
  // The body never moves, so 15 s of client ticks would end the walk as stalled (40 ticks) before the wall clock does.
  bot.physicsEnabled = false;
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, world));
  await tick(bot, 3);
  assert.equal(runner.status().activeAction?.action, "fire_reflex");
  await clock.advance(15_000);
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

test("lava still spreading after 10 s returns the action with the spreading message", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources, clock);
  const { output } = await scene.startInterrupted();
  await leavePitWhileLavaSpreads(scene);
  assert.equal(scene.attempts.count, 1);
  await scene.jump(10_000);
  const finished = await output;
  assert.equal(scene.attempts.count, 1, "the action was not resumed");
  assert.equal(finished.result.status, "cancelled");
  assert.match((finished.interruptions ?? []).join("|"), /still spreading/);
  assert.deepEqual(scene.driver.answered.snapshot(), [], "nothing is remembered for this outcome");
});

test("static lava resumes at once", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  await scene.leavePit();
  const finished = await output;
  assert.equal(scene.attempts.count, 2, "no lava changed in the volume: no wait");
  assert.equal(finished.result.status, "succeeded");
});

test("lava changes before the last two flow steps do not delay the resume", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.tickTo(1100);
  await scene.leavePit();
  assert.equal((await output).result.status, "succeeded", "the change at 1000 is 120 ticks old");
  assert.equal(scene.attempts.count, 2);
});

test("a new action gets the body after the spreading outcome returned the old one", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources, clock);
  const { output } = await scene.startInterrupted();
  await leavePitWhileLavaSpreads(scene);
  await scene.jump(10_000);
  assert.equal((await output).result.status, "cancelled");
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
  const again = await scene.runner.run(next, {});
  assert.equal(again.result.status, "succeeded");
  assert.ok(!scene.runner.status().activeAction, "the body is free again");
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

test("no escape in static lava is tried again 2 s later", async () => {
  const { bot, clock } = fireBot();
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  const runner = stillRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: clock.now }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  await clock.advance(250);
  const first = driver.answered.snapshot()[0];
  assert.equal(first?.failure.kind, "no_escape");
  await clock.advance(first.since + 1_999 - clock.now());
  assert.equal(driver.answered.snapshot()[0]?.id, first?.id, "the same lava within 2 s: still answered");
  await clock.advance(first.since + 2_001 - clock.now());
  assert.notEqual(driver.answered.snapshot()[0]?.id, first?.id, "still burning in the same cells: tried again");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "no_escape");
});

test("a throwing blockUpdate handler does not throw out of the emit", async () => {
  const { bot, clock } = fireBot();
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

test("lava that keeps advancing past the 10 s clock returns the action with the spreading message", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources, clock);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  scene.lavaSpreadsBesideTheBody();
  await scene.tickTo(scene.server.age + 20);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "walking away from the lava");
  await scene.jump(10_000);
  const finished = await output;
  assert.equal(scene.attempts.count, 1, "the action was not resumed");
  assert.equal(finished.result.status, "cancelled");
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

test("waiting on dry ground for lava to settle is progress: not cut at 6 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  // The lava keeps spreading for 7 s of the wait, so the world age alone does not settle it.
  for (let second = 0; second < 7; second++) {
    scene.lavaChanges();
    await scene.pass(1_000);
  }
  await scene.pass(1_000);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "still waiting at 8 s of the lava wait");
  assert.equal(scene.attempts.count, 1);
  await scene.pass(1_100);
  assert.equal((await output).result.status, "succeeded", "the lava settled: the action resumes");
});

test("the same wait with the body off the ground is cut at 6 s without progress", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  scene.bot.entity.onGround = false;
  for (let second = 0; second < 7; second++) {
    scene.lavaChanges();
    await scene.pass(1_000);
  }
  const finished = await output;
  assert.equal(scene.attempts.count, 1, "the action is not resumed");
  assert.match((finished.interruptions ?? []).join("|"), /\[REFLEX_LIMIT\] fire_reflex .*without progress/);
});

test("an escape with no ticks is released at 6 s", async () => {
  const clock = createFakeClock({ mode: "manual" });
  await using resources = new AsyncDisposableStack();
  const scene = limitedLavaScene(resources, clock);
  const { output } = await scene.startInterrupted();
  await scene.pass(5_900, false);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "5.9 s: the window is still open");
  await scene.pass(1_200, false);
  const finished = await output;
  assert.match((finished.interruptions ?? []).join("|"), /\[REFLEX_LIMIT\] fire_reflex .*without progress/);
  assert.equal(scene.runner.status().owner, "idle");
});
