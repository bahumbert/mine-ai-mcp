import assert from "node:assert/strict";
import test from "node:test";
import { farmPromptFacts, goalP50 } from "./prompt-fixtures.ts";
import { opportunityLine } from "./opportunities.ts";
import { goalParts } from "./prompt-parts.ts";
import { HINTS } from "./prompt-budget.ts";
import {
  budgetFor,
  capLines,
  cut,
  DEFAULT_CHARS_PER_TOKEN,
  estimateTokens,
  fitPrompt,
  MIN_BUDGET,
  ModelCalibration,
  reservedTokens,
  type PromptPart,
} from "./prompt-budget.ts";

/** A part that renders `lengths[level]` copies of `char` (level beyond the list: the last one). */
function sized(key: string, lengths: readonly number[], extra: Partial<PromptPart> = {}): PromptPart {
  return {
    key,
    maxLevel: lengths.length - 1,
    render: (level) => key.toUpperCase().slice(0, 1).repeat(lengths[Math.min(level, lengths.length - 1)] ?? 0),
    ...extra,
  };
}

test("a prompt under its budget is sent as rendered, nothing shrunk", () => {
  const parts: PromptPart[] = [
    { key: "a", maxLevel: 0, render: () => "A" },
    { key: "b", maxLevel: 1, render: () => "B" },
  ];
  const fitted = fitPrompt("system", parts, ["b"], 1000, 3.4);
  assert.equal(fitted.text, "A\n\nB");
  assert.deepEqual(fitted.shrunk, []);
  assert.equal(fitted.overBudget, false);
  assert.equal(fitted.estimated, estimateTokens("system".length + 4, 3.4));
  assert.equal(fitted.tokens, 1000);
});

test("over budget, parts shrink one level at a time in order, cycling, until it fits", () => {
  const x = sized("x", [400, 200, 50], { label: (level) => `x at ${level}` });
  const y = sized("y", [400, 200, 50], { label: (level) => `y at ${level}` });
  // x:1,y:1 renders 200+200+2 = 402 characters; x:2,y:0 would be 50+400+2 = 452: the cycle must reach x1,y1 first.
  const fitted = fitPrompt("", [x, y], ["x", "y"], estimateTokens(402, 1), 1);
  assert.equal(fitted.text.length, 402);
  assert.deepEqual(fitted.shrunk, ["x at 1", "y at 1"]);
  assert.equal(fitted.overBudget, false);
});

test("a level that renders the same text is skipped and not labelled", () => {
  const x: PromptPart = {
    key: "x",
    maxLevel: 2,
    render: (level) => (level < 2 ? "X".repeat(300) : "X".repeat(10)),
  };
  const fitted = fitPrompt("", [x], ["x"], 100, 1);
  assert.equal(fitted.text.length, 10);
  assert.deepEqual(fitted.shrunk, ["x level 2"]);
});

// Review 2026-11-07 W1: the loop is synchronous, so a key named twice in `order` (never ending) would freeze the whole brain.
test("a key named twice in order ends, and shrinks exactly as when named once", () => {
  const make = () => [sized("x", [400, 200, 50]), sized("y", [400, 200, 50])];
  const once = fitPrompt("S".repeat(1000), make(), ["x", "y"], 10, 1);
  const twice = fitPrompt("S".repeat(1000), make(), ["x", "y", "x"], 10, 1);
  assert.deepEqual(twice, once);
  assert.equal(twice.overBudget, true);
});

test("a part with maxLevel 0 or absent from order is never shrunk", () => {
  const fixed = sized("f", [500]);
  const outside = sized("o", [500, 10]);
  const fitted = fitPrompt("", [fixed, outside], ["f"], 10, 1);
  assert.equal(fitted.text.length, 1002);
  assert.deepEqual(fitted.shrunk, []);
  assert.equal(fitted.overBudget, true);
});

test("still over at every floor: sent at the floors and marked overBudget", () => {
  const x = sized("x", [400, 200, 50]);
  const y = sized("y", [400, 200, 50]);
  const system = "S".repeat(1000);
  const fitted = fitPrompt(system, [x, y], ["x", "y"], 10, 1);
  assert.equal(fitted.text.length, 102);
  assert.deepEqual(fitted.shrunk, ["x level 2", "y level 2"]);
  assert.equal(fitted.overBudget, true);
  assert.equal(fitted.estimated, 1102);
});

test("separators: empty renders are skipped with their separator, none before the first, \"\\n\" joins inside a block", () => {
  const part = (key: string, text: string, before?: string): PromptPart => ({ key, maxLevel: 0, render: () => text, ...(before !== undefined && { before }) });
  assert.equal(fitPrompt("", [part("a", "A"), part("gone", ""), part("b", "B")], [], 100, 1).text, "A\n\nB");
  assert.equal(fitPrompt("", [part("gone", ""), part("a", "A", "\n")], [], 100, 1).text, "A");
  assert.equal(fitPrompt("", [part("a", "A"), part("b", "B", "\n"), part("c", "C")], [], 100, 1).text, "A\nB\n\nC");
});

