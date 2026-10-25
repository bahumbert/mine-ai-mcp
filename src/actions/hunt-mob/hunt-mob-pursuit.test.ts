// hunt_mob: pursuing loaded targets, target changes, drops on the ground and what the report says of the quarry.
import minecraftData from "minecraft-data";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { hunt } from "../../navigation/processes/hunting/hunt-process.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createCollectMobDropAction, formatHuntMobResult, gatherLoadedDrops, huntMob, type HuntMobDependencies } from "./hunt-mob.js";
import { died, outcome, dependencies, fakeCombat, huntBot, mob, fakeNavigation, droppedItem } from "./hunt-mob-fixtures.test.js";

test("fails truthfully when no matching mob is loaded", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /HUNT_TARGET_NOT_LOADED/);
  assert.equal(result.hunt.targetsEngaged, 0);
  assert.equal(result.hunt.gained, 0);
  assert.deepEqual(result.hunt.targets, []);
});

test("moves on to the next loaded target when one disappears without a death event", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const lost = mob(7, registry.entitiesByName.sheep.id, "sheep", 3);
  const next = mob(8, registry.entitiesByName.sheep.id, "sheep", 6);
  const bot = huntBot([lost, next], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, [{ outcome: outcome("target_lost", 2), deathPosition: null }, died(3, 6)]),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.targetsEngaged, 2);
  assert.equal(result.hunt.attacks, 5);
  assert.equal(result.hunt.targetDeathsObserved, 1);
});

test("gathers requested drops already on the ground before hunting", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.sheep.id, "sheep", 3);
  const bot = huntBot([target], inventory);
  let engaged = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      gatherLoadedDrops: async () => {
        inventory.count += 1;
        return 1;
      },
      engageTarget: async () => {
        engaged += 1;
        return died(1, 3);
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(engaged, 0);
});

test("gathers an observed requested item beyond the old eight-block cutoff", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([droppedItem(9, "white_wool", 1, new Vec3(20, 60, 0))], inventory);
  const navigate: NavigationRuntime["navigate"] = async () => {
    inventory.count++;
    return { status: "completed", elapsedMs: 0 };
  };
  const gathered = await gatherLoadedDrops(
    bot,
    { navigate } as NavigationRuntime,
    { name: "white_wool", id: bot.registry.itemsByName.white_wool!.id },
    {},
    createDiscardedItems(),
  );
  assert.equal(gathered, 1);
  assert.equal(inventory.count, 1);
});

test("an incidental kill's drop can complete a hunt even when the selected target disappears", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([mob(7, minecraftData("1.21.4").entitiesByName.sheep.id, "sheep", 3)], inventory);
  let fought = false;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      engageTarget: async () => {
        fought = true;
        return { outcome: outcome("target_lost", 2), deathPosition: null };
      },
      gatherLoadedDrops: async () => {
        if (fought) inventory.count = 1;
        return fought ? 1 : 0;
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 0, "pickup does not invent a death verdict on the selected mob");
});

test("reports the controller's verdict when a fight ends without a kill", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.blaze.id, "blaze", 9, "Hostile mobs");
  const bot = huntBot([target], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: true, observeForMs: 0, mobName: "blaze", dropName: "white_wool", count: 1 },
    {},
    // An unreachable fight is a stop on that target, not on the hunt: the one
    // loaded blaze is tried twice before the hunt gives it up.
    dependencies(bot, inventory, [
      {
        outcome: outcome("unreachable", 0, { observation: "Combat approach stopped: no route.", projectileGuards: 2 }),
        deathPosition: null,
      },
      {
        outcome: outcome("unreachable", 0, { observation: "Combat approach stopped: no route.", projectileGuards: 2 }),
        deathPosition: null,
      },
    ]),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /HUNT_APPROACH_STOPPED.*no route.*last observed at/);
  assert.equal(result.hunt.projectileGuards, 4);
});

