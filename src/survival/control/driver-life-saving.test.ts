// A settled reflex leaves its emergency blocks to the next safe body owner.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { pickUpPlacedWater } from "../../actions/use-bucket/use-bucket.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { confirmFakeDigs } from "../../test-support/life-saving-placements.js";
import * as placements from "../../world/life-saving-placements.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { ReflexDriver } from "./driver.js";
import type { SurvivalTransition } from "./contract.js";

/** Keep the real idle driver ticking without introducing another danger in cleanup scheduling tests. */
function registerIdleCleanup(driver: ReflexDriver): void {
  driver.register({
    name: "recover_footing", sense: () => null, decide: () => ({ kind: "handled", by: "safe" }),
    facts: () => ({ capability: "footing", response: "landing", scope: "cell", facts: () => null, permissions: () => null }),
    limits: () => ({ ceilingMs: 60_000, noProgressMs: 60_000, standDownMs: 2_000 }),
    act: async () => true, failure: () => null, continuation: () => ({ kind: "resume" }), describe: () => null,
  });
}

test("nothing is removed during a reflex; after settlement a safe tick removes its block once", async () => {
  const fixture = createFakeBot({
    gameMode: "creative", clock: createFakeClock({ mode: "mocked" }), cells: { "2,64,0": "cobblestone" },
    position: { x: 0.5, y: 64, z: 0.5 },
  });
  const { bot, clock, world } = fixture;
  confirmFakeDigs(fixture);
  using _timers = clock.install();
  const runner = new ActionRunner();
  await using driver = new ReflexDriver(bot, runner);
  setProtectedRegionsProvider(bot, () => [{
    regionId: 9, owner: "Tom", label: "garden", dimension: "overworld",
    min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 64, z: 0 },
  }]);
  let danger = true;
  let finish!: () => void;
  driver.register({
    name: "recover_footing",
    sense: () => danger ? { kind: "observed", danger: true, evidence: true } : null,
    decide: () => ({ kind: "respond", response: true, name: "landing", reason: "Falling" }),
    facts: () => ({ capability: "footing", response: "landing", scope: "cell", facts: () => null, permissions: () => null }),
    limits: () => ({ ceilingMs: 60_000, noProgressMs: 60_000, standDownMs: 2_000 }),
    act: async () => {
      placements.recordLifeSavingPlacement(bot, new Vec3(2, 64, 0), "block");
      await new Promise<void>((resolve) => { finish = resolve; });
      return "landed";
    },
    failure: () => null, continuation: () => ({ kind: "resume" }), describe: () => null,
  });
  await clock.advance(200);
  assert.equal(world.blockAt(new Vec3(2, 64, 0))?.name, "cobblestone");
  danger = false;
  finish();
  await clock.advance(500);
  assert.equal(world.blockAt(new Vec3(2, 64, 0))?.name, "air");
  assert.equal(runner.ownership().current, null);
  assert.deepEqual(placements.pendingLifeSavingPlacements(bot), []);
});

test("death retains the ledger until respawn's safe tick, then distance failure is told and saved", async () => {
  const fixture = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), cells: { "2,64,0": "cobblestone" },
    position: { x: 0.5, y: 64, z: 0.5 },
  });
  const { bot, clock, combat } = fixture;
  using data = temporaryBotData();
  using _timers = clock.install();
  placements.setLifeSavingRemovalContext(bot, { data });
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  registerIdleCleanup(driver);
  setProtectedRegionsProvider(bot, () => [{
    regionId: 9, owner: "Tom", label: "garden", dimension: "overworld",
    min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 64, z: 0 },
  }]);
  placements.recordLifeSavingPlacement(bot, new Vec3(2, 64, 0), "block");
  combat.setHealth(0);
  await clock.advance(200);
  assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1);
  combat.setHealth(20);
  bot.entity.position.x = -20;
  bot.emit("respawn");
  bot.entity.onGround = false;
  bot.physicsEnabled = false;
  bot.emit("physicsTick");
  assert.equal(data.read("SELECT * FROM notes").length, 0);
  bot.entity.onGround = true;
  bot.emit("physicsTick");
  await clock.advance(100);
  assert.equal(data.read("SELECT * FROM notes").length, 1);
  assert.ok(JSON.stringify(events.filter((event) => event.kind === "outcome")).includes("owner Tom"));
  for (let tick = 0; tick < 3; tick++) {
    bot.emit("physicsTick");
    await clock.advance(100);
  }
  assert.equal(events.filter(event => JSON.stringify(event).includes("placements_left")).length, 1, "one failed stance does not busy-loop cleanup");
  bot.entity.position.x = 0.5;
  bot.game.gameMode = "creative";
  // Mineflayer clears diggingCompleted listeners at death; install this server receipt for the new life.
  confirmFakeDigs(fixture);
  bot.emit("physicsTick");
  await clock.advance(500);
  assert.deepEqual(placements.pendingLifeSavingPlacements(bot), []);
  assert.equal(bot.blockAt(new Vec3(2, 64, 0))?.name, "air");
});

