// Tests which resource a finished search reports as exhausted.
import assert from "node:assert/strict";
import test from "node:test";
import type { SearchUpdate } from "../search/search.js";
import type { SearchLimitEvidence } from "./outcome.js";
import { searchFinishedEvent } from "./search-events.js";

const evidence = { queued: 0, visited: 7, farthestVisited: 3, generated: 9, slices: 1, computeMs: 4 };
const closest = {
  position: { x: 1, y: 63, z: 2 }, heuristic: 5, routeCost: 6, basis: "best_heuristic_search_node" as const,
};

const limitUpdate = (limit: SearchLimitEvidence): Exclude<SearchUpdate, { kind: "progress" }> =>
  ({ kind: "limit", limit, evidence });

test("a finished search names the resource it exhausted", () => {
  const region: SearchLimitEvidence = { kind: "region", limit: 20, observed: 31.5, straight: 8, part: 0, closest };
  const regionEvent = searchFinishedEvent("s1", "near:8,63,0", limitUpdate(region));
  assert.equal(regionEvent.exhausted, "region");
  assert.deepEqual(regionEvent.limit, region);
  assert.equal(searchFinishedEvent("s1", "g", limitUpdate({ kind: "radius", limit: 32, observed: 33, closest })).exhausted, "radius");
  assert.equal(searchFinishedEvent("s1", "g", limitUpdate({ kind: "search_time", limit: 2000, observed: 2001, closest })).exhausted, "compute_time");
  const noPath = searchFinishedEvent("s1", "g", { kind: "no_path", closest, evidence });
  assert.equal(noPath.exhausted, "frontier");
  assert.equal(noPath.limit, null);
});