test("a pursuit that never reached the mob says where it was and how far", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.rabbit.id, "rabbit", 65)], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "rabbit", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      pursue: async (pursuit) => {
        await pursuit.onTargets?.([{ id: 7, position: { x: 65, y: 64, z: 0 }, distance: 65 }]);
        return {
          status: "unreachable",
          reason: "no path; closest node was 30,64,0; the target was last observed at 65,64,0, 65.0 blocks away",
        };
      },
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /^\[HUNT_APPROACH_STOPPED\]/);
  assert.match(result.error, /last observed at 65,64,0, 65\.0 blocks away/);
  assert.deepEqual(result.hunt.targets, [{ species: "rabbit", id: 7, x: 65, y: 64, z: 0, distance: 65 }]);
});

test("a wounded hunt delegates recovery to the engagement instead of refusing the quantity request", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const target = mob(7, registry.entitiesByName.blaze.id, "blaze", 9, "Hostile mobs");
  const bot = huntBot([target], inventory, 6);
  let engaged = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: true, observeForMs: 0, mobName: "blaze", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      engageTarget: async () => {
        engaged += 1;
        return died(1, 9);
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(engaged, 1);
});

test("rejects unknown registry facts before selecting a target", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const unknownMob = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "imaginary_beast", dropName: "white_wool", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );
  const unknownDrop = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "imaginary_drop", count: 1 },
    {},
    dependencies(bot, inventory, []),
  );

  assert.equal(unknownMob.status, "failed");
  assert.match(unknownMob.error, /UNKNOWN_HUNT_MOB/);
  assert.equal(unknownDrop.status, "failed");
  assert.match(unknownDrop.error, /UNKNOWN_HUNT_DROP/);
});

for (const priorGain of [0, 1]) {
  test(`missing defensive build material ends the hunt with ${priorGain} prior drops, without trying another target`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.sheep.id;
    const bot = huntBot([mob(7, type, "sheep", 3), mob(8, type, "sheep", 5), mob(9, type, "sheep", 6)], inventory);
    const seen: number[] = [];
    const missing = "[COMBAT_BUILD_MATERIALS_MISSING] No usable building blocks remain for defensive construction.";
    const result = await huntMob(
      bot,
      { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 2 },
      {},
      {
        ...dependencies(bot, inventory, []),
        engageTarget: async (target) => {
          seen.push(target.id);
          return priorGain && target.id === 7
            ? died(2, 3)
            : {
                outcome: outcome("capability_blocked", 0, { reason: "building_materials", observation: missing }),
                deathPosition: null,
              };
        },
      },
    );
    assert.equal(result.status, priorGain ? "partial" : "failed");
    assert.match(result.error ?? "", /COMBAT_BUILD_MATERIALS_MISSING/);
    assert.deepEqual(seen, priorGain ? [7, 8] : [7]);
    assert.equal(result.hunt.gained, priorGain);
    assert.equal(result.hunt.retargets, priorGain);
  });
}

test("real pursuit reports selected target changes and the refusal that caused them", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.sheep.id;
  const bot = huntBot([mob(7, type, "sheep", 3), mob(8, type, "sheep", 5)], inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, []),
      pursue: (pursuit) =>
        hunt(bot, {
          ...pursuit,
          movements: {} as never,
          route: async () => {
            throw new Error("already in contact");
          },
        }),
      engageTarget: async (target) =>
        target.id === 7
          ? {
              outcome: outcome("unreachable", 0, { observation: "The target's roof opening is obstructed." }),
              deathPosition: null,
            }
          : died(2, 5),
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.retargets, 1);
  assert.equal(result.hunt.targetChanges[0]?.fromTargetId, 7);
  assert.equal(result.hunt.targetChanges[0]?.toTargetId, 8);
  assert.match(result.hunt.targetChanges[0]?.reason ?? "", /roof opening is obstructed/);
  assert.match(formatHuntMobResult(result), /retargets: 1/);
});

test("publishes the action as an intentional destructive task", () => {
  const action = createCollectMobDropAction(
    huntBot([], { count: 0 }),
    fakeNavigation,
    fakeCombat,
    createDiscardedItems(),
  );
  assert.equal(action.name, "collect_mob_drop");
  assert.equal(action.execution.kind, "resumable_task");
  assert.equal(action.annotations?.destructiveHint, true);
  assert.equal(action.annotations?.readOnlyHint, false);
});

