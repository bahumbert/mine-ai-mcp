import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const DIR = new URL("./", import.meta.url);
/** Rule #0: the score informs the model through prompts; only score.ts (drift, clamp, bands) may compare it with a number. */
const SCORE_COMPARED = /\bscore\s*[<>]=?|[<>]=?\s*\w*\.score\b/u;

test("no code outside score.ts compares a score with a threshold", () => {
  const sources = readdirSync(DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "score.ts");
  assert.ok(sources.length > 10, "the relations sources were found");
  const hits = sources.flatMap((name) => readFileSync(new URL(name, DIR), "utf8").split("\n")
    .map((line, i) => ({ name, line: i + 1, text: line }))
    .filter(({ text }) => SCORE_COMPARED.test(text) && !text.trim().startsWith("//")))
    .map(({ name, line, text }) => `${name}:${line} ${text.trim()}`);
  assert.deepEqual(hits, []);
});

test("the guard catches a comparison", () => {
  assert.match("if (r.score < 20) refuse();", SCORE_COMPARED);
  assert.match("if (-60 >= other.score) attack();", SCORE_COMPARED);
  assert.doesNotMatch("const score = plain(Math.max(MIN_SCORE, drift.score + wanted));", SCORE_COMPARED);
});
