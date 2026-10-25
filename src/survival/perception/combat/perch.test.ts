import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { TestEndCombat as EndCombat } from "../../../test-support/combat.js";
import { createFakeBot, entityBodyOf } from "../../../test-support/fake-bot/index.js";
import { PerchObservation } from "./perch.js";
import { PerchPreparation } from "./perch-preparation.js";

import type { NavigationRuntime } from "../../../navigation/index.js";
import type { FootingRecovery } from "../../responses/footing.js";
import { observeMineflayerBlock } from "../../../navigation/mineflayer/world.js";

const fountain = { "0,64,0": "bedrock", "0,65,0": "bedrock", "0,66,0": "bedrock", "0,67,0": "bedrock",
  "3,64,0": "bedrock", "-3,64,0": "bedrock", "0,64,3": "bedrock", "0,64,-3": "bedrock" };
function preparationWorld(bot: Bot): NavigationRuntime["world"] {
  return { blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!) } as NavigationRuntime["world"];
}

/** An ender dragon #42 at `position` with its phase and health at their metadata indices, as a new body each call. */
function dragonAt(bot: Bot, position: Vec3, phase: number | undefined, health: number): void {
  const keys = bot.registry.entitiesByName.ender_dragon!.metadataKeys!;
  const metadata: unknown[] = [];
  metadata[keys.indexOf("phase")] = phase;
  metadata[keys.indexOf("health")] = health;
  bot.entities[42] = entityBodyOf(42, { name: "ender_dragon", position, metadata });
}

test("takeoff and cooldown observed during suspension cannot start a second perch", async () => {
  const { bot, clock } = createFakeBot({ dimension: "the_end", position: new Vec3(30, 64, 30), overrides: { deactivateItem: () => {} } });
  const phase = bot.registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("phase");
  const health = bot.registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("health");
  dragonAt(bot, new Vec3(0, 65, 0), 5, 200);
  const dragon = { metadata: bot.entities[42]!.metadata as unknown[] };
  using observation = new PerchObservation(bot, 42);
  observation.swung(13);
  for (let tick = 0; tick < 13; tick++) bot.emit("physicsTick");
  assert.equal(observation.ready, true);
  dragon.metadata[phase] = undefined;
  bot.emit("entityUpdate", bot.entities[42]!);
  assert.equal(observation.ended, false, "unknown phase is not takeoff");
  dragon.metadata[phase] = 4;
  dragon.metadata[health] = 190;
  bot.emit("entityUpdate", bot.entities[42]!);
  dragon.metadata[phase] = 5;
  bot.emit("physicsTick");
  const ending = new EndCombat(bot, {} as NavigationRuntime, {} as FootingRecovery).perch(
    42,
    new AbortController().signal,
    observation,
  );
  await clock.advance(3_000); // the server's ticks run while the perch waits for them
  const result = await ending;
  assert.equal(result.outcome, "perch_ended");
  assert.equal(result.attacks, 1);
  assert.equal(result.healthBefore, 200);
  assert.equal(result.healthAfter, 190);
});

for (const change of ["identity", "dimension"] as const) {
  test(`a ${change} change cannot credit another dragon's death or perch`, async () => {
    const { bot, combat } = createFakeBot({ dimension: "the_end" });
    const keys = bot.registry.entitiesByName.ender_dragon!.metadataKeys!;
    dragonAt(bot, new Vec3(0, 65, 0), 5, 200);
    using observation = new PerchObservation(bot, 42);
    observation.swung(13);
    if (change === "identity") dragonAt(bot, new Vec3(0, 65, 0), 5, 200);
    else bot.game.dimension = "the_nether";
    const metadata: unknown[] = bot.entities[42]!.metadata;
    metadata[keys.indexOf("phase")] = 4;
    combat.kill(42);
    bot.emit("physicsTick");
    assert.equal(observation.died, false);
    assert.equal(observation.ended, false);
    const result = await new EndCombat(bot, {} as NavigationRuntime, {} as FootingRecovery).perch(
      42,
      new AbortController().signal,
      observation,
    );
    assert.equal(result.outcome, "stopped");
    assert.equal(result.attacks, 1);
    assert.equal(result.healthAfter, 200);
  });
}

