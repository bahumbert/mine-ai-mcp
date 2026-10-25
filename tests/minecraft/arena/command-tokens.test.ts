import assert from "node:assert/strict";
import test from "node:test";
import { addToNumberWord, isCoordinateWord, splitCommand } from "./command-tokens.ts";

test("a bracketed group, a braced compound and a quoted string stay one word however many spaces they hold", () => {
  assert.deepEqual(splitCommand("kill @e[type=zombie, name=Bob] now"), ["kill", "@e[type=zombie, name=Bob]", "now"]);
  assert.deepEqual(splitCommand('summon pig 0 0 0 {CustomName:\'{"text":"a  b"}\'}'), ["summon", "pig", "0", "0", "0", "{CustomName:'{\"text\":\"a  b\"}'}"]);
  assert.deepEqual(splitCommand('say "two words" done'), ["say", '"two words"', "done"]);
});

test("runs of spaces between words, and a leading or trailing space, do not make empty words", () => {
  assert.deepEqual(splitCommand("  fill   1 2   3 "), ["fill", "1", "2", "3"]);
  assert.deepEqual(splitCommand(""), []);
});

test("an unbalanced bracket keeps the rest of the command as one word instead of looping or throwing", () => {
  assert.deepEqual(splitCommand("kill @e[type=zombie now"), ["kill", "@e[type=zombie now"]);
});

test("a coordinate word is a number or a relative offset, nothing else", () => {
  for (const word of ["0", "-16", "25.5", ".5", "~", "~1", "~-2.5", "^", "^3"]) assert.ok(isCoordinateWord(word), word);
  for (const word of ["stone", "1e3", "--1", "~~", "1.", "", "@s", "true"]) assert.ok(!isCoordinateWord(word), word);
});

test("a number word moved by an integer keeps its integer or decimal form", () => {
  assert.equal(addToNumberWord("-16", 1536), "1520");
  assert.equal(addToNumberWord("25.5", 512), "537.5");
  assert.equal(addToNumberWord("0.1", 1536), "1536.1");
  assert.equal(addToNumberWord(".5", 2), "2.5");
  assert.equal(addToNumberWord("7", 0), "7");
});
