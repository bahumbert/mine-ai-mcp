import assert from "node:assert/strict";
import test from "node:test";
import { fitSignLines } from "./sign-lines.ts";

test("fits sign text at word and code point boundaries and refuses private lines", () => {
  const cases: [string[], string[], string[]][] = [
    [["Welcome!", "Stay a while.", "Home sweet home."], ["Welcome!", "Stay a while.", "Home sweet", "home."], []],
    [["abcdefghijkl n"], ["abcdefghijkl n"], []],
    [["abcdefghijklm n"], ["abcdefghijklm n"], []],
    [["abcdefghijklmn n"], ["abcdefghijklmn", "n"], []],
    [["  Welcome  ", ""], ["Welcome"], []],
    [["123456789012345"], ["123456789012345"], []],
    [["1234567890123456"], ["123456789012345", "6"], []],
    [["Supercalifragilistic"], ["Supercalifragil", "istic"], []],
    [["aaaaaaaaaaaaaa😀"], ["aaaaaaaaaaaaaa", "😀"], []],
    [["-1 64 23", "a\nb"], [], ["-1 64 23", "a\nb"]],
  ];
  for (const [input, lines, refused] of cases) assert.deepEqual(fitSignLines(input, 15), { lines, refused });
});