test("landing interrupts preparation and a resumed request cannot begin another excavation", async () => {
  const { bot } = createFakeBot({ dimension: "the_end", groundY: null, cells: fountain });
  const keys = bot.registry.entitiesByName.ender_dragon!.metadataKeys!;
  dragonAt(bot, new Vec3(20, 100, 0), 0, 190);
  const metadata: unknown[] = bot.entities[42]!.metadata;
  bot.findBlocks = () => [new Vec3(0, 64, 0)];
  using observation = new PerchObservation(bot, 42);
  observation.preparationTarget = new Vec3(0, 60, 6);
  let moves = 0;
  const navigation = {
    world: preparationWorld(bot),
    navigate: async ({ stopSignal }: { stopSignal: AbortSignal }) => {
      moves++;
      metadata[keys.indexOf("phase")] = 2;
      bot.emit("physicsTick");
      assert.equal(stopSignal.aborted, true, "the current dig/route loses authority on landing");
      return { status: "cancelled", reason: "landing observed" };
    },
  } as unknown as NavigationRuntime;
  const combat = new EndCombat(bot, navigation, { needed: false } as FootingRecovery);
  const result = await combat.preparePerch(42, new AbortController().signal, observation);
  assert.equal(result.outcome, "perch_approaching");
  assert.equal(result.attacks, 0);
  assert.equal(observation.preparedPosition, null, "a partial passage is not ready");
  metadata[keys.indexOf("phase")] = 0;
  const resumed = await combat.preparePerch(42, new AbortController().signal, observation);
  assert.equal(resumed.outcome, "stopped");
  assert.match(resumed.reason!, /has since left that phase/);
  assert.equal(moves, 1, "the retained landing event cannot start another preparation");
});

test("damage remains latched after regeneration so resumption cannot excavate again", async () => {
  const { bot } = createFakeBot({ dimension: "the_end", groundY: null, cells: fountain });
  dragonAt(bot, new Vec3(20, 100, 0), 0, 190);
  bot.findBlocks = () => [new Vec3(0, 64, 0)];
  bot.health = 12;
  using observation = new PerchObservation(bot, 42);
  bot.health = 20;
  bot.emit("physicsTick");
  observation.preparationTarget = new Vec3(0, 60, 6);
  let moves = 0;
  const navigation = {
    world: preparationWorld(bot),
    navigate: async () => {
      moves++;
      bot.health = 17;
      bot.emit("physicsTick");
      bot.health = 20;
      return { status: "cancelled", reason: "damage takeover" };
    },
  } as unknown as NavigationRuntime;
  const combat = new EndCombat(bot, navigation, { needed: false } as FootingRecovery);

  const damaged = await combat.preparePerch(42, new AbortController().signal, observation);
  assert.equal(damaged.outcome, "stopped");
  assert.match(damaged.reason!, /PERCH_PREPARATION_DAMAGED/);
  assert.equal(observation.preparationDamaged, true);
  const resumed = await combat.preparePerch(42, new AbortController().signal, observation);
  assert.equal(resumed.outcome, "stopped");
  assert.match(resumed.reason!, /PERCH_PREPARATION_DAMAGED/);
  assert.equal(moves, 1, "regeneration cannot erase request-lifetime damage or start another excavation");
});

test("preparation opens and re-observes one staging sightline before reporting ready", async () => {
  const blocks = {
    "0,64,0": "bedrock", "0,65,0": "bedrock", "0,66,0": "bedrock", "0,67,0": "bedrock",
    "3,64,0": "bedrock", "-3,64,0": "bedrock", "0,64,3": "bedrock", "0,64,-3": "bedrock",
    "6,60,0": "end_stone", "4,64,-1": "end_stone",
  };
  const { bot, world } = createFakeBot({ dimension: "the_end", position: new Vec3(12.5, 61, 0.5), groundY: null, cells: blocks });
  dragonAt(bot, new Vec3(20, 100, 0), 0, 190);
  bot.findBlocks = () => [new Vec3(0, 64, 0)];
  bot.blockAtCursor = () => null;
  // Reproduce the native mismatch: blockAtCursor starts at entity.height and
  // misses, while the preparation ray from eyeHeight intersects the roof.
  let moves = 0;
  let cleared = 0;
  let clearedPosition: Vec3 | null = null;
  const navigation = {
    world: preparationWorld(bot),
    navigate: async () => {
      moves++;
      bot.entity.position = new Vec3(6.5, 61, 0.5);
      return { status: "completed" };
    },
    breakBlockInPlace: async ({ position }: { position: Vec3 }) => {
      cleared++;
      clearedPosition = position;
      world.setCell(new Vec3(4, 64, -1), "air");
      return { status: "broken" };
    },
  } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  const result = await new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .preparePerch(42, new AbortController().signal, observation);

  assert.equal(result.outcome, "perch_ready");
  assert.deepEqual(observation.preparationTarget, new Vec3(6, 61, 0), "nearest cardinal notch is outside the fountain");
  assert.deepEqual(observation.preparedPosition, new Vec3(6.5, 61, 0.5));
  assert.equal(observation.stage, "ready");
  assert.equal(cleared, 1);
  assert.deepEqual(clearedPosition, new Vec3(4, 64, -1), "the fountain-facing neighboring row is part of the small rim");
  assert.equal(moves, 14, "cut from the surface downward, re-observe the ray, then verify the ascent and return");
});

