import assert from "node:assert/strict";
import test from "node:test";
import { ObeyMoods, obeyChance } from "./obey.ts";

const MIN = 60_000;
const settings = { halfAt: -4, spread: 4, moodMinutes: 5, rerollOnChange: 10 };

test("the chance follows the logistic curve of the score", () => {
  const pct = (score: number) => Math.round(obeyChance(score, -4, 4) * 100);
  assert.deepEqual([10, 0, -10, -15, -20].map(pct), [97, 73, 18, 6, 2]);
  assert.equal(obeyChance(-4, -4, 4), 0.5);
});

test("a roll just under the chance obeys and just over does not, at score -15", () => {
  const chance = obeyChance(-15, -4, 4);
  const under = new ObeyMoods(settings).moodOf("Bruno", -15, 0, () => chance - 0.001);
  const over = new ObeyMoods(settings).moodOf("Bruno", -15, 0, () => chance + 0.001);
  assert.deepEqual([under.obeys, over.obeys], [true, false]);
  assert.equal(over.score, -15);
  assert.equal(over.chance, chance);
});

test("the same speaker inside the mood window keeps the stored roll and rolls no more", () => {
  const moods = new ObeyMoods(settings);
  let calls = 0;
  const roll = () => { calls += 1; return 0.99; };
  const first = moods.moodOf("Bruno", -15, 0, roll);
  const again = moods.moodOf("bruno", -15, 4 * MIN, roll);
  assert.equal(first.obeys, false);
  assert.deepEqual(again, first);
  assert.equal(calls, 1);
});

test("after the mood minutes the speaker is rolled again", () => {
  const moods = new ObeyMoods(settings);
  assert.equal(moods.moodOf("Bruno", -15, 0, () => 0.99).obeys, false);
  assert.equal(moods.moodOf("Bruno", -15, 5 * MIN, () => 0).obeys, true);
});

test("a score move of rerollOnChange points rolls again, a smaller one does not", () => {
  const moods = new ObeyMoods(settings);
  assert.equal(moods.moodOf("Bruno", -15, 0, () => 0.99).obeys, false);
  assert.equal(moods.moodOf("Bruno", -6, MIN, () => 0).obeys, false);
  assert.equal(moods.moodOf("Bruno", -5, MIN, () => 0).obeys, true);
});

test("each speaker has their own mood", () => {
  const moods = new ObeyMoods(settings);
  assert.equal(moods.moodOf("Bruno", -15, 0, () => 0.99).obeys, false);
  assert.equal(moods.moodOf("Ayla", -15, 0, () => 0).obeys, true);
});

test("stored reads the roll without expiry and answers null for a speaker never rolled", () => {
  const moods = new ObeyMoods(settings);
  assert.equal(moods.stored("Bruno"), null);
  const rolled = moods.moodOf("Bruno", -15, 0, () => 0.99);
  assert.deepEqual(moods.stored("BRUNO"), rolled);
});