test("budgetFor takes the table value, cut by the window minus the reply room, never under MIN_BUDGET", () => {
  assert.equal(budgetFor("work", null), 6000);
  assert.equal(budgetFor("work", 16384), 6000);
  assert.equal(budgetFor("work", 4096), 2048);
  assert.equal(budgetFor("work", 2048), MIN_BUDGET);
});

test("reservedTokens sums the rows of a tier", () => {
  assert.equal(reservedTokens("chat"), 0);
  assert.equal(reservedTokens("work"), 150);
  assert.equal(reservedTokens("goal"), 300);
  assert.equal(reservedTokens("narrate"), 0);
});

test("capLines keeps whole lines until a cap, the first and kept lines always", () => {
  const lines = Array.from({ length: 8 }, (_, index) => `${index}`.repeat(300));
  // 1600 characters hold five 300-character lines.
  assert.deepEqual(capLines(lines, 6, 1600), lines.slice(0, 5));
  // line 7 is kept: it takes the fifth place, counted in the cap.
  assert.deepEqual(capLines(lines, 6, 1600, (index) => index === 7), [...lines.slice(0, 4), lines[7]]);
  assert.deepEqual(capLines(["x".repeat(2000)], 6, 1600), ["x".repeat(2000)]);
  assert.deepEqual(capLines(lines, 2, 100000), lines.slice(0, 2));
});

test("cut adds an ellipsis only when it cuts", () => {
  assert.equal(cut("abcdef", 6), "abcdef");
  assert.equal(cut("abcdefg", 6), "abcde…");
  assert.equal(cut("", 3), "");
});

test("ModelCalibration: the median of a model's last 50 first replies, clamped, per model; the last window reported", () => {
  const calibration = new ModelCalibration();
  assert.equal(calibration.charsPerToken("a"), DEFAULT_CHARS_PER_TOKEN);
  assert.equal(calibration.window("a"), null);
  for (const characters of [3000, 3200, 100_000]) calibration.learn("a", characters, 1000, null);
  assert.equal(calibration.charsPerToken("a"), 3.2, "the median, not the mean: one odd call does not move it");
  calibration.learn("a", 3600, 1000, 8192);
  assert.ok(Math.abs(calibration.charsPerToken("a") - 3.4) < 1e-9, "even count: the middle two averaged");
  assert.equal(calibration.window("a"), 8192);
  assert.equal(calibration.charsPerToken("b"), DEFAULT_CHARS_PER_TOKEN, "another model has its own samples");
  // No count, a zero count and a count at 95 % of the window are no samples.
  calibration.learn("b", 5000, null, null);
  calibration.learn("b", 5000, 0, null);
  calibration.learn("b", 5000, 950, 1000);
  assert.equal(calibration.charsPerToken("b"), DEFAULT_CHARS_PER_TOKEN);
  assert.equal(calibration.window("b"), 1000, "the window is kept even when the count is not a sample");
  // Only the last 50 count.
  for (let call = 0; call < 50; call += 1) calibration.learn("c", 280, 100, null);
  for (let call = 0; call < 50; call += 1) calibration.learn("c", 390, 100, null);
  assert.equal(calibration.charsPerToken("c"), 3.9);
  calibration.learn("d", 10, 100, null);
  assert.equal(calibration.charsPerToken("d"), 2.5, "clamped from below");
});

test("estimateTokens rounds up", () => {
  assert.equal(estimateTokens(34, 3.4), 10);
  assert.equal(estimateTokens(35, 3.4), 11);
});

test("four farm hints fit the hint budget with a house and bed still shown", () => {
  const { places, opportunities } = farmPromptFacts();
  assert.equal(places.length, 4);
  assert.ok(places.every((place) => place.detail.includes("stage 2.0/7") && place.detail.includes("near")));
  assert.ok(places.every((place) => place.detail.includes("2 dry farmland")));
  assert.equal(places.filter((place) => place.detail.includes("water within 4 blocks hydrates it")).length, 1, "one general explanation covers all dry farm counts");
  assert.equal(opportunities.filter((hint) => hint.activities.includes("farming")).length, 4);
  const lines = opportunities.map(opportunityLine).join("\n");
  assert.ok(lines.length <= HINTS.chars, `${lines.length}/${HINTS.chars}`);
  assert.equal(opportunities.length, HINTS.lines);
  const rendered = goalParts({ ...goalP50(), places, opportunities }).find((part) => part.key === "hints")!.render(0);
  assert.ok(rendered.includes("unfinished small medieval house"));
  assert.ok(rendered.includes("you carry no bed"));
  assert.equal((rendered.match(/ripe by now/gu) ?? []).length, 4);
});
