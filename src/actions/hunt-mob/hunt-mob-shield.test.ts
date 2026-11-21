// hunt_mob: the shield gate of a hostile hunt.
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { itemOf } from "../../test-support/fake-bot/index.js";
import { parseHuntMobRequest, type HuntMobRequest } from "./contract.js";
import { huntMob, huntMobDependencies } from "./hunt-mob.js";
import { shieldRefusal } from "./shield-gate.js";
import { died, dependencies, pursueLoaded, fakeCombat, huntBot, harnesses, mob, fakeNavigation, unseen } from "./hunt-mob-fixtures.test.js";

// The shield gate. The refusal's whole value is that it lands before the bot
// walks up to the thing, so the first test counts pursuits as well as reading
// the verdict; a stop reported after the approach would be a later, lesser fact.

/** The bot's carried shields, in its harness's inventory window. */
const shields = (bot: Bot) => carriedCountField(harnesses.get(bot)!, "shield");

/** A shield loose in the inventory, which is what the loadout equips from. */
function carryingShield(bot: Bot): Bot {
  shields(bot).count = 1;
  return bot;
}

/** The carried shield gone (broken), as the server empties its slot. */
function loseShield(bot: Bot): void {
  shields(bot).count = 0;
}

function huntRequest(mobName: string, allowWithoutShield = false): HuntMobRequest {
  return { campSpawner: false, allowWithoutShield, observeForMs: 0, mobName, dropName: "white_wool", count: 1 };
}

/** A skeleton by `kind`, a hoglin only by the registry category its `type` contradicts. */
for (const mobName of ["skeleton", "hoglin"])
  test(`a shieldless ${mobName} hunt is refused before the pursuit takes a step`, async () => {
    const inventory = { count: 0 };
    const registry = minecraftData("1.21.4");
    const bot = huntBot([mob(7, registry.entitiesByName[mobName]!.id, mobName, 3, "Hostile mobs")], inventory);
    let pursued = 0;
    const result = await huntMob(bot, huntRequest(mobName), {}, {
      ...dependencies(bot, inventory, []),
      pursue: async (pursuit) => {
        pursued += 1;
        return pursueLoaded(bot)(pursuit);
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.termination, "shield_required");
    assert.match(result.error, /HUNT_NO_SHIELD/);
    assert.match(result.error, /Refused before approaching/, "a hunt that has not begun gets the admission text");
    assert.match(result.error, /allow_without_shield: true/, "the refusal names the parameter that overrides it");
    assert.equal(pursued, 0, "the refusal precedes the approach");
    assert.equal(result.hunt.targetsEngaged, 0);
  });

test("a carried shield the policy forbids is refused on the same terms as no shield at all", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    shieldPermitted: () => false,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.termination, "shield_required");
  assert.match(result.error, /HUNT_NO_SHIELD/);
  assert.match(result.error, /set_survival_policy/, "a forbidden shield names the policy that forbade it");
});

test("the shield refusal names missing ingredients and the species damage", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([mob(7, minecraftData("1.21.4").entitiesByName.zombie.id, "zombie", 3, "Hostile mobs")], inventory);
  carriedCountField(harnesses.get(bot)!, "oak_planks").count = 6;
  const result = await huntMob(bot, huntRequest("zombie"), {}, dependencies(bot, inventory, []));
  assert.notEqual(result.status, "succeeded");
  if (result.status === "succeeded") throw new Error("expected refusal");
  assert.match(result.error ?? "", /iron_ingot/);
  assert.match(result.error ?? "", /zombie hits for ~3/);
  assert.doesNotMatch(result.error ?? "", /Craft or fetch/);
});

test("a species with varying damage gives no hit estimate", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([mob(7, minecraftData("1.21.4").entitiesByName.hoglin.id, "hoglin", 3, "Hostile mobs")], inventory);
  const result = await huntMob(bot, huntRequest("hoglin"), {}, dependencies(bot, inventory, []));
  assert.notEqual(result.status, "succeeded");
  if (result.status === "succeeded") throw new Error("expected refusal");
  assert.doesNotMatch(result.error ?? "", /hits for ~/);
});

test("a hostile species absent from combat data gives no hit estimate", () => {
  const bot = huntBot([], { count: 0 });
  const name = "unmeasured_hostile";
  const registry = bot.registry.entitiesByName;
  registry[name] = { ...registry.zombie!, name };
  try {
    const error = shieldRefusal(bot, huntRequest(name), () => true);
    assert.match(error ?? "", /HUNT_NO_SHIELD/);
    assert.doesNotMatch(error ?? "", /hits for ~/);
  } finally {
    delete registry[name];
  }
});

