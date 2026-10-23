import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { Budgets } from "../../survival/state/budgets.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { mobSourcesOf } from "../../world/mob-drops.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { huntMobOutcomes, parseHuntMobRequest } from "./contract.js";
import { createCollectMobDropAction, engageTarget, formatHuntMobResult, fruitlessKillLimit, huntMob, HUNT_FRUITLESS_KILLS, type HuntMobDependencies } from "./hunt-mob.js";
import { died, outcome, dependencies, fakeCombat, engagingCombat, huntBot, EntitySpec, mob, fakeNavigation, unseen, droppedItem } from "./hunt-mob-fixtures.test.js";

/** A harness bot that sees `targets` and nothing else of the hunt (engagement tests). */
function engagementBot(targets: readonly EntitySpec[]): Bot {
  return createFakeBot({ groundY: null, entities: Object.fromEntries(targets.map((target) => [target.id, target])) }).bot;
}

test("a hunt delegates health recovery to combat and preserves its terminal evidence", async () => {
  const bot = engagementBot([mob(7, 1, "blaze", 2, "Hostile mobs")]);
  const target = bot.entities[7]!;
  const combat = engagingCombat(bot, async (_id, signal) => {
    bot.health = 11;
    bot.emit("health");
    assert.equal(signal.aborted, false, "the hunt does not independently cancel combat recovery");
    return outcome("capability_blocked", 2, { reason: "recovery", observation: "No food remains." });
  });
  const result = await engageTarget(bot, combat, target, {});
  assert.equal(result.outcome.kind, "capability_blocked");
  assert.equal(result.outcome.attacks, 2);
  if (result.outcome.kind === "capability_blocked") assert.equal(result.outcome.reason, "recovery");
  assert.equal(bot.listenerCount("health"), 0);
  assert.equal(bot.listenerCount("entityDead"), 0);
});

test("the hostile fight boundary does not cancel a passive quarry engagement", async () => {
  const bot = engagementBot([mob(7, 1, "cow", 2)]);
  const combat = engagingCombat(bot, async (_id, signal) => {
    bot.health = 11;
    bot.emit("health");
    assert.equal(signal.aborted, false);
    return outcome("died", 2);
  });
  const result = await engageTarget(bot, combat, bot.entities[7]!, {});
  assert.equal(result.outcome.kind, "died");
});

test("quota attainment waits for handoff and cannot report success when withdrawal is unsafe", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const effects = dependencies(bot, inventory, []);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = false;
  const pending = huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...effects,
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        await waiting;
        return {
          observedAt: 1,
          kind: "unsafe",
          reason: "No withdrawal route or closed shelter was observed.",
          position: { x: 0, y: 64, z: 0 },
        };
      },
    },
  ).then((result) => {
    returned = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  release!();
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.termination, "quantity_collected");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.handoff.kind, "unsafe");
  assert.match(result.error ?? "", /HUNT_UNSAFE_HANDOFF/);
});

test("a completed quantity is checked again after handoff consumes it", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const result = await huntMob(
    bot,
    { mobName: "sheep", dropName: "white_wool", count: 1, campSpawner: false, allowWithoutShield: false, observeForMs: 0 },
    {},
    {
      ...dependencies(bot, inventory, []),
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        inventory.count = 0;
        return fakeCombat.finish(new AbortController().signal);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.termination, "inventory_changed");
  assert.equal(result.hunt.gained, 0);
});

