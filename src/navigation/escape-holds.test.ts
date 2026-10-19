import assert from "node:assert/strict";
import test from "node:test";
import { EscapeHolds } from "./escape-holds.js";

test("routes are escapes while any hold is open, and a hold released twice counts once", () => {
  const holds = new EscapeHolds();
  assert.equal(holds.active, false);
  const first = holds.hold();
  const second = holds.hold();
  first[Symbol.dispose]();
  first[Symbol.dispose]();
  assert.equal(holds.active, true, "the second hold is still open");
  second[Symbol.dispose]();
  assert.equal(holds.active, false);
});
