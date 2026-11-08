// A settled reflex leaves its emergency blocks to the next safe body owner.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { confirmFakeDigs } from "../../test-support/life-saving-placements.js";
import * as placements from "../../world/life-saving-placements.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { ReflexDriver } from "./driver.js";
import type { SurvivalTransition } from "./contract.js";

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
  const { bot, clock, combat } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), cells: { "2,64,0": "cobblestone" },
    position: { x: 0.5, y: 64, z: 0.5 },
  });
  using data = temporaryBotData();
  using _timers = clock.install();
  placements.setLifeSavingRemovalContext(bot, { data });
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  driver.register({
    name: "recover_footing", sense: () => null, decide: () => ({ kind: "handled", by: "safe" }),
    facts: () => ({ capability: "footing", response: "landing", scope: "cell", facts: () => null, permissions: () => null }),
    limits: () => ({ ceilingMs: 60_000, noProgressMs: 60_000, standDownMs: 2_000 }),
    act: async () => true, failure: () => null, continuation: () => ({ kind: "resume" }), describe: () => null,
  });
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
});
