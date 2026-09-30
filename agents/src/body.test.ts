import assert from "node:assert/strict";
import test from "node:test";
import { Body, toChatLine } from "./body.ts";
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
  const outcome = await new Body(runtime, () => undefined).act("send_message", { message: "hi" }, "test");
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(runtime.said, ["hi"]);
});

test("speech pre-empts interruptible movement, then is spoken", async () => {
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 1_000;
  const body = new Body(runtime, () => undefined);
  const walking = body.act("navigate", { x: 50, z: 0 }, "test", { interruptible: true });
  await until(() => runtime.submitted.length === 1);
  await body.say("Hello!");
  assert.deepEqual(await walking, { status: "cancelled", error: "cancelled by caller", preempted: true });
  assert.deepEqual(runtime.said, ["Hello!"]);
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
