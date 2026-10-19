import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
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
  return { bot, world, reads: () => reads };
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

test("senses in one cell and one world revision search once", async () => {
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