test("the shield refusal counts mixed planks toward the recipe", () => {
  const bot = huntBot([], { count: 0 });
  carriedCountField(harnesses.get(bot)!, "oak_planks").count = 3;
  carriedCountField(harnesses.get(bot)!, "birch_planks").count = 3;
  const error = shieldRefusal(bot, huntRequest("zombie"), () => true) ?? "";
  assert.match(error, /needs iron_ingot x1 \(carried:/);
});

test("a carried, permitted shield admits the hostile hunt without the override", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("allow_without_shield admits the hunt a missing shield would have refused", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory);
  const result = await huntMob(bot, huntRequest("skeleton", true), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("passive quarry is never asked for a shield", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.chicken.id, "chicken", 3)], inventory);
  const result = await huntMob(bot, huntRequest("chicken"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("a shield lost mid-hunt refuses the next leg rather than the drop already collected", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const type = registry.entitiesByName.skeleton.id;
  const bot = carryingShield(
    huntBot([mob(7, type, "skeleton", 3, "Hostile mobs"), mob(8, type, "skeleton", 5, "Hostile mobs")], inventory),
  );
  const wanderer = unseen(bot, 8);
  const result = await huntMob(
    bot,
    { ...huntRequest("skeleton"), count: 2, observeForMs: 5_000 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3)]),
      // The shield breaks on the kill, and a second skeleton wanders in during
      // the observation window, so the next leg re-enters the gate carrying
      // nothing to block with.
      collectDropAfterDeath: async () => {
        inventory.count += 1;
        loseShield(bot);
        setImmediate(() => {
          bot.entities[8] = wanderer;
          bot.emit("entitySpawn", wanderer);
        });
        return { kind: "collected" };
      },
    },
  );

  assert.equal(result.termination, "shield_required");
  assert.equal(result.status, "partial", "the drop already collected is not erased by the refusal");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 1, "the leg fought while shielded still happened");
  // The next leg is a resumed run, whose first check is an admission check: the text says the hunt has not begun.
  assert.match(stopText(result), /Refused before approaching/);
});

// A resumed run reads the quantity its caller already carries before it admits or refuses anything (plan 2026-11-18-scenario-reds-part3-a3 T18g).
for (const gained of [true, false])
  test(`a resumed hunt run whose shield broke ${gained ? "after the quantity was carried ends succeeded" : "with no gain is refused at admission"}`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
    const bot = carryingShield(huntBot([mob(8, type, "skeleton", 5, "Hostile mobs")], inventory));
    const wanderer = unseen(bot, 8);
    const pending = huntMob(bot, { ...huntRequest("skeleton"), observeForMs: 5_000 }, {}, dependencies(bot, inventory, []));
    // The first run ends with no loaded target and waits in its observation window; then the drop is carried
    // (by another kill) and the shield broke, and a skeleton loads, which wakes the wait into a second run.
    setImmediate(() => {
      if (gained) inventory.count += 1;
      loseShield(bot);
      bot.entities[8] = wanderer;
      bot.emit("entitySpawn", wanderer);
    });
    const result = await pending;
    if (gained) {
      assert.equal(result.status, "succeeded", `the old code answered ${result.status} ${result.termination}`);
      assert.equal(result.termination, "quantity_collected");
      assert.equal(result.hunt.gained, 1);
      assert.equal(result.hunt.targetsEngaged, 0);
    } else {
      assert.equal(result.termination, "shield_required");
      assert.equal(result.status, "failed");
      assert.match(stopText(result), /Refused before approaching/);
    }
  });