for (const change of ["respawn", "bucket", "terrain"] as const) {
  test(`retained cleanup retries at the same stance after ${change}`, async () => {
    const water = change === "bucket";
    const fixture = createFakeBot({
      clock: createFakeClock({ mode: "mocked" }), gameMode: water ? "survival" : "creative",
      cells: { "2,64,0": water ? "water" : "cobblestone", ...(change === "terrain" ? { "1,64,0": "stone", "1,65,0": "stone" } : {}) },
      position: { x: 0.5, y: 64, z: 0.5 },
    });
    const { bot, clock, world, combat, inventory } = fixture;
    using data = temporaryBotData();
    using _timers = clock.install();
    await using driver = new ReflexDriver(bot, new ActionRunner(), { lifeSaving: { data } });
    registerIdleCleanup(driver);
    setProtectedRegionsProvider(bot, () => [{
      regionId: 9, owner: "Tom", label: "garden", dimension: "overworld",
      min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 64, z: 0 },
    }]);
    const cell = new Vec3(2, 64, 0);
    const dig = bot.dig;
    if (change === "respawn") bot.dig = async () => { throw new Error("the old life's dig was rejected"); };
    if (water) placements.setLifeSavingWaterHook(bot, (at, signal) => pickUpPlacedWater(bot, at, signal));
    placements.recordLifeSavingPlacement(bot, cell, water ? "water" : "block");
    await clock.advance(300);
    assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1, `${change}: first failure retains the entry`);
    assert.equal(data.read("SELECT * FROM notes").length, 1);
    if (change === "respawn") {
      bot.physicsEnabled = false;
      combat.setHealth(0);
      await clock.advance(2_000);
      bot.dig = dig;
      bot.entity.position.set(0.5, 64, 0.5);
      bot.entity.onGround = true;
    } else if (water) {
      setCarriedCount(inventory, bot.registry, bot.registry.itemsByName.bucket!.id, 1);
    } else {
      world.setCell(new Vec3(1, 64, 0), "air");
      world.setCell(new Vec3(1, 65, 0), "air");
    }
    confirmFakeDigs(fixture);
    bot.emit("physicsTick");
    await clock.advance(1_000);
    assert.equal(bot.blockAt(cell)?.name, "air", `${change}: the next safe moment removes the cell without moving`);
    assert.deepEqual(placements.pendingLifeSavingPlacements(bot), []);
  });
}

test("failed cleanup ignores unrelated ticks and supplies, retrying only within eight blocks or for cleanup supplies", async () => {
  const { bot, clock, world, inventory } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), cells: { "2,64,0": "water" },
    position: new Vec3(0.5, 64, 0.5),
  });
  using data = temporaryBotData();
  using _timers = clock.install();
  const runner = new ActionRunner();
  await using driver = new ReflexDriver(bot, runner, { lifeSaving: { data } });
  registerIdleCleanup(driver);
  setProtectedRegionsProvider(bot, () => [{
    regionId: 9, owner: "Tom", label: "garden", dimension: "overworld",
    min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 64, z: 0 },
  }]);
  const events: SurvivalTransition[] = [];
  driver.onTransition(event => events.push(event));
  placements.recordLifeSavingPlacement(bot, new Vec3(2, 64, 0), "water");
  const failures = () => events.filter(event => JSON.stringify(event).includes("placements_left")).length;
  await clock.advance(200);
  assert.equal(failures(), 1);
  for (let tick = 0; tick < 5; tick++) {
    world.setCell(new Vec3(11, 64, 0), tick % 2 ? "air" : "stone");
    setCarriedCount(inventory, bot.registry, bot.registry.itemsByName.stick!.id, tick + 1);
    await clock.advance(50);
    assert.equal(runner.ownership().current, null);
  }
  assert.equal(failures(), 1, "reach+1 updates and unrelated supplies do not claim the body again");
  world.setCell(new Vec3(10, 64, 0), "stone");
  await clock.advance(100);
  assert.equal(failures(), 2, "an update at the ledger's eight-block boundary retries");
  for (const name of ["bucket", "cobblestone"]) {
    setCarriedCount(inventory, bot.registry, bot.registry.itemsByName[name]!.id, 1);
    await clock.advance(100);
  }
  assert.equal(failures(), 4, "buckets and building blocks retry cleanup");
});

test("failed cleanup remembers its travelled route and ignores changes beyond that route's reach", async () => {
  const { bot, clock, world } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), position: new Vec3(0.5, 64, 0.5),
    cells: { "2,64,0": "cobblestone", "1,64,0": "stone", "1,65,0": "stone" },
  });
  using data = temporaryBotData();
  using _timers = clock.install();
  bot.physicsEnabled = false;
  await using driver = new ReflexDriver(bot, new ActionRunner(), { lifeSaving: {
    data, navigate: async () => {
      bot.entity.position.set(-4.5, 64, 0.5);
      bot.emit("physicsTick");
      bot.entity.position.set(0.5, 64, 0.5);
      return { status: "stopped", reason: "no_path", elapsedMs: 0 };
    },
  } });
  registerIdleCleanup(driver);
  setProtectedRegionsProvider(bot, () => [{
    regionId: 9, owner: "Tom", label: "garden", dimension: "overworld",
    min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 64, z: 0 },
  }]);
  const events: SurvivalTransition[] = [];
  driver.onTransition(event => events.push(event));
  placements.recordLifeSavingPlacement(bot, new Vec3(2, 64, 0), "block");
  const failures = () => events.filter(event => JSON.stringify(event).includes("placements_left")).length;
  bot.emit("physicsTick");
  await clock.advance(100);
  assert.equal(failures(), 1);
  world.setCell(new Vec3(-14, 64, 0), "stone");
  bot.emit("physicsTick");
  await clock.advance(100);
  assert.equal(failures(), 1, "reach+1 from the route cannot restart cleanup");
  world.setCell(new Vec3(-13, 64, 0), "stone");
  bot.emit("physicsTick");
  await clock.advance(100);
  assert.equal(failures(), 2, "eight blocks from a travelled cell retries even far from the ledger and current stance");
});
