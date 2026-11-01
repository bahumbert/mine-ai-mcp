import assert from "node:assert/strict";
import test from "node:test";
import { fetchErrorText } from "./fetch-error.ts";

const BUN_HINT = "For more information, pass `verbose: true` in the second argument to fetch()";

for (const [label, error, expected] of [
  ["Bun's exact lost-connection text loses its hint", new Error(`The socket connection was closed unexpectedly. ${BUN_HINT}`), "The socket connection was closed unexpectedly."],
  ["a message without the hint stays as it is", new Error("Unable to connect. Is the computer able to access the url?"), "Unable to connect. Is the computer able to access the url?"],
  ["a message that is only the hint gives the cause's message", new Error(BUN_HINT, { cause: new Error("ECONNRESET") }), "ECONNRESET"],
  ["an empty message gives the cause's message", new Error("", { cause: new Error("ECONNREFUSED") }), "ECONNREFUSED"],
  ["an empty message with a cause that is not an Error gives the cause as text", new Error("", { cause: "refused" }), "refused"],
  ["a message with its own cause keeps the message only", new Error("fetch failed", { cause: new Error("ECONNRESET") }), "fetch failed"],
  ["a non-Error is shown as text", "boom", "boom"],
] as const) {
  test(`fetchErrorText: ${label}`, () => {
    assert.equal(fetchErrorText(error), expected);
  });
}

for (const [label, error, expected] of [
  ["an empty message and no cause gives the error's name, never an empty text", new Error(""), "Error"],
  ["a null cause gives the error's name", new Error("", { cause: null }), "Error"],
  ["a cause that is a plain object gives the error's name", new Error("", { cause: { code: 1 } }), "Error"],
  ["a named error with an empty message gives its name", Object.assign(new Error(""), { name: "TimeoutError" }), "TimeoutError"],
] as const) {
  test(`fetchErrorText: ${label}`, () => {
    assert.equal(fetchErrorText(error), expected);
  });
}

// A bound of 2 s: before the fix this loops for ever (tail calls never overflow the stack).
test("fetchErrorText: errors that are each other's cause end with the error's name", { timeout: 2_000 }, () => {
  const a = new Error("");
  const b = new Error("");
  a.cause = b;
  b.cause = a;
  assert.equal(fetchErrorText(a), "Error");
});
