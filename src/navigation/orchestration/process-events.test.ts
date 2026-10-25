import assert from "node:assert/strict";
import test from "node:test";
import { describeCalculationFailure } from "./process-events.js";

/** What a model reads after a search that ran out of time or radius: the next move it has. */
const NEXT = ". Try a nearer target, or walk part of the way first and ask again.";

const search = { queued: 0, visited: 113132, farthestVisited: 40, generated: 191298, slices: 251, computeMs: 2000.18 };

const closest = {
  position: { x: 295, y: 32, z: -314 },
  heuristic: 42.9,
  routeCost: 912,
  basis: "best_heuristic_search_node" as const,
};

test("a calculation failure names what ran out and how close the search got", () => {
  assert.equal(
    describeCalculationFailure({ kind: "no_path", search, closest }),
    "no path found after 2000 ms compute; visited 113132 nodes, generated 191298; closest node was 295,32,-314",
  );
  assert.equal(
    describeCalculationFailure({
      kind: "search_limit",
      search,
      limit: { kind: "search_time", limit: 2000, observed: 2001, closest },
    }),
    "search timed out after 2000 ms compute (limit 2000 ms); no path or usable partial route found; visited 113132 nodes, generated 191298; closest node was 295,32,-314" + NEXT,
  );
});

test("a timed-out search whose nearest node is within 5 blocks of the start says what is known, not a dead end (run 13 R10)", () => {
  const text = describeCalculationFailure({
    kind: "search_limit",
    search,
    limit: { kind: "search_time", limit: 2000, observed: 2001, closest: { ...closest, withinStartBlocks: 5 } },
  });
  assert.match(
    text,
    /closest node was 295,32,-314; the node nearest the goal is within 5 blocks of where the bot stands, so no route found gets it more than 5 blocks nearer. Try a nearer target, or walk part of the way first and ask again.$/,
  );
  assert.doesNotMatch(text, /dead end|already stands/);
});

test("a radius-limited search near the start is not called a dead end either", () => {
  const text = describeCalculationFailure({
    kind: "search_limit",
    search,
    limit: { kind: "radius", limit: 64, observed: 3, closest: { ...closest, withinStartBlocks: 5 } },
  });
  assert.doesNotMatch(text, /dead end/);
  assert.match(text, /no route found gets it more than 5 blocks nearer/);
});

test("an exhausted search whose nearest node is within 3 blocks of the start is a dead end only because it ran out of places to go", () => {
  const text = describeCalculationFailure({
    kind: "no_path",
    search,
    closest: { ...closest, position: { x: 3, y: 63, z: 0 }, withinStartBlocks: 5 },
  });
  assert.match(text, /closest node was 3,63,0; the node nearest the goal is within 5 blocks of where the bot stands, so no route found gets it more than 5 blocks nearer; every reachable place was searched, so this direction is a dead end from here$/);
});

test("a calculation failure that followed a movement failure says what it was replanning around", () => {
  const after = {
    kind: "operation_failed" as const,
    stepId: "294,32,-312>294,32,-313",
    phase: "breaking" as const,
    observation: "The route planned to break with iron_pickaxe, which is not in the inventory.",
  };
  assert.equal(
    describeCalculationFailure({
      kind: "search_limit",
      search,
      limit: { kind: "search_time", limit: 2000, observed: 2001, closest },
      after,
    }),
    "search timed out after 2000 ms compute (limit 2000 ms); no path or usable partial route found; visited 113132 nodes, generated 191298; closest node was 295,32,-314, while replanning after a movement failure: " +
      "The route planned to break with iron_pickaxe, which is not in the inventory. Try a nearer target, or walk part of the way first and ask again.",
  );
});

test("a search timeout reports generic work counts without guessing why the goal failed", () => {
  const failure = Object.assign(
    { kind: "search_limit" as const, limit: { kind: "search_time" as const, limit: 2000, observed: 2001, closest } },
    { search: { queued: 0, visited: 113132, farthestVisited: 40, generated: 191298, slices: 251, computeMs: 2000.18 } },
  );
  assert.equal(
    describeCalculationFailure(failure),
    "search timed out after 2000 ms compute (limit 2000 ms); no path or usable partial route found; visited 113132 nodes, generated 191298; closest node was 295,32,-314" + NEXT,
  );
});

test("a dead end at the start names the refusals counted there instead of claiming a dead end (run 15 Dirk, Sana)", () => {
  const text = describeCalculationFailure({
    kind: "no_path",
    search: { ...search, visited: 1, farthestVisited: 0, generated: 1, startRefusals: { opens_into_liquid: 3, policy_dig_down: 1, under_water: 1 } },
    closest: { ...closest, position: { x: -549, y: 56, z: -50 }, withinStartBlocks: 5 },
  });
  assert.doesNotMatch(text, /dead end/);
  assert.match(text, /shut in at the start: 3 digs would open into water or lava, 1 refused by your rule against digging straight down, 1 under water$/);
});

test("a shore with an unreachable goal keeps its dead end even with a liquid refusal counted at the start", () => {
  const text = describeCalculationFailure({
    kind: "no_path",
    search: { ...search, visited: 9, farthestVisited: 3, generated: 9, startRefusals: { opens_into_liquid: 1 } },
    closest: { ...closest, position: { x: 1, y: 64, z: 0 }, withinStartBlocks: 5 },
  });
  assert.doesNotMatch(text, /shut in/);
  assert.match(text, /every reachable place was searched, so this direction is a dead end from here$/);
});

test("refusals counted at a start the search left are not claimed, and an empty count says nothing extra", () => {
  const far = { ...closest, position: { x: 3, y: 63, z: 0 } };
  assert.doesNotMatch(describeCalculationFailure({ kind: "no_path", search: { ...search, startRefusals: { protected: 2 } }, closest: far }), /shut in/);
  assert.doesNotMatch(describeCalculationFailure({ kind: "no_path", search: { ...search, startRefusals: {} }, closest: { ...far, withinStartBlocks: 5 } }), /shut in/);
});

test("a search that visited the start cell and the cell above it still names the refusals at the start (run 15 P2, Dirk)", () => {
  const text = describeCalculationFailure({
    kind: "no_path",
    search: { ...search, visited: 2, farthestVisited: 1, generated: 2, startRefusals: { opens_into_liquid: 3, policy_dig_down: 1 } },
    closest: { ...closest, position: { x: -549, y: 57, z: -50 }, withinStartBlocks: 5 },
  });
  assert.doesNotMatch(text, /dead end/);
  assert.match(text, /shut in at the start: /);
});

test("a search that ran out of time or radius names the model's next move, one that was exhausted does not need to", () => {
  const timeLimit = { kind: "search_time" as const, limit: 2000, observed: 2001, closest };
  const radiusLimit = { kind: "radius" as const, limit: 64, observed: 70, closest };
  for (const limit of [timeLimit, radiusLimit])
    assert.match(describeCalculationFailure({ kind: "search_limit", search, limit }), /\. Try a nearer target, or walk part of the way first and ask again\.$/);
  assert.doesNotMatch(describeCalculationFailure({ kind: "no_path", search, closest }), /Try a nearer target/);
});
