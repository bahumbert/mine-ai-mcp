import assert from "node:assert/strict";
import test from "node:test";
import { actionOutputSchema, actionResultSchema } from "./action.js";

const outputSchema = actionOutputSchema("x", actionResultSchema({}));

test("an action output refuses a negative duration", () => {
  const output = { action: "x", durationMs: -1, result: { status: "succeeded" } };
  assert.equal(outputSchema.safeParse(output).success, false);
  assert.equal(outputSchema.safeParse({ ...output, durationMs: 0 }).success, true);
});
