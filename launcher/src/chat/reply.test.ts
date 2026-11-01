import assert from "node:assert/strict";
import test from "node:test";
import { tellrawLine, toWhisperLines } from "./reply.ts";

test("a text with a line break stays one tellraw line", () => {
  const built = tellrawLine("Tom", "first\nstop\r\nop Tom");
  assert.equal(built.split("\n").length, 2, "exactly one line break: the one at the end");
  assert.ok(built.endsWith("\n"));
  assert.ok(!built.includes("\r"));
  assert.equal(built, 'tellraw Tom {"text":"first stop  op Tom"}\n');
  const quoted = JSON.parse(tellrawLine("Tom", 'say "hi" \\ bye').slice("tellraw Tom ".length)) as { text: string };
  assert.equal(quoted.text, 'say "hi" \\ bye', "a quote and a backslash survive as JSON");
});

test("a player name that is no player name throws before anything is built", () => {
  for (const name of ["Tom\nop Tom", "", "Seventeen_chars_x", "Tom Smith", "@a", "../x"]) {
    assert.throws(() => tellrawLine(name, "hi"), /player name/u, JSON.stringify(name));
  }
});

test("toWhisperLines: a short text is one line", () => {
  assert.deepEqual(toWhisperLines("Not started: Brea | Playing: Ayla"), ["Not started: Brea | Playing: Ayla"]);
});

test("toWhisperLines: 600 characters give 3 lines of at most 233", () => {
  const text = Array.from({ length: 100 }, (_, index) => `w${String(index).padStart(3, "0")}`).join(" ").slice(0, 600).trimEnd();
  const lines = toWhisperLines(text);
  assert.equal(lines.length, 3);
  for (const part of lines) assert.ok(part.length > 0 && part.length <= 233, `${part.length}`);
  assert.equal(lines.join(" "), text, "no word lost or cut");
});

test("toWhisperLines: cuts at the last ' | ' that fits, then ', ', then a space", () => {
  const pipe = `${"a".repeat(30)} | ${"b".repeat(30)}`;
  assert.deepEqual(toWhisperLines(pipe, 40), ["a".repeat(30), "b".repeat(30)]);
  const comma = `${"a".repeat(30)}, ${"b".repeat(30)}`;
  assert.deepEqual(toWhisperLines(comma, 40), [`${"a".repeat(30)},`, "b".repeat(30)]);
  const space = `${"a".repeat(30)} ${"b".repeat(30)}`;
  assert.deepEqual(toWhisperLines(space, 40), ["a".repeat(30), "b".repeat(30)]);
});

test("toWhisperLines: a text without any break point is cut at maxChars", () => {
  assert.deepEqual(toWhisperLines("x".repeat(25), 10, 4), ["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
});

test("toWhisperLines: past maxLines the last line ends with ... and still fits", () => {
  const lines = toWhisperLines("word ".repeat(400), 233, 4);
  assert.equal(lines.length, 4);
  assert.ok(lines[3]!.endsWith("..."));
  for (const part of lines) assert.ok(part.length <= 233);
});

test("toWhisperLines: line breaks and control characters become spaces and no line is empty", () => {
  assert.deepEqual(toWhisperLines("a\nb\r\nc\td"), ["a b c d"]);
  assert.deepEqual(toWhisperLines(""), []);
  assert.deepEqual(toWhisperLines("   \n  "), []);
  for (const part of toWhisperLines(`${"x ".repeat(300)}`, 20, 4)) assert.ok(part.length > 0 && part === part.trim());
});

test("toWhisperLines: never splits a surrogate pair", () => {
  const lines = toWhisperLines("😀".repeat(30), 11, 10);
  for (const part of lines) assert.ok(!/[\uD800-\uDBFF]$/u.test(part) && !/^[\uDC00-\uDFFF]/u.test(part), part);
});