for (const gainedDuringReflex of [false, true])
  test(`quarry observation retains its deadline and baseline through a reflex (gain: ${gainedDuringReflex})`, async () => {
    const inventory = { count: 4 };
    // The observation window reads Date.now and waits on the global timers: a mocked clock moves both.
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const bot = huntBot([], inventory, 20, { clock });
    const budgets = new Budgets();
    const action = createCollectMobDropAction(
      bot,
      fakeNavigation,
      fakeCombat,
      createDiscardedItems(),
      dependencies(bot, inventory, []),
      budgets,
    );
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 300 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const original = runner.request();
    assert.equal(budgets.snapshot()[0]?.name, "quarry_observation");
    const claim = runner.claim("hunger_reflex", "Eating while awaiting quarry", async () => {
      await new Promise<void>((resolve) => clock.after(350, resolve));
      if (gainedDuringReflex) inventory.count++;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await clock.settle(pending, 2_000);
    assert.equal(output.request?.id, original?.id);
    assert.ok("hunt" in output.result);
    if (!("hunt" in output.result)) return;
    assert.equal(output.result.hunt.inventoryBefore, 4);
    assert.equal(output.result.termination, gainedDuringReflex ? "quantity_collected" : "observation_exhausted");
    assert.deepEqual(budgets.snapshot(), []);
    assert.equal(bot.listenerCount("entitySpawn"), 0);
  });

for (const { reflexGain, dropName } of [
  { reflexGain: 0, dropName: "white_wool" },
  { reflexGain: 1, dropName: "white_wool" },
  { reflexGain: 0, dropName: "arrow" },
  { reflexGain: 1, dropName: "arrow" },
]) {
  test(`a resumed ${dropName} hunt counts prior drops and ${reflexGain} drops gained during the reflex`, async () => {
    const inventory = { count: 0 };
    const bot = huntBot([], inventory, 20, { dropName });
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let runs = 0;
    let entered!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pursue: HuntMobDependencies["pursue"] = async (pursuit) => {
      assert.equal(combat.policy.combat.bow, dropName !== "arrow");
      runs += 1;
      if (runs === 1) {
        inventory.count += 1;
        entered();
        await new Promise<void>((resolve) =>
          pursuit.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "stopped", reason: "reflex" };
      }
      while (!pursuit.isSatisfied()) inventory.count += 1;
      return { status: "satisfied", reason: null };
    };
    const action = createCollectMobDropAction(bot, fakeNavigation, combat, createDiscardedItems(), {
      ...dependencies(bot, inventory, []),
      pursue,
    });
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      {
        mob_name: dropName === "arrow" ? "skeleton" : "sheep",
        drop_name: dropName,
        count: 2,
        // The subject here is the arrow hunt's bow reserve, not the shield gate
        // a shieldless skeleton hunt would otherwise be refused by.
        allow_without_shield: true,
      },
    );
    await firstRun;
    const claim = runner.claim("hunger_reflex", "ate bread", async () => {
      assert.equal(combat.policy.snapshot().effective.combat.bow, dropName !== "arrow");
      inventory.count += reflexGain;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await pending;
    assert.equal(output.result.status, "succeeded");
    assert.equal(inventory.count, 2, "a count of two must not become three after one drop and a resumption");
    if (!("hunt" in output.result)) throw new Error("expected hunt evidence");
    assert.equal(output.result.hunt.inventoryBefore, 0);
    assert.equal(output.result.hunt.gained, 2);
    assert.equal(formatHuntMobResult(output.result).includes("Bow policy:"), dropName === "arrow");
    assert.equal(combat.policy.combat.bow, true, "request settlement releases the arrow reservation");
    assert.deepEqual(combat.policy.snapshot().overrides, [], "the hunt does not replace model policy");
  });
}

test("a terminal reflex interruption returns the hunt's uncollected drop sightings", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([droppedItem(99, "white_wool", 2, new Vec3(8, 63, 2))], inventory);
  const entity = unseen(bot, 99);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = createCollectMobDropAction(bot, fakeNavigation, fakeCombat, createDiscardedItems(), {
    ...dependencies(bot, inventory, []),
    pursue: async (pursuit) => {
      bot.entities[entity.id] = entity;
      bot.emit("itemDrop", entity);
      entered();
      await new Promise<void>((_resolve, reject) =>
        pursuit.signal!.addEventListener("abort", () => reject(pursuit.signal!.reason), { once: true }),
      );
      throw new Error("unreachable");
    },
  });
  const runner = new ActionRunner();
  const pending = runner.run(
    { ...action, execution: { kind: "resumable_task" } },
    { mob_name: "sheep", drop_name: "white_wool", count: 2 },
  );
  await ready;
  const claim = runner.claim("hostile_reflex", "withdrew from contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: null },
  }));
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  if (!("hunt" in output.result)) throw new Error("expected hunt evidence after interruption");
  assert.equal(output.result.status, "failed");
  assert.equal(output.result.hunt.gained, 0);
  assert.equal(output.result.hunt.drops[0]?.observedCount, 2);
  assert.equal(output.result.hunt.drops[0]?.collectedByBot, false);
  assert.equal(output.result.hunt.drops[0]?.state, "loaded");
  assert.equal(bot.listenerCount("itemDrop"), 0);
});

test("normalizes exact registry names and defaults to one requested drop", () => {
  assert.deepEqual(parseHuntMobRequest({ mob_name: "Minecraft:Sheep", drop_name: "White Wool" }), {
    campSpawner: false,
    allowWithoutShield: false,
    observeForMs: 0,
    mobName: "sheep",
    dropName: "white_wool",
    count: 1,
  });
});

