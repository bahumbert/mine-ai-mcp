import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING, toChatLine } from "./body.ts";
import { FakeRuntime, until } from "./testing.ts";

test("chat lines are single-line, never commands, and fit the 256-character limit", () => {
  assert.equal(toChatLine("  /op me\nplease \u00a7cnow "), "op me please cnow");
  const long = toChatLine(`${"word ".repeat(80)}end`);
  assert.ok(long.length <= 256);
  assert.ok(long.endsWith("..."));
  assert.equal(toChatLine(" \n "), "");
});

test("a result left unretrieved by an earlier brain run is settled before the new action", async () => {
  const runtime = new FakeRuntime();
  runtime.refuseNext = { state: "refused", code: "RESULT_NOT_RETRIEVED", error: "retrieve it", activeActionId: null, unretrievedActionId: "old" };
  const outcome = await new Body(runtime, () => undefined).act("navigate", { x: 1, z: 1 }, "test");
  assert.deepEqual(outcome, { status: "succeeded", error: null, preempted: false });
  assert.deepEqual(runtime.cancelled, ["old"]);
  assert.equal(runtime.submitted.length, 1);
});

test("a refusal without a blocking action is reported, not retried", async () => {
  const runtime = new FakeRuntime();
  runtime.refuseNext = { state: "refused", code: "NOT_CONNECTED", error: "offline", activeActionId: null, unretrievedActionId: null };
  const outcome = await new Body(runtime, () => undefined).act("navigate", { x: 1, z: 1 }, "test");
  assert.equal(outcome.status, "refused");
  assert.equal(runtime.submitted.length, 0);
});

test("a survival reflex holding the body is waited out, then the action runs", async () => {
  const runtime = new FakeRuntime();
  runtime.refuseNext = { state: "refused", code: "ACTION_BUSY", error: "body owner: hostile_reflex", activeActionId: null, unretrievedActionId: null };
  const outcome = await new Body(runtime, () => undefined).act("eat_food", { food_name: "bread" }, "test");
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["eat_food"]);
});

test("speech runs beside the work in progress: it neither cancels it nor waits for it", async () => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 1_000;
  const body = new Body(runtime, () => undefined, INSTANT_TYPING);
  const controller = new AbortController();
  let finished = false;
  const collecting = body.act("collect_block", { block_name: "oak_log", count: 10 }, "test", { signal: controller.signal }).then((outcome) => {
    finished = true;
    return outcome;
  });
  await until(() => runtime.submitted.length === 1);
  await body.say("Still chopping, one sec!");
  assert.deepEqual(runtime.said, ["Still chopping, one sec!"]);
  assert.deepEqual(runtime.cancelled, []);
  assert.equal(finished, false, "the collection is still running");
  controller.abort();
  await collecting;
});

test("a reply waits as long as typing it would take, thinking time included, and lines keep their order", async () => {
  const runtime = new FakeRuntime();
  const body = new Body(runtime, () => undefined, { msPerChar: 10, maxMs: 200 });
  const started = Date.now();
  const first = body.say("0123456789", started - 60);
  const second = body.say("hi");
  await Promise.all([first, second]);
  assert.deepEqual(runtime.said, ["0123456789", "hi"]);
  // The first line types 100 ms minus the 60 ms already spent thinking; "hi" was typed meanwhile.
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 35 && elapsed < 400, `took ${elapsed} ms`);
});

test("aborting the signal cancels a non-interruptible action", async () => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 1_000;
  const controller = new AbortController();
  const collecting = new Body(runtime, () => undefined).act("collect_block", { block_name: "oak_log" }, "test", { signal: controller.signal });
  await until(() => runtime.submitted.length === 1);
  controller.abort();
  const outcome = await collecting;
  assert.equal(outcome.status, "cancelled");
  assert.equal(outcome.preempted, false);
});