test("evidence lists quarry as loaded at return, not as the pursuit once scanned it", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  const base = dependencies(bot, inventory, [died(4, 3)], 1);
  const effects: HuntMobDependencies = {
    ...base,
    engageTarget: async (...args: Parameters<HuntMobDependencies["engageTarget"]>) => {
      const engagement = await base.engageTarget(...args);
      // The kill unloads its victim and the survivor wanders before the report is written.
      delete bot.entities[7];
      bot.entities[8]!.position = new Vec3(9, 64, 0);
      return engagement;
    },
  };
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    effects,
  );
  assert.deepEqual(result.hunt.targets, [{ species: "sheep", id: 8, x: 9, y: 64, z: 0, distance: 9 }]);
  assert.match(formatHuntMobResult(result), /Loaded sheep at return: #8 at 9,64,0 \(9 blocks\)/);
});

test("the report rounds leftover drop positions and counts quarry beyond the nearest sixteen", () => {
  const targets = Array.from({ length: 20 }, (_, index) => ({
    species: "sheep",
    id: 100 + index,
    x: index + 1,
    y: 64,
    z: 0,
    distance: index + 1,
  }));
  const result: Parameters<typeof formatHuntMobResult>[0] = {
    status: "failed",
    termination: "no_loaded_targets",
    error: "none left",
    handoff: { observedAt: 1, kind: "safe", basis: "clear", position: { x: 0, y: 64, z: 0 } },
    hunt: {
      mob: "sheep",
      drop: "white_wool",
      requested: 1,
      gained: 0,
      inventoryBefore: 0,
      inventoryAfter: 0,
      targetsEngaged: 0,
      retargets: 0,
      targetChanges: [],
      targetDeathsObserved: 0,
      attacks: 0,
      combatStyles: [],
      projectileGuards: 0,
      otherDropsCollected: 0,
      drops: [
        {
          id: 24769,
          item: "bone",
          observedCount: 2,
          position: { x: 859.875, y: 84, z: 213.96969811989464 },
          blocks: { atPosition: "air", belowPosition: "air" },
          observedAt: "2026-09-14T13:35:24.184Z",
          firstSeen: "during_hunt",
          state: "loaded",
          collectedByBot: false,
          collectedByOther: false,
        },
      ],
      targets,
    },
  };
  const text = formatHuntMobResult(result);
  assert.match(text, /#24769 bone ×2 at 859.9,84,214 \(in air, above air; last seen 2026-09-14T13:35:24.184Z\)/);
  assert.match(text, /#115 at 16,64,0 \(16 blocks\); \+4 more farther away/);
  assert.doesNotMatch(text, /#116 at/);
});

test("a drop named without its colour is answered with the item ids that carry it, white first", async () => {
  // Live 2026-10-04: asked for "wool", the brain was told only that no such item exists.
  const { similarItemNames } = await import("./hunt-mob.js");
  const { bot } = createFakeBot();
  // The version's registry holds all sixteen wools (minecraft-data 1.21.4, the registry Mineflayer loads): white
  // first, then the rest alphabetically, five at most. The old hand registry held three.
  assert.deepEqual(similarItemNames(bot, "wool"), ["white_wool", "black_wool", "blue_wool", "brown_wool", "cyan_wool"]);
  assert.deepEqual(similarItemNames(bot, "unobtanium"), []);
});

test("an unknown drop is answered with its closest item ids, or with the drops of the mob it names", async () => {
  // Live run 15: [UNKNOWN_HUNT_DROP] raw_beef named no closest ids; `cow` as a drop got no mob answer.
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const hunt = async (dropName: string) => { const result = await huntMob(bot, { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "cow", dropName, count: 1 }, {}, dependencies(bot, inventory, [])); return result.status === "failed" ? result.error : ""; };
  assert.match(await hunt("raw_beef"), /UNKNOWN_HUNT_DROP\] .*raw_beef.*closest item ids are beef, cooked_beef/u);
  assert.match(await hunt("cow"), /UNKNOWN_HUNT_DROP\] cow is a mob, not an item: it drops beef, leather \(get_items beef hunts it\)/u);
});
