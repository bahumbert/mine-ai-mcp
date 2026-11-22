// Tests of the no-gain watch's sampling hooks (plan 2026-11-07-p4-02c T2; the stop itself is held by agent/work-loop.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import type { Step } from "./actions.ts";
import { watchGain } from "./gain-watch.ts";
import type { BotSnapshot } from "./runtime-client.ts";
import { FakeRuntime, steppedClocks, until } from "./testing.ts";

const HUNT: Step = { skill: "hunt", mob: "glow_squid", drop: "ink_sac", count: 8 };

function watched(extra: { readonly onSnapshot?: readonly ((snapshot: BotSnapshot) => void)[] } = {}) {
  const runtime = new FakeRuntime();
  const controller = new AbortController();
  const logs: string[] = [];
  const watch = watchGain(HUNT, runtime.snapshot, controller, { runtime, log: (line) => logs.push(line), minutes: 5, sampleMs: 5, ...extra });
  return { runtime, controller, logs, watch };
}

test("each sampled snapshot reaches every onSnapshot listener", async (t) => {
  const first: BotSnapshot[] = [];
  const second: BotSnapshot[] = [];
  const { watch } = watched({ onSnapshot: [(snapshot) => first.push(snapshot), (snapshot) => second.push(snapshot)] });
  t.after(watch.stop);
  await until(() => first.length >= 2 && second.length >= 2);
  assert.deepEqual(first.slice(0, 2), second.slice(0, 2));
  assert.equal(first[0]?.health, 20);
});

test("a throwing listener is logged and the others still run", async (t) => {
  const seen: BotSnapshot[] = [];
  const { watch, logs } = watched({ onSnapshot: [() => { throw new Error("listener broke"); }, (snapshot) => seen.push(snapshot)] });
  t.after(watch.stop);
  await until(() => seen.length >= 1 && logs.length >= 1);
  assert.match(logs[0] ?? "", /listener broke/u);
});

test("a controller aborted by another silences it: no stall text, no relabelled reason, no more listeners", async (t) => {
  const clocks = steppedClocks(t);
  const seen: BotSnapshot[] = [];
  const { watch, controller } = watched({ onSnapshot: [(snapshot) => seen.push(snapshot)] });
  t.after(watch.stop);
  await until(() => seen.length >= 1);
  controller.abort(new Error("you died during this step at 1 2 3"));
  const sampled = seen.length;
  clocks.monotonic(6 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(watch.stalled(), null, "6 minutes with nothing gained after another abort is not a stall");
  assert.match((controller.signal.reason as Error).message, /you died/u);
  assert.equal(seen.length, sampled, "the sampler stops reading once the step is aborted");
});

test("the same silence with no abort still stalls (the control of the case above)", async (t) => {
  const clocks = steppedClocks(t);
  const { watch, controller } = watched();
  t.after(watch.stop);
  clocks.monotonic(6 * 60_000);
  await until(() => watch.stalled() !== null);
  assert.match((controller.signal.reason as Error).message, /nothing gained in 5 minutes/u);
});
