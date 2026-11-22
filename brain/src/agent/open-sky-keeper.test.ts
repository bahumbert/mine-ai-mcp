// The open-sky report setting follows the bot's night: on from its dusk point until the night is handled.
import assert from "node:assert/strict";
import test from "node:test";
import type { BotRuntime, BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { keepOpenSkyReport } from "./open-sky-keeper.ts";

const base = new FakeRuntime().snapshot;

/** A snapshot whose policy is the runtime's: its revision and the report setting it shows (undefined: an older runtime). */
function snapshot(reportOpenSky: boolean | undefined, revision = "r1"): BotSnapshot {
  return { ...base, policy: { revision, digStraightDown: false, reportOpenSky } };
}

/** The night facts the keeper reads from the watch, changed by each test; only those three are used. */
function watchStub() {
  const state = { active: false, handled: false, key: 1 };
  const watch = { nightActive: () => state.active, nightHandled: () => state.handled, nightKey: () => state.key };
  return { watch, state };
}

/** Runtime that records each set; `answer` gives its result (or throws when it is an Error). */
function runtimeStub(answer: boolean | Error = true) {
  const calls: { on: boolean; revision: string }[] = [];
  const runtime = {
    setReportOpenSky: async (on: boolean, revision: string) => {
      calls.push({ on, revision });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as Pick<BotRuntime, "setReportOpenSky">;
  return { runtime, calls };
}

for (const [name, active, reported, sent] of [
  ["by day the report is off: on reported, one set off", false, true, { on: false, revision: "r1" }],
  ["by day an off report is left alone", false, false, null],
  ["from the dusk point it is on, sent only when it differs: one set on", true, false, { on: true, revision: "r1" }],
  ["from the dusk point an on report is left alone", true, true, null],
] as const) {
  test(name, async () => {
    const { watch, state } = watchStub();
    const { runtime, calls } = runtimeStub();
    state.active = active;
    await keepOpenSkyReport(snapshot(reported), watch, runtime, () => undefined);
    await keepOpenSkyReport(snapshot(sent === null ? reported : sent.on), watch, runtime, () => undefined);
    assert.deepEqual(calls, sent === null ? [] : [sent]);
  });
}

test("the report is off once the night is handled and on again next dusk", async () => {
  const { watch, state } = watchStub();
  const { runtime, calls } = runtimeStub();
  const log = () => undefined;
  state.active = true;
  await keepOpenSkyReport(snapshot(false), watch, runtime, log);
  state.handled = true;
  await keepOpenSkyReport(snapshot(true, "r2"), watch, runtime, log);
  state.active = false;
  state.handled = false;
  await keepOpenSkyReport(snapshot(false, "r3"), watch, runtime, log);
  state.key = 2;
  state.active = true;
  await keepOpenSkyReport(snapshot(false, "r3"), watch, runtime, log);
  assert.deepEqual(calls, [{ on: true, revision: "r1" }, { on: false, revision: "r2" }, { on: true, revision: "r3" }]);
});

test("a refused set is sent again at the next observe with its revision", async () => {
  const { watch, state } = watchStub();
  const { runtime, calls } = runtimeStub(false);
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  state.active = true;
  await keepOpenSkyReport(snapshot(false, "r1"), watch, runtime, log);
  await keepOpenSkyReport(snapshot(false, "r2"), watch, runtime, log);
  assert.deepEqual(calls, [{ on: true, revision: "r1" }, { on: true, revision: "r2" }]);
  assert.equal(logs.length, 1);
});

test("one set in flight: a newer observation waits for it, and a late refusal logs once per night", async () => {
  const { watch, state } = watchStub();
  const answers: ((value: boolean) => void)[] = [];
  const calls: { on: boolean; revision: string }[] = [];
  const runtime = {
    setReportOpenSky: (on: boolean, revision: string) => {
      calls.push({ on, revision });
      return new Promise<boolean>((resolve) => { answers.push(resolve); });
    },
  } as Pick<BotRuntime, "setReportOpenSky">;
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  state.active = true;
  const first = keepOpenSkyReport(snapshot(false, "r1"), watch, runtime, log);
  state.key = 2;
  const second = keepOpenSkyReport(snapshot(false, "r1"), watch, runtime, log);
  assert.equal(calls.length, 1, "the newer observation waits while the first set is in flight");
  answers[0]!(false);
  await Promise.all([first, second]);
  assert.equal(logs.length, 1);
  const third = keepOpenSkyReport(snapshot(false, "r2"), watch, runtime, log);
  assert.deepEqual(calls[1], { on: true, revision: "r2" });
  answers[1]!(false);
  await third;
  assert.equal(logs.length, 2, "night 2 is logged once, its own line");
});

test("a throwing set is logged once per night and reset the next night", async () => {
  const { watch, state } = watchStub();
  const { runtime, calls } = runtimeStub(new Error("runtime down"));
  const logs: string[] = [];
  const log = (line: string) => logs.push(line);
  state.active = true;
  await keepOpenSkyReport(snapshot(false), watch, runtime, log);
  await keepOpenSkyReport(snapshot(false), watch, runtime, log);
  assert.equal(calls.length, 2);
  assert.equal(logs.length, 1);
  state.key = 2;
  await keepOpenSkyReport(snapshot(false), watch, runtime, log);
  assert.equal(calls.length, 3);
  assert.equal(logs.length, 2);
});

test("an older runtime without the field: nothing sent", async () => {
  const { watch, state } = watchStub();
  const { runtime, calls } = runtimeStub();
  state.active = true;
  await keepOpenSkyReport(snapshot(undefined), watch, runtime, () => undefined);
  await keepOpenSkyReport({ ...base, policy: null }, watch, runtime, () => undefined);
  assert.deepEqual(calls, []);
});
