import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationResult } from "./navigate.js";
import { RouteOutcomes } from "./route-outcomes.js";

const completed: NavigationResult = { status: "completed", elapsedMs: 10 };
const routeFailed: NavigationResult = { status: "stopped", reason: "no path found", elapsedMs: 10, calculationFailed: true, routeFailed: true };
/** A route a caller or a tool loss ended: not the route's own failure. */
const stopped: NavigationResult = { status: "stopped", reason: "the pickaxe broke", elapsedMs: 10 };

test("a route that failed since the mark is a failed route", () => {
  const routes = new RouteOutcomes();
  const mark = routes.mark();
  routes.note(routeFailed);
  assert.equal(routes.failedSince(mark), true);
});

test("no route settled since the mark means no failed route, whatever failed before it", () => {
  const routes = new RouteOutcomes();
  routes.note(routeFailed);
  assert.equal(routes.failedSince(routes.mark()), false);
});

test("the last route to settle decides: a failed route followed by one that completed is not a failed route", () => {
  const routes = new RouteOutcomes();
  const mark = routes.mark();
  routes.note(routeFailed);
  routes.note(completed);
  assert.equal(routes.failedSince(mark), false);
});

test("a route stopped by its caller or a tool loss is not a failed route", () => {
  const routes = new RouteOutcomes();
  const mark = routes.mark();
  routes.note(stopped);
  assert.equal(routes.failedSince(mark), false);
});

test("note hands the result back unchanged, and one bot's routes are not another's", () => {
  const first = new RouteOutcomes();
  const second = new RouteOutcomes();
  const mark = second.mark();
  assert.equal(first.note(routeFailed), routeFailed);
  assert.equal(second.failedSince(mark), false);
});
