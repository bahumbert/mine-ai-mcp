import assert from "node:assert/strict";
import test from "node:test";
import { addItemsToServerTag } from "../../../../test-support/datapack-tags.js";
import { createFakeBot } from "../../../../test-support/fake-bot/index.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../../policy/contract.js";
import { responseScope } from "./response.js";

/** The weapon names a fight scope records as facts (the trace the model and the answered-response check read). */
function fightWeapons(carried: Record<string, number>, datapackSwords: readonly string[] = []) {
  const harness = createFakeBot({ carried });
  const { bot } = harness;
  if (datapackSwords.length > 0) addItemsToServerTag(harness, "swords", datapackSwords);
  const facts = responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "fight", 7).facts() as { weapons: { name: string; available: boolean }[] };
  return facts.weapons.map((weapon) => weapon.name);
}

test("the response trace lists the shield and the crossbow", () => {
  assert.deepEqual(fightWeapons({ shield: 1, crossbow: 1, cobblestone: 8 }), ["crossbow", "shield"]);
});

test("the response trace lists every vanilla bow, arrow, sword, axe and shield, and no other tool", () => {
  const carried = { bow: 1, crossbow: 1, arrow: 16, tipped_arrow: 4, spectral_arrow: 4, wooden_sword: 1, netherite_sword: 1, iron_axe: 1, shield: 1, iron_pickaxe: 1, bread: 3 };
  assert.deepEqual(fightWeapons(carried), ["arrow", "bow", "crossbow", "iron_axe", "netherite_sword", "shield", "spectral_arrow", "tipped_arrow", "wooden_sword"]);
});

test("the response trace lists an item a datapack adds to the swords family", () => {
  assert.deepEqual(fightWeapons({ stick: 1, iron_pickaxe: 1 }, ["stick"]), ["stick"]);
});

test("the response trace is empty for a hide scope", () => {
  const { bot } = createFakeBot({ carried: { iron_sword: 1 } });
  const facts = responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "hide").facts() as { weapons: unknown[] };
  assert.deepEqual(facts.weapons, []);
});
