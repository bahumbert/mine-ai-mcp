import assert from "node:assert/strict";
import test from "node:test";
import { endedForWantOfRoute } from "../skills/structure-audit.ts";

const audit = (left: unknown[]) => ({ structure: { left } });

test("a build that ended for want of a route is told from the audit's groups, never the error's words", () => {
  assert.equal(endedForWantOfRoute("[BUILD_STOPPED] The build stopped: x.", audit([{ reason: "not_reached", count: 2, named: [{ x: 1, y: 2, z: 3 }] }])), true, "cells still workable when the run stopped");
  assert.equal(endedForWantOfRoute("[BUILD_INCOMPLETE] 1 cell still wrong", audit([{ reason: "refused", count: 1, named: [{ x: 1, y: 2, z: 3, cause: "route" }] }])), true, "a cell refused for its route");
  assert.equal(endedForWantOfRoute("[BUILD_INCOMPLETE] 1 cell still wrong", audit([{ reason: "refused", count: 1, named: [{ x: 1, y: 2, z: 3, cause: "entity" }] }])), false, "a cow in the cell is no want of a route");
  assert.equal(endedForWantOfRoute("[BUILD_INCOMPLETE] 1 cell still wrong", audit([{ reason: "block_not_carried", count: 1, named: [] }])), false, "a block not carried either");
  assert.equal(endedForWantOfRoute("[BUILD_STOPPED] The build stopped: x.", undefined), false, "no audit");
  assert.equal(endedForWantOfRoute(undefined, audit([{ reason: "not_reached", count: 1, named: [] }])), false, "no error");
  assert.equal(endedForWantOfRoute("[NAVIGATION_STOPPED] no path", audit([{ reason: "not_reached", count: 1, named: [] }])), false, "another action's error");
});
