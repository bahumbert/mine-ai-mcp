// The receipt of a reflex limit carries the world ticks it counted (plan 2026-11-16-reflex-limits-ticks T2); a receipt
// written before the field existed still parses, and a text for the ticks does not.
import assert from "node:assert/strict";
import test from "node:test";
import { bodyAbortCauseSchema } from "./contract.js";

const limit = { kind: "reflex_limit", reflex: "hostile_reflex", limit: "no_progress", elapsedMs: 12_000 } as const;

test("a reflex_limit cause parses with elapsedTicks, with a null one and without one (a receipt from before the ticks), not with a text", () => {
  for (const cause of [{ ...limit, elapsedTicks: 120 }, { ...limit, elapsedTicks: null }, limit]) {
    assert.deepEqual(bodyAbortCauseSchema.parse(cause), cause);
  }
  assert.equal(bodyAbortCauseSchema.safeParse({ ...limit, elapsedTicks: "120" }).success, false);
});
