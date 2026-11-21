// The receipt of a reflex limit carries the world ticks it counted (plan 2026-11-16-reflex-limits-ticks T2); a receipt
// written before the field existed still parses, and a text for the ticks does not.
import assert from "node:assert/strict";
import test from "node:test";
import { bodyAbortCauseSchema, requestSchema } from "./contract.js";

const limit = { kind: "reflex_limit", reflex: "hostile_reflex", limit: "no_progress", elapsedMs: 12_000 } as const;

const request = {
  id: "r1",
  requestId: 1,
  action: "collect_mob_drop",
  admittedAt: 0,
  objective: null,
  state: { kind: "running" },
  evidence: {
    baseline: {},
    checkpoint: {},
    completion: { kind: "current", observed: false, owes: "Net gain still carried." },
    objective: null,
  },
} as const;

test("a request publishes goalMet as a boolean on its evidence and refuses any other value", () => {
  const withGoal = { ...request, evidence: { ...request.evidence, goalMet: true } };
  assert.equal(requestSchema.parse(withGoal).evidence?.goalMet, true);
  assert.equal(requestSchema.parse(request).evidence?.goalMet, undefined);
  assert.equal(requestSchema.safeParse({ ...request, evidence: { ...request.evidence, goalMet: "yes" } }).success, false);
});

test("a reflex_limit cause parses with elapsedTicks, with a null one and without one (a receipt from before the ticks), not with a text", () => {
  for (const cause of [{ ...limit, elapsedTicks: 120 }, { ...limit, elapsedTicks: null }, limit]) {
    assert.deepEqual(bodyAbortCauseSchema.parse(cause), cause);
  }
  assert.equal(bodyAbortCauseSchema.safeParse({ ...limit, elapsedTicks: "120" }).success, false);
});
