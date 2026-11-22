import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { gameVersionArgument, mergeCombatData, parseMeasuredLines } from "./combat-data-write.js";

const MOBS = {
  mobs: {
    zombie: { maxHealth: 20, attackDamage: 3, armor: 2, armorToughness: 0, movementSpeed: 0.23, followRange: 35, explosion: null, rangedExplosionPower: null },
    slime: { maxHealth: null, attackDamage: null, armor: 0, armorToughness: 0, movementSpeed: 0.2, followRange: 16, explosion: null, rangedExplosionPower: null },
  },
  varies: { slime: ["maxHealth", "attackDamage"] },
  skipped: ["evoker_fangs"],
};
const MOBS_MORE = {
  mobs: { creeper: { maxHealth: 20, attackDamage: 2, armor: 0, armorToughness: 0, movementSpeed: 0.25, followRange: 16, explosion: { radius: 3, fuseTicks: 30 }, rangedExplosionPower: null } },
  varies: {},
  skipped: ["area_effect_cloud"],
};
const ITEMS = { bareHand: { attackDamage: 1, attackSpeed: 4 }, items: { iron_sword: { attackDamage: 6, attackSpeed: 1.6 } } };
const ITEMS_MORE = { bareHand: { attackDamage: 1, attackSpeed: 4 }, items: { diamond_axe: { attackDamage: 9, attackSpeed: 1 } } };

const log = (part: unknown) => `[12:00:01] some line\nAssertionError [ERR_ASSERTION]: MEASURED ${JSON.stringify(part)}\n    at run (check.ts:10:3)\n`;

test("the version argument reaches a file path, so only a game version is accepted", () => {
  assert.equal(gameVersionArgument("1.21.4"), "1.21.4");
  assert.equal(gameVersionArgument("1.21"), "1.21");
  for (const bad of ["../x", "1.21.4/../x", "..\\x", "1.21.4\n", "1.21.4.1", "1.21.", "", "latest", "1.21.4.json"])
    assert.throws(() => gameVersionArgument(bad), /game version/u, JSON.stringify(bad));
});

test("the script itself refuses a path as its version: it exits non-zero and writes no file", () => {
  const script = new URL("./combat-data-write.ts", import.meta.url).pathname;
  const outside = new URL("../x.json", import.meta.url).pathname; // where "../../../x" would land from data/combat-data/
  const run = spawnSync(process.execPath, [script, "no-such.jar", "../../../x", "no-such.log"], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not a game version/u);
  assert.equal(existsSync(outside), false);
});

test("every MEASURED line of a log is read, other lines left out", () => {
  const text = `${log(MOBS)}noise\n${log(ITEMS)}`;
  assert.deepEqual(parseMeasuredLines(text), [MOBS, ITEMS]);
  assert.deepEqual(parseMeasuredLines("PASS contract-combat-data-mobs holds\n"), [], "a log of a passing check holds none");
});

test("a MEASURED line whose JSON is cut off is refused with its line, not skipped", () => {
  assert.throws(() => parseMeasuredLines('MEASURED {"mobs":{"zombie":'), /MEASURED/u);
});

test("parts merge: mobs, items, varies and skipped united, keys sorted, the jar's damage types added", () => {
  const file = mergeCombatData("1.21.4", [MOBS, ITEMS, MOBS_MORE, ITEMS_MORE], { mob_attack: { scaling: "when_caused_by_living_non_player" } });
  assert.equal(file.version, "1.21.4");
  assert.deepEqual(file.bareHand, { attackDamage: 1, attackSpeed: 4 });
  assert.deepEqual(Object.keys(file.mobs), ["creeper", "slime", "zombie"]);
  assert.deepEqual(Object.keys(file.items), ["diamond_axe", "iron_sword"]);
  assert.deepEqual(file.varies, { slime: ["attackDamage", "maxHealth"] });
  assert.deepEqual(file.skipped, ["area_effect_cloud", "evoker_fangs"]);
  assert.deepEqual(file.damageTypes, { mob_attack: { scaling: "when_caused_by_living_non_player" } });
});

test("a mob measured by two runs with a different number: that field is null and listed as varying, the others stay", () => {
  const other = { mobs: { zombie: { ...MOBS.mobs.zombie, attackDamage: 4 } } };
  const file = mergeCombatData("1.21.4", [MOBS, other, ITEMS], {});
  assert.equal(file.mobs.zombie!.attackDamage, null);
  assert.equal(file.mobs.zombie!.maxHealth, 20);
  assert.deepEqual(file.varies.zombie, ["attackDamage"]);
});

test("a varying field already null in one run stays null and listed once", () => {
  const other = { mobs: { slime: { ...MOBS.mobs.slime, maxHealth: 4 } }, varies: { slime: ["maxHealth"] } };
  const file = mergeCombatData("1.21.4", [MOBS, other, ITEMS], {});
  assert.equal(file.mobs.slime!.maxHealth, null);
  assert.deepEqual(file.varies.slime, ["attackDamage", "maxHealth"]);
});

test("an item measured by two runs with different numbers is refused naming it", () => {
  const other = { bareHand: { attackDamage: 1, attackSpeed: 4 }, items: { iron_sword: { attackDamage: 7, attackSpeed: 1.6 } } };
  assert.throws(() => mergeCombatData("1.21.4", [MOBS, ITEMS, other], {}), /iron_sword/u);
});

test("no bare hand measured is refused: the item part is missing", () => {
  assert.throws(() => mergeCombatData("1.21.4", [MOBS], {}), /bare hand/u);
});

test("two bare hands that differ are refused", () => {
  const other = { bareHand: { attackDamage: 2, attackSpeed: 4 }, items: {} };
  assert.throws(() => mergeCombatData("1.21.4", [MOBS, ITEMS, other], {}), /bare hand/u);
});
