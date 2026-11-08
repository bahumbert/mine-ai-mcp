import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { createFakeClock } from "../test-support/fake-bot/fake-clock.js";
import { attackDps, bareHand, bestMeleeDps, itemAttack } from "./combat-data.js";
import { exposureOf, gearExposure } from "./gear-exposure.js";

const VERSION = "1.21.4";
/** The shipped data gives a figure to two decimals; the owner's figures are one step under two of them (0.63 for 0.62, 0.53 for 0.52). */
const FIGURE_TOLERANCE = 0.01 + 1e-9;

type Piece = "head" | "torso" | "legs" | "feet";
/**
 * Vanilla armour points per piece and the toughness each piece adds, by material. A test fixture, unmeasured: the shipped
 * data holds no armour table, so the eight loadouts of spec D3 name their pieces here. The fake measured only the chestplate
 * (iron 6 and 0, diamond 8 and 2: `src/test-support/fake-bot/fake-bot-armour.ts`).
 */
const MATERIAL: Record<string, { readonly points: Record<Piece, number>; readonly toughnessPerPiece: number }> = {
  leather: { points: { head: 1, torso: 3, legs: 2, feet: 1 }, toughnessPerPiece: 0 },
  iron: { points: { head: 2, torso: 6, legs: 5, feet: 2 }, toughnessPerPiece: 0 },
  diamond: { points: { head: 3, torso: 8, legs: 6, feet: 3 }, toughnessPerPiece: 2 },
  netherite: { points: { head: 3, torso: 8, legs: 6, feet: 3 }, toughnessPerPiece: 3 },
};

/** The armour a loadout's pieces give: points and toughness summed over the pieces worn. */
function armourOf(material: string | null, pieces: readonly Piece[]): { armor: number; toughness: number } {
  if (material === null) return { armor: 0, toughness: 0 };
  const { points, toughnessPerPiece } = MATERIAL[material]!;
  return {
    armor: pieces.reduce((total, piece) => total + points[piece], 0),
    toughness: pieces.length * toughnessPerPiece,
  };
}

const FULL_SET: readonly Piece[] = ["head", "torso", "legs", "feet"];
const meleeDpsOf = (sword: string | null) => attackDps(itemAttack(sword, VERSION));

test("the bare hand is 4 dps and the best melee 12.8 in the shipped data", () => {
  assert.equal(attackDps(bareHand(VERSION)), 4);
  assert.equal(bestMeleeDps(VERSION), 12.8, "netherite sword: 8 x 1.6");
});

test("exposureOf gives the eight figures of spec D3 for the owner's loadouts", () => {
  const cases: readonly { readonly label: string; readonly material: string | null; readonly pieces: readonly Piece[]; readonly sword: string | null; readonly shield: boolean; readonly expected: number }[] = [
    { label: "nothing", material: null, pieces: [], sword: null, shield: false, expected: 1.0 },
    { label: "no armour + wooden sword", material: null, pieces: [], sword: "wooden_sword", shield: false, expected: 0.98 },
    { label: "leather + stone sword", material: "leather", pieces: FULL_SET, sword: "stone_sword", shield: false, expected: 0.89 },
    { label: "iron helmet + chestplate + iron sword", material: "iron", pieces: ["head", "torso"], sword: "iron_sword", shield: false, expected: 0.84 },
    { label: "full iron + iron sword", material: "iron", pieces: FULL_SET, sword: "iron_sword", shield: false, expected: 0.62 },
    { label: "full iron + iron sword + shield", material: "iron", pieces: FULL_SET, sword: "iron_sword", shield: true, expected: 0.52 },
    { label: "full diamond + diamond sword + shield", material: "diamond", pieces: FULL_SET, sword: "diamond_sword", shield: true, expected: 0.24 },
    { label: "full netherite + netherite sword + shield", material: "netherite", pieces: FULL_SET, sword: "netherite_sword", shield: true, expected: 0.19 },
  ];
  for (const { label, material, pieces, sword, shield, expected } of cases) {
    const { armor, toughness } = armourOf(material, pieces);
    const { exposure } = exposureOf({ armor, toughness, meleeDps: meleeDpsOf(sword), bowReady: false, shield });
    assert.ok(Math.abs(exposure - expected) <= FIGURE_TOLERANCE, `${label}: ${exposure}, owner ${expected}`);
  }
});

test("exposureOf floors the exposure at 0.15 and counts a bow only when its 9.6 dps beats the melee", () => {
  const full = exposureOf({ armor: 40, toughness: 20, meleeDps: 12.8, bowReady: true, shield: true });
  assert.equal(full.exposure, 0.15, "the most protection, the best weapon and a shield: the floor");
  const meleeWins = exposureOf({ armor: 0, toughness: 0, meleeDps: 12.8, bowReady: true, shield: false });
  assert.equal(meleeWins.bowCounted, false, "a bow that does not raise the dps is not counted");
});

test("gearExposure reads the fake's worn pieces, weapon, bow and shield", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot } = createFakeBot({ clock, carried: { iron_chestplate: 1, iron_sword: 1, bow: 1, shield: 1 }, slots: { 37: { name: "arrow", count: 16 } } });
  await bot.equip(bot.inventory.items().find((item) => item.name === "iron_chestplate")!, "torso");
  await clock.advance(100);
  const gear = gearExposure(bot);
  assert.equal(gear.melee, "iron_sword");
  assert.equal(gear.shield, 1, "a carried shield counts");
  assert.equal(gear.bowCounted, false, "16 arrows make the bow ready, but its 9.6 dps does not beat the iron sword's 9.6");
  assert.ok(Math.abs(gear.dps - 9.6) < 1e-9, `dps ${gear.dps}: the iron sword's 6 x 1.6`);
  // Iron chestplate alone: 6 armour points, 0 toughness (armour-points.test.ts, as measured).
  assert.ok(Math.abs(gear.protection - 0.175) < 1e-9, `protection ${gear.protection}`);
  assert.equal(gear.exposure, exposureOf({ armor: 6, toughness: 0, meleeDps: 9.6, bowReady: true, shield: true }).exposure);
});

test("a bow with 15 arrows does not count, 16 does", () => {
  const withArrows = (count: number) => createFakeBot({ carried: { bow: 1 }, slots: { 37: { name: "arrow", count } } }).bot;
  const fifteen = gearExposure(withArrows(15));
  assert.equal(fifteen.bowCounted, false, "15 arrows: not ready");
  assert.equal(fifteen.dps, 4, "the bare hand's dps");
  const sixteen = gearExposure(withArrows(16));
  assert.equal(sixteen.bowCounted, true, "16 arrows: ready");
  assert.equal(sixteen.dps, 9.6);
});

test("an armour piece worn with no armour attribute read yet counts as no armour", () => {
  const bot = createFakeBot({ slots: { 6: { name: "iron_chestplate" } } }).bot;
  assert.equal(gearExposure(bot).protection, 0, "null armour is read as 0 (spec D3)");
});
