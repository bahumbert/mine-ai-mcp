import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING, toChatLines } from "./body.ts";
import { FakeRuntime, until } from "./testing.ts";

test("chat lines are single-line, never commands, and fit the 256-character limit", () => {
  assert.deepEqual(toChatLines("  /op me\nplease §cnow "), ["op me please cnow"]);
  assert.deepEqual(toChatLines(" \n "), []);
  const long = toChatLines(`${"word ".repeat(150)}end`);
  assert.equal(long.length, 2);
  assert.ok(long.every((line) => line.length <= 256));
  assert.ok(long[1]!.endsWith("..."), "an answer longer than two lines ends cut");
});

test("an answer over 256 characters is split at a sentence end into two lines, not cut", () => {
  const first = `${"Je vais chercher du bois pour la maison".padEnd(210, " et")}.`;
  const second = "Ensuite je construis les murs, puis le toit !";
  assert.deepEqual(toChatLines(`${first} ${second}`), [first, second]);
  // No sentence end that fits: split at a word, and nothing is lost.
  const run = `${"word ".repeat(40)}end`;
  const words = toChatLines(`${run} ${run}`);
  assert.equal(words.length, 2);
  assert.ok(words[0]!.length <= 256 && !words[0]!.endsWith(" "));
  assert.equal(`${words[0]} ${words[1]}`, `${run} ${run}`);
});

test("a whisper is split to a shorter limit, so each line is one /tell command", () => {
  const lines = toChatLines(`${"abc. ".repeat(60)}end`, 233);
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.length <= 233));
});

test("a long reply is sent as two lines in order, and a whisper goes to its player", async () => {
  const runtime = new FakeRuntime();
  const body = new Body(runtime, () => undefined, INSTANT_TYPING);
  await body.say(`${"A".repeat(200)}. ${"B".repeat(100)}.`);
  assert.deepEqual(runtime.said, [`${"A".repeat(200)}.`, `${"B".repeat(100)}.`]);
  await body.say("psst", Date.now(), "Tom");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "send_message").map((call) => call.input.to), [undefined, undefined, "Tom"]);
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

test("every foreground action is reported once it ends, with how long it ran, failed ones too", async () => {
  const runtime = new FakeRuntime();
  runtime.durations = { collect_block: 1 };
  runtime.failures = { craft_item: "[CRAFT_FAILED] no table" };
  const body = new Body(runtime, () => undefined);
  const seen: [string, unknown, number][] = [];
  body.onAction = (tool, input, ms) => seen.push([tool, input, ms]);
  await body.act("collect_block", { block_name: "stone", count: 1 }, "test");
  await body.act("craft_item", { items: [] }, "test");
  assert.deepEqual(seen.map(([tool, input]) => [tool, input]), [["collect_block", { block_name: "stone", count: 1 }], ["craft_item", { items: [] }]]);
  assert.ok(seen.every(([, , ms]) => ms >= 0));
});

test("a shout is sent with shout; with a whisper target it is a plain whisper", async () => {
  const runtime = new FakeRuntime();
  const body = new Body(runtime, () => undefined, INSTANT_TYPING);
  await body.say("hello world", Date.now(), undefined, true);
  await body.say("psst", Date.now(), "Tom", true);
  await body.say("plain");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "send_message").map((call) => call.input), [
    { message: "hello world", shout: true },
    { message: "psst", to: "Tom" },
    { message: "plain" },
  ]);
});
