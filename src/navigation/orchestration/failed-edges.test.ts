import assert from "node:assert/strict";
import test from "node:test";
import { FAILED_EDGE_MEMORY_MS, FailedEdges } from "./failed-edges.js";

const from = { x: -644, y: 61, z: -78 };
const to = { x: -643, y: 61, z: -78 };

test("an edge that failed is refused for ten minutes of the wall clock and then forgotten", () => {
  let now = 1_000;
  const edges = new FailedEdges(() => now);
  assert.equal(edges.isFailed("swim", from, to), false);
  edges.record("swim", from, to, from);
  assert.equal(edges.isFailed("swim", from, to), true);
  assert.equal(edges.isFailed("walk", from, to), false, "another kind of move over the same cells is another edge");
  now += FAILED_EDGE_MEMORY_MS - 1;
  assert.equal(edges.isFailed("swim", from, to), true);
  now += 1;
  assert.equal(edges.isFailed("swim", from, to), false);
});

test("a success of the same edge clears it", () => {
  const edges = new FailedEdges(() => 0);
  edges.record("swim", from, to, from);
  edges.succeeded("swim", from, to);
  assert.equal(edges.isFailed("swim", from, to), false);
});

test("a move of four blocks or more from where it failed clears it; a nearer one does not", () => {
  const edges = new FailedEdges(() => 0);
  edges.record("swim", from, to, from);
  edges.noteBotAt({ x: from.x + 3, y: from.y, z: from.z });
  assert.equal(edges.isFailed("swim", from, to), true);
  edges.noteBotAt({ x: from.x + 4, y: from.y, z: from.z });
  assert.equal(edges.isFailed("swim", from, to), false);
});

test("each bot has its own memory", () => {
  const mine = new FailedEdges(() => 0);
  const theirs = new FailedEdges(() => 0);
  mine.record("swim", from, to, from);
  assert.equal(theirs.isFailed("swim", from, to), false);
});
