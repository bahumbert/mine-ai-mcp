import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { observeMineflayerBlock, type WorldView } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
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

test("burning with no reachable water does not lock a Nether fight out of the body", async () => {
  const bot = Object.assign(new EventEmitter(), {
    health: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), metadata: [1], isInLava: false },
    registry: { entitiesByName: { player: { metadataKeys: ["shared_flags"] } } },
    blockAt: () => ({ name: "air", boundingBox: "empty" }),
  }) as unknown as Bot;
  const runner = new ActionRunner();
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
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
  assert.equal(cancelled, false);
  assert.equal(runner.status().activeAction?.action, "hostile_reflex");
  release();
  await claim.outcome;
});

test("a failed airborne fire escape does not suppress a fresh attempt after landing", async () => {
  const bot = botFixture(
    {},
    {
      stopDigging() {},
      deactivateItem() {},
      clearControlStates() {},
    },
  );
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const observe = async () => {
    for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
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
function burningBesidePit(ringed: boolean) {
  const cells: Record<string, string> = { "0,64,0": "lava", "2,64,0": "water" };
  if (ringed)
    Object.assign(cells, {
      "2,64,0": "lava",
      "3,64,0": "water",
      "4,64,0": "lava",
      "3,64,1": "lava",
      "3,64,-1": "lava",
    });
  const bot = botFixture(
    { blocks: cells, groundY: 64, position: new Vec3(-0.5, 65, 0.5) },
    { stopDigging() {}, deactivateItem() {}, clearControlStates() {} },
  );
  Object.assign(bot.entity, { metadata: [1] });
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
  return { bot, world, memory, reads: () => reads };
}

test("a burning bot near reachable water is answered", async () => {
  const { bot, world } = burningBesidePit(false);
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, world));
  for (let tick = 0; tick < 3; tick++) bot.emit("physicsTick");
  assert.equal(runner.status().activeAction?.action, "fire_reflex", "the way round the lava is a reachable escape");
});

test("a still body in one world revision searches once", async () => {
  const { bot, world, reads } = burningBesidePit(true);
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, world));
  bot.emit("physicsTick");
  const afterFirst = reads();
  assert.ok(afterFirst > 0, "the first tick searches");
  for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
  assert.equal(reads(), afterFirst, "the same cell and revision read nothing more");
  assert.ok(!runner.status().activeAction, "water behind lava is no escape: the reflex stands down");
});

test("a walk that outlasts the 15 s wall clock is reported as out of time, not as no escape", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { bot, world } = burningBesidePit(false);
  Object.assign(bot, { setControlState() {} });
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner));
  resources.use(attachFireReflex(bot, driver, world));
  for (let tick = 0; tick < 3; tick++) bot.emit("physicsTick");
  assert.equal(runner.status().activeAction?.action, "fire_reflex");
  context.mock.timers.tick(15_000);
  for (let tick = 0; tick < 3; tick++) {
    bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const failure = driver.answered.snapshot()[0]?.failure;
  assert.equal(failure?.kind, "no_escape");
  assert.match(String(failure && "why" in failure ? failure.why : ""), /ran out of time/);
});

/**
 * A resumable action running while a burning body leaves a lava pit, in a world where lava can still spread: the
 * reflex claims the body, the escape ends on the first tick after `leavePit()`, then it waits for the lava. World
 * ages move in jumps of 20, as the server's time packets do.
 */
function lavaWaitScene(resources: AsyncDisposableStack) {
  const { bot, world, memory } = burningBesidePit(false);
  Object.assign(bot.entity, { isInLava: true });
  Object.assign(bot.time, { age: 1000 });
  const runner = new ActionRunner();
  const driver = resources.use(new ReflexDriver(bot, runner));
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
  const drain = async () => {
    for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const scene = {
    bot,
    runner,
    driver,
    attempts,
    drain,
    /** Starts the action and lets the reflex take the body from it: the bot is in the lava, burning. */
    async startInterrupted() {
      const output = runner.run(action, {});
      for (let turn = 0; turn < 50 && attempts.count < 1; turn++) await drain();
      bot.emit("physicsTick");
      await drain();
      assert.equal(runner.status().activeAction?.action, "fire_reflex", "the reflex has the body");
      return { output };
    },
    /** A lava level changes inside the reflex's scan volume at the current world age. */
    lavaChanges() {
      const at = bot.entity.position.floored().offset(2, 0, 0);
      const level = (offset: number) => ({ name: "lava", stateId: bot.time.age + offset, position: at }) as never;
      bot.emit("blockUpdate", level(0), level(1));
    },
    /** Lava of level 2 appears at the cell east of the body, in the bot's reads and in the escape's world. */
    lavaSpreadsBesideTheBody() {
      const at = bot.entity.position.floored().offset(1, 0, 0);
      const read = bot.blockAt.bind(bot);
      const lava = { name: "lava", position: at, stateId: 1, shapes: [], boundingBox: "empty", getProperties: () => ({ level: "2" }) };
      bot.blockAt = (cell) => (cell.equals(at) ? (lava as never) : read(cell));
      memory.load(at, observeMineflayerBlock(lava as never));
      bot.emit("blockUpdate", read(at), lava as never);
    },
    async tickTo(age: number) {
      for (let next = bot.time.age + 20; next <= age; next += 20) {
        bot.time.age = next;
        bot.emit("physicsTick");
        await drain();
      }
    },
    /** Out of the lava and not burning: the escape ends on the next tick. */
    async leavePit() {
      Object.assign(bot.entity, { isInLava: false, metadata: [0] });
      await scene.tickTo(bot.time.age + 20);
    },
  };
  return scene;
}

test("an escape from spreading lava resumes the action only after the lava settles", async () => {
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.tickTo(1020);
  scene.lavaChanges();
  await scene.leavePit();
  assert.equal(scene.bot.time.age, 1040);
  await scene.tickTo(1060);
  assert.equal(scene.attempts.count, 1, "age 1060: 40 ticks after the last change, 60 needed");
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "the reflex still holds the body");
  await scene.tickTo(1080);
  const finished = await output;
  assert.equal(scene.attempts.count, 2, "age 1080: two flow steps without a change");
  assert.equal(finished.result.status, "succeeded");
});