test("hunts loaded targets until the requested inventory gain is observed", async () => {
  const inventory = { count: 4 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 2 },
    {},
    dependencies(bot, inventory, [died(4, 3), died(5, 5)], 1),
  );

  assert.deepEqual(result, {
    status: "succeeded",
    termination: "quantity_collected",
    handoff: { observedAt: 1, kind: "safe", basis: "clear", position: { x: 0, y: 64, z: 0 } },
    hunt: {
      mob: "sheep",
      drop: "white_wool",
      requested: 2,
      gained: 2,
      inventoryBefore: 4,
      inventoryAfter: 6,
      targetsEngaged: 2,
      retargets: 1,
      targetChanges: [
        {
          fromTargetId: 7,
          toTargetId: 8,
          position: { x: 5, y: 64, z: 0 },
          distance: 5,
          reason: "The previous engagement was completed.",
        },
      ],
      targetDeathsObserved: 2,
      attacks: 9,
      combatStyles: ["melee"],
      projectileGuards: 0,
      otherDropsCollected: 2,
      drops: [],
      targets: [
        { species: "sheep", id: 7, x: 3, y: 64, z: 0, distance: 3 },
        { species: "sheep", id: 8, x: 5, y: 64, z: 0, distance: 5 },
      ],
    },
  });
  assert.match(formatHuntMobResult(result), /white_wool 2\/2/);
  assert.match(formatHuntMobResult(result), /Loaded sheep at return: #7 at 3,64,0 \(3 blocks\); #8 at 5,64,0/);
});

for (const missed of ["item_gone", "not_collected"] as const)
test(`a ${missed} drop retires its kill and the hunt continues to the next loaded target`, async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  let pickups = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3), died(2, 5)]),
      collectDropAfterDeath: async () => {
        if (++pickups === 1) return missed === "item_gone" ? { kind: "item_gone" } :
          { kind: "not_collected", route: { status: "stopped", reason: "Placement cell occupied by Enderman", elapsedMs: 10 } };
        inventory.count++;
        return { kind: "collected" };
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 2);
  assert.equal(pickups, 2);
});

test("a hunt stops after the fruitless-kill limit and says the drop needs the mob to burn, or cooking the raw drop", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const sheep = Array.from({ length: HUNT_FRUITLESS_KILLS + 3 }, (_, i) => mob(7 + i, registry.entitiesByName.sheep.id, "sheep", 3 + i));
  const bot = huntBot(sheep, inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "cooked_mutton", count: 5 },
    {},
    {
      ...dependencies(bot, inventory, sheep.map((s) => died(2, s.position.x))),
      collectDropAfterDeath: async () => ({ kind: "item_gone" }),
    },
  );
  if (result.status === "succeeded") throw new Error("expected the hunt to stop");
  assert.equal(result.hunt.targetDeathsObserved, HUNT_FRUITLESS_KILLS);
  assert.match(result.error, /HUNT_DROP_NOT_GIVEN/);
  assert.match(result.error, new RegExp(`${HUNT_FRUITLESS_KILLS} sheep`));
  assert.match(result.error, /burn/);
  assert.match(result.error, /cook/);
});

test("the fruitless-kill limit is the kills after which getting nothing has under 1 % chance, 8 when the chance is unknown", () => {
  assert.equal(fruitlessKillLimit(0.5), 7);
  assert.equal(fruitlessKillLimit(0.025), 182);
  assert.equal(fruitlessKillLimit(0.1), 44);
  assert.equal(fruitlessKillLimit(1), HUNT_FRUITLESS_KILLS);
  assert.equal(fruitlessKillLimit(null), HUNT_FRUITLESS_KILLS);
  assert.equal(fruitlessKillLimit(0), HUNT_FRUITLESS_KILLS);
});

test("a drop with a known chance stops the hunt at that chance's limit and the message names the kills and the chance", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const chance = mobSourcesOf("rabbit_foot", "1.21.4").find((source) => source.mob === "rabbit")?.chance;
  assert.ok(chance !== undefined && chance < 1, "rabbit drops rabbit_foot at a chance in the shipped data");
  const limit = fruitlessKillLimit(chance);
  const rabbits = Array.from({ length: limit + 3 }, (_, i) => mob(7 + i, registry.entitiesByName.rabbit.id, "rabbit", 3 + i));
  const bot = huntBot(rabbits, inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "rabbit", dropName: "rabbit_foot", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, rabbits.map((r) => died(2, r.position.x))),
      collectDropAfterDeath: async () => ({ kind: "item_gone" }),
    },
  );
  if (result.status === "succeeded") throw new Error("expected the hunt to stop");
  assert.equal(result.hunt.targetDeathsObserved, limit);
  assert.match(result.error, /HUNT_DROP_NOT_GIVEN/);
  assert.match(result.error, new RegExp(`${limit} rabbit killed`));
  assert.match(result.error, new RegExp(`chance of ${chance * 100} % per kill`));
});

test("the fruitless-kill message of a sure drop calls it not picked up, not luck", () => {
  const text = huntMobOutcomes.dropNotGiven("cow", "leather", 8, 1);
  assert.doesNotMatch(text, /luck|chance|smelt/);
  assert.match(text, /not picked up/);
});

test("the fruitless-kill message of an unknown chance does not state one", () => {
  assert.doesNotMatch(huntMobOutcomes.dropNotGiven("sheep", "cooked_mutton", 8), /chance/);
  assert.match(huntMobOutcomes.dropNotGiven("sheep", "cooked_mutton", 8, 0.025), /2\.5 % per kill/);
});