for (const loss of ["broken", "forbidden"] as const) {
  test(`a ${loss} shield stops the real pursuit before approaching the next loaded enemy`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
    const bot = carryingShield(huntBot([
      mob(7, type, "skeleton", 3, "Hostile mobs"),
      mob(8, type, "skeleton", 20, "Hostile mobs"),
    ], inventory));
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let approached = 0;
    let permitted = true;
    const navigation = {
      ...fakeNavigation,
      navigate: async () => {
        approached++;
        throw new Error("The unshielded hunt must stop before approaching the second enemy");
      },
    } as NavigationRuntime;
    const result = await huntMob(bot, { ...huntRequest("skeleton"), count: 2 }, {}, {
      ...dependencies(bot, inventory, [died(2, 3)]),
      pursue: huntMobDependencies(bot, navigation, combat).pursue,
      shieldPermitted: () => permitted,
      collectDropAfterDeath: async () => {
        inventory.count++;
        if (loss === "broken") loseShield(bot);
        else permitted = false;
        return { kind: "collected" };
      },
    });

    assert.equal(approached, 0);
    assert.equal(result.termination, "shield_required");
    assert.equal(result.status, "partial");
    assert.match(result.error ?? "", /HUNT_NO_SHIELD/);
    // A shield lost after the hunt began is named as lost; a policy that forbids shields keeps its own refusal.
    assert.match(
      result.error ?? "",
      loss === "broken" ? /no shield remains after the hunt began/ : /the combat policy forbids shield use/,
    );
    assert.equal(result.hunt.gained, 1);
    assert.equal(result.hunt.targetDeathsObserved, 1);
    assert.equal(result.hunt.targetsEngaged, 1);
  });
}

test("a shield lost while gathering drops at contact is checked again before engaging", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = carryingShield(huntBot([mob(7, type, "skeleton", 3, "Hostile mobs")], inventory));
  let pickups = 0;
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    gatherLoadedDrops: async () => {
      if (++pickups === 2) loseShield(bot);
      return 0;
    },
  });
  assert.equal(result.termination, "shield_required");
  assert.equal(result.hunt.targetsEngaged, 0);
});

/** The stop text of a hunt that did not succeed. */
function stopText(result: Awaited<ReturnType<typeof huntMob>>): string {
  if (result.status === "succeeded") throw new Error("expected a stop");
  return result.error ?? "";
}

/**
 * Two skeletons in sight, the nearer killed by the leg that collects its drop, so the next leg of the same run
 * checks the shield. `afterKill` runs on that drop, and `shieldPermitted` answers the policy.
 */
function huntLosingShieldOnKill(afterKill: (bot: Bot) => void, shieldPermitted: () => boolean = () => true) {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = carryingShield(
    huntBot([mob(7, type, "skeleton", 3, "Hostile mobs"), mob(8, type, "skeleton", 5, "Hostile mobs")], inventory),
  );
  return huntMob(bot, { ...huntRequest("skeleton"), count: 2, observeForMs: 5_000 }, {}, {
    ...dependencies(bot, inventory, [died(2, 3)]),
    shieldPermitted,
    collectDropAfterDeath: async () => {
      inventory.count += 1;
      afterKill(bot);
      return { kind: "collected" };
    },
  });
}

test("a shield lost after the hunt began is named as lost, with the drops carried", async () => {
  const result = await huntLosingShieldOnKill(loseShield);

  assert.equal(result.termination, "shield_required");
  assert.match(
    stopText(result),
    /^\[HUNT_NO_SHIELD\] Refused to go on: no shield remains after the hunt began; 1 of 2 carried; allow_without_shield: true accepts unblocked hits\./,
  );
});

/** Put a shield in the off-hand slot, or take the one there out, as the server's `set_slot` would (slot 45). */
function setOffHandShield(bot: Bot, carried: boolean): void {
  const offHand = 45;
  const inventory = harnesses.get(bot)!.inventory;
  (inventory.updateSlot as (slot: number, item: unknown) => void).call(
    inventory,
    offHand,
    carried ? itemOf(bot.registry, "shield") : null,
  );
}

test("a spare shield in the inventory lets the hunt go on after the off-hand one is gone", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = huntBot([mob(7, type, "skeleton", 3, "Hostile mobs"), mob(8, type, "skeleton", 5, "Hostile mobs")], inventory);
  setOffHandShield(bot, true);
  shields(bot).count = 1; // the spare, in the main inventory
  const result = await huntMob(bot, { ...huntRequest("skeleton"), count: 2, observeForMs: 5_000 }, {}, {
    ...dependencies(bot, inventory, [died(2, 3), died(2, 5)]),
    collectDropAfterDeath: async () => {
      inventory.count += 1;
      setOffHandShield(bot, false);
      return { kind: "collected" };
    },
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 2);
});

test("the default request does not opt out of the shield gate", () => {
  assert.equal(parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone" }).allowWithoutShield, false);
  assert.equal(
    parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone", allow_without_shield: true }).allowWithoutShield,
    true,
  );
});
