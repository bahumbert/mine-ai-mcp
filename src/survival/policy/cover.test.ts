import assert from "node:assert/strict";
import test from "node:test";
import { changesSchema, DEFAULT_NAVIGATION_POLICY, navigationPolicySchema } from "./contract.js";

test("open-sky reporting defaults off and accepts a boolean policy override", () => {
  assert.equal(navigationPolicySchema.parse(DEFAULT_NAVIGATION_POLICY).report_open_sky, false);
  assert.deepEqual(changesSchema.parse({ navigation: { report_open_sky: true } }), { navigation: { report_open_sky: true } });
  assert.equal(changesSchema.safeParse({ navigation: { report_open_sky: "true" } }).success, false);
});
