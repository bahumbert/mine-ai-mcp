// Expected route failures must be action-owned failures without a relaxed escape.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { navigateResultSchema } from "../../../src/actions/navigate/contract.ts";
import { formatNavigateResult } from "../../../src/actions/navigate/navigate.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./navigate-route.ts";

const DIGGING_OFF = "not dug because this request has digging off";
const NAVIGATION = {
  startDimension: "overworld", endDimension: "overworld", target: { x: 0, y: -45, z: 0 }, range: 0,
  start: { x: 0.5, y: -56, z: 0.5 }, end: { x: 0.5, y: -56, z: 0.5 }, remainingDistance: 11,
  elapsedMs: 1, scaffolding: [], bucketDrops: { count: 0, waterRecovered: 0 }, missingDigTools: [],
  digs: { count: 0, ms: 0, byHand: 0, byHandMs: 0, byHandBlocks: [], fasterWith: [] },
};

test("an expected failure accepts only the matching failed route with no relaxed escape evidence", async () => {
  const scenario = scenarioDefinitionSchema.parse({
    params: { legs: [{ label: "shut in", target: [0, -45, 0], range: 0, dig: false, expectFailure: DIGGING_OFF }] },
    goal: { kind: "completion" },
  });
  for (const { label, status, error, escapeRelaxed, want } of [
    { label: "relaxed escape", status: "failed", error: DIGGING_OFF, escapeRelaxed: ["dig_straight_down"], want: "failed" },
    { label: "present empty receipt", status: "failed", error: DIGGING_OFF, escapeRelaxed: [], want: "failed" },
    { label: "matching failure", status: "failed", error: DIGGING_OFF, want: "succeeded" },
    { label: "wrong reason", status: "failed", error: "unloaded", want: "failed" },
    { label: "partial", status: "partial", error: DIGGING_OFF, want: "failed" },
    { label: "cancelled", status: "cancelled", error: DIGGING_OFF, want: "failed" },
  ]) {
    const result = navigateResultSchema.parse({
      status, error,
      navigation: { ...NAVIGATION, ...(escapeRelaxed === undefined ? {} : { escapeRelaxed }) },
    });
    const context = scenarioTestContext({
      scenario,
      call: async () => ({ action: "navigate", durationMs: 1, result, summary: formatNavigateResult(result) }),
    });
    assert.equal((await run(context)).status, want, label);
  }
});