test("lava still spreading after 10 s returns the action with the spreading message", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  for (let step = 0; step < 5; step++) {
    scene.lavaChanges();
    await scene.tickTo(scene.bot.time.age + 20);
  }
  assert.equal(scene.attempts.count, 1);
  context.mock.timers.tick(10_000);
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
  scene.bot.time.age = 1000;
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

test("a new action gets the body after the spreading outcome returned the old one", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  for (let step = 0; step < 5; step++) {
    scene.lavaChanges();
    await scene.tickTo(scene.bot.time.age + 20);
  }
  context.mock.timers.tick(10_000);
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
  await scene.tickTo(scene.bot.time.age + 20);
  const finished = await output;
  assert.equal(scene.attempts.count, 1);
  assert.match((finished.interruptions ?? []).join("|"), /in danger again/);
});

test("no escape in static lava is tried again 2 s later", async () => {
  const bot = botFixture({}, { stopDigging() {}, deactivateItem() {}, clearControlStates() {} });
  Object.assign(bot.entity, { isInLava: true, onGround: false });
  let clock = 0;
  const runner = new ActionRunner();
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, runner, { now: () => clock }));
  resources.use(attachFireReflex(bot, driver, new MemoryWorld()));
  const observe = async () => {
    for (let tick = 0; tick < 5; tick++) bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await observe();
  const first = driver.answered.snapshot()[0];
  assert.equal(first?.failure.kind, "no_escape");
  clock = 1_999;
  await observe();
  assert.equal(driver.answered.snapshot()[0]?.id, first?.id, "the same lava within 2 s: still answered");
  clock = 2_001;
  await observe();
  assert.notEqual(driver.answered.snapshot()[0]?.id, first?.id, "still burning in the same cells: tried again");
  assert.equal(driver.answered.snapshot()[0]?.failure.kind, "no_escape");
});

test("a throwing blockUpdate handler does not throw out of the emit", async () => {
  const bot = botFixture({}, { stopDigging() {}, deactivateItem() {}, clearControlStates() {} });
  await using resources = new AsyncDisposableStack();
  const driver = resources.use(new ReflexDriver(bot, new ActionRunner()));
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
  await scene.tickTo(scene.bot.time.age + 20);
  assert.equal(scene.attempts.count, 1, "the action is not returned: the escape runs again");
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "still the same hold on the body");
  scene.bot.entity.position.set(-2.5, 65, 0.5);
  await scene.tickTo(scene.bot.time.age + 20);
  assert.equal(scene.attempts.count, 1, "safe again, but the lava changed only just now");
  await scene.tickTo(scene.bot.time.age + 80);
  assert.equal((await output).result.status, "succeeded", "resumed once two flow steps passed with no change");
  assert.equal(scene.attempts.count, 2);
});

test("lava that keeps advancing past the 10 s clock returns the action with the spreading message", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  await using resources = new AsyncDisposableStack();
  const scene = lavaWaitScene(resources);
  const { output } = await scene.startInterrupted();
  scene.lavaChanges();
  await scene.leavePit();
  scene.lavaSpreadsBesideTheBody();
  await scene.tickTo(scene.bot.time.age + 20);
  assert.equal(scene.runner.status().activeAction?.action, "fire_reflex", "walking away from the lava");
  context.mock.timers.tick(10_000);
  const finished = await output;
  assert.equal(scene.attempts.count, 1, "the action was not resumed");
  assert.equal(finished.result.status, "cancelled");
});
