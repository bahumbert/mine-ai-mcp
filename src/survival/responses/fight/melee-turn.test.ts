import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { addItemsToServerTag } from "../../../test-support/datapack-tags.js";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import type { CombatLoadout } from "../../weapons/equipment.js";
import type { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import { runMeleeTurn } from "./melee-turn.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/**
 * One melee turn against a zombie in reach, a piglin standing in sweep range, melee prohibited by policy: a turn that
 * withholds the swing returns null, one that goes on to the swing stops at the policy refusal. Only the parts of the
 * scene the turn reads on this path are stubbed (as in approach-goal.test.ts).
 */
async function turnWith(weapon: string, datapackSwords: readonly string[]) {
  const harness = createFakeBot({
    position: new Vec3(0, 64, 0),
    entities: {
      7: { name: "zombie", position: new Vec3(2, 64, 0), width: 0.6, height: 1.95 },
      8: { name: "piglin", position: new Vec3(1, 64, 1), width: 0.6, height: 1.95 },
    },
  });
  const { bot } = harness;
  if (datapackSwords.length > 0) addItemsToServerTag(harness, "swords", datapackSwords);
  const scene = {
    bot,
    target: bot.entities[7]!,
    targetId: 7,
    movement: "hold",
    holdsGround: false,
    position: { plan: null },
    signal: new AbortController().signal,
    policy: { combat: { melee: false } },
    settled: () => false,
    result: (kind: string) => ({ kind }),
  } as unknown as FightScene;
  const weapons = {
    readyWeapon: async () => {},
    face: async () => {},
  } as unknown as FightWeapons;
  const roof = { state: { kind: "idle" } } as unknown as EndermanFight;
  const loadout: Extract<CombatLoadout, { kind: "melee" }> = {
    kind: "melee", weapon: itemOf(bot.registry, weapon), shield: null, cooldownTicks: 10,
  };
  return runMeleeTurn(scene, weapons, {} as unknown as FightMovement, roof, loadout);
}

test("every vanilla sword in the loadout skips the swing while a bystander is in sweep range", async () => {
  for (const sword of ["wooden_sword", "stone_sword", "golden_sword", "iron_sword", "diamond_sword", "netherite_sword"]) {
    assert.equal(await turnWith(sword, []), null, sword);
  }
});

test("an item a datapack adds to swords skips the swing while a bystander is in sweep range", async () => {
  assert.equal(await turnWith("stick", ["stick"]), null);
});

test("a weapon outside the swords family goes on to the swing beside a bystander", async () => {
  const outcome = await turnWith("iron_axe", []);
  assert.equal(outcome?.kind, "capability_blocked");
});
