import assert from "node:assert/strict";
import test from "node:test";
import { attachKillOnClose } from "./job-object.ts";

test("attachKillOnClose does nothing and answers false off Windows", () => {
  assert.equal(attachKillOnClose("linux"), false);
  assert.equal(attachKillOnClose("darwin"), false);
});