test("preparation retains the selected notch across calls but not across dragon identities or dimensions", () => {
  const { bot } = createFakeBot({ dimension: "the_end" });
  dragonAt(bot, new Vec3(0, 100, 0), 0, 200);
  const preparation = new PerchPreparation();
  using first = new PerchObservation(bot, 42);
  first.preparationTarget = new Vec3(6, 61, 0);
  first.preparedPosition = new Vec3(6.5, 61, 0.5);
  preparation.retain(first);
  bot.entity.position = new Vec3(-6.5, 64, 0.5);
  using second = new PerchObservation(bot, 42);
  preparation.restore(second);
  assert.deepEqual(second.preparationTarget, first.preparationTarget);
  assert.notEqual(second.preparationTarget, first.preparationTarget);
  dragonAt(bot, new Vec3(0, 100, 0), 0, 200);
  using replacement = new PerchObservation(bot, 42);
  preparation.restore(replacement);
  assert.equal(replacement.preparationTarget, null);
  preparation.retain(first);
  bot.game.dimension = "the_nether";
  using elsewhere = new PerchObservation(bot, 42);
  preparation.restore(elsewhere);
  assert.equal(elsewhere.preparationTarget, null);
});

test("preparation reports the first sightline block when it is beyond digging reach", async () => {
  const blocks = {
    "0,64,0": "bedrock", "0,65,0": "bedrock", "0,66,0": "bedrock", "0,67,0": "bedrock",
    "3,64,0": "bedrock", "-3,64,0": "bedrock", "0,64,3": "bedrock", "0,64,-3": "bedrock",
    "6,60,0": "end_stone", "2,68,0": "end_stone",
  };
  const { bot } = createFakeBot({ dimension: "the_end", position: new Vec3(6.5, 61, 0.5), groundY: null, cells: blocks });
  dragonAt(bot, new Vec3(20, 100, 0), 0, 190);
  bot.findBlocks = () => [new Vec3(0, 64, 0)];
  const distantHit = Object.assign(bot.blockAt(new Vec3(2, 68, 0))!, { x: 2, y: 68, z: 0, face: 0, intersect: new Vec3(2.5, 67, 0.5) });
  bot.world.raycast = () => distantHit;
  let breaks = 0;
  const navigation = {
    world: preparationWorld(bot),
    navigate: async () => ({ status: "completed" }),
    breakBlockInPlace: async () => { breaks++; return { status: "broken" }; },
  } as unknown as NavigationRuntime;
  using observation = new PerchObservation(bot, 42);
  observation.preparationTarget = new Vec3(6, 61, 0);
  const result = await new EndCombat(bot, navigation, { needed: false } as FootingRecovery)
    .preparePerch(42, new AbortController().signal, observation);

  assert.equal(result.outcome, "stopped");
  assert.match(result.reason!, /PERCH_SIGHTLINE_OUT_OF_REACH.*2, 68, 0.*5\.93.*4\.50/);
  assert.equal(breaks, 0, "an out-of-reach ray hit is never sent to the digging primitive");
});

test("preparation reports breath inside its intended passage before attempting an impossible route", async () => {
  const { bot } = createFakeBot({
    dimension: "the_end",
    position: new Vec3(20.5, 65, 0.5),
    entities: { 43: { name: "area_effect_cloud", position: new Vec3(0.5, 62, 0.5), metadata: { 8: 5, 10: { type: "dragon_breath" } } } },
  });
  dragonAt(bot, new Vec3(0, 100, 0), 0, 190);
  using observation = new PerchObservation(bot, 42);
  observation.preparationTarget = new Vec3(0, 61, 0);
  const navigation = { navigate: () => { throw new Error("A clouded destination must be reported before navigation"); } } as unknown as NavigationRuntime;
  const result = await new EndCombat(bot, navigation, { needed: false } as FootingRecovery).preparePerch(42, new AbortController().signal, observation);
  assert.equal(result.outcome, "stopped");
  assert.equal(result.attacks, 0);
  assert.match(result.reason!, /^\[PERCH_PASSAGE_CLOUDED\].*#43.*wait for cloud clearance/);
  assert.equal(result.perch?.blockedBy, result.reason);
});
