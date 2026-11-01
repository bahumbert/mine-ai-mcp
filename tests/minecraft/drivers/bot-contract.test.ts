import test from "node:test";
import assert from "node:assert/strict";
import { holdsDetail } from "./bot-contract.ts";

test("a passing contract check's completion detail says it holds, and carries the note it returned", () => {
  assert.equal(holdsDetail("consume-food", undefined), "consume-food holds");
  assert.equal(holdsDetail("consume-food", "late-reading: tookTicks=32 roundTripMs=47 lateTicks=21"), "consume-food holds; late-reading: tookTicks=32 roundTripMs=47 lateTicks=21");
});
