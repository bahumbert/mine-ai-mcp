/**
 * `afterGameTicks` waits on the server's own clock through `serverGameTime`, so it has the stall bound of every wait on server work
 * (`server-answer.ts` `ANSWER_WALL_MS`): a server that stops, or a game time that stands still, fails the check with its own message
 * instead of looping for ever (plan 2026-11-16-bench-findings-fixes T8, G19). The bound counts from the last advance of the game time.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, fakeContractSubject } from "../subject.ts";
import { afterGameTicks } from "./combat-data-measure.ts";

const FIXTURE = { cells: {}, carried: {}, position: [0.5, -60, 0.5] } as const;
const WANTED_TICKS = 60;
/** The fake clock's outer bound for a call that must end by itself: past the stall bound plus the slices that detect it. */
const OUTER_MS = ANSWER_WALL_MS + 6_000;
/** A failure comes at the stall bound plus at most this much of slicing (`settleWithin` steps 25 ms, `settle` 50 ms). */
const SLICE_MS = 150;

/** A fake subject whose waits run on the harness clock, so `clock.settle` drives the wait and the check's own bound ends it. */
function subjectOn(ticksPerSecond: number) {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(FIXTURE, frame, { ticksPerSecond });
  const subject = { ...fakeContractSubject(harness, frame), wait: (ms: number) => harness.clock.sleep(ms) };
  return { harness, subject };
}

for (const ticksPerSecond of [20, 10]) {
  test(`afterGameTicks returns once the server ran ${WANTED_TICKS} ticks, at ${ticksPerSecond} tps`, async () => {
    const { harness, subject } = subjectOn(ticksPerSecond);
    using _installed = harness.clock.install();
    const since = harness.server.gameTime;
    const startMs = harness.clock.now();
    await harness.clock.settle(afterGameTicks(subject, since, WANTED_TICKS), OUTER_MS);
    assert.ok(harness.server.gameTime - since >= WANTED_TICKS, `the server ran ${harness.server.gameTime - since} of ${WANTED_TICKS} ticks`);
    const runMs = (WANTED_TICKS / ticksPerSecond) * 1_000;
    assert.ok(harness.clock.now() - startMs <= runMs + SLICE_MS, `${harness.clock.now() - startMs} ms for ${runMs} ms of server ticks`);
  });
}

/** The boundary on scripted answers, so it does not depend on which ticks a rate's answers land on: the answer at `since + ticks` ends the wait, one tick short asks again. */
for (const [name, answers, asked] of [
  ["one tick short asks again", [58, 59, 60], 3],
  ["the answer at the target ends the wait", [59, 60, 61], 2],
] as const) {
  test(`afterGameTicks boundary: ${name}`, async () => {
    const { harness, subject } = subjectOn(20);
    using _installed = harness.clock.install();
    const since = harness.server.gameTime;
    let calls = 0;
    const scripted = { ...subject, serverGameTime: () => Promise.resolve(since + answers[Math.min(calls++, answers.length - 1)]!) };
    await harness.clock.settle(afterGameTicks(scripted, since, WANTED_TICKS), OUTER_MS);
    assert.equal(calls, asked);
  });
}

/** One fault the wait must end by its own message, and when: `failsAtMs` is the interval after the call, from the stall's start (the last advance of the game time, or the call). */
interface StallRow {
  readonly name: string;
  readonly ticks: number;
  /** Sets the fault up on the harness and returns the subject the check asks. */
  readonly fault: (h: ReturnType<typeof subjectOn>["harness"], subject: ContractSubject, since: number) => ContractSubject;
  readonly failsAtMs: readonly [from: number, to: number];
}

const STOP_AT_MS = 2_000;
const FREEZE_AFTER_TICKS = 20;
const SILENT_AFTER_MS = 9_000;
const STALLS: readonly StallRow[] = [
  {
    name: "the query never answers: the server stopped before the call",
    ticks: WANTED_TICKS,
    fault: (h, subject) => (h.server.stop(), subject),
    failsAtMs: [ANSWER_WALL_MS, ANSWER_WALL_MS + SLICE_MS],
  },
  {
    name: "the server stops after progress: the bound counts from the last advance, not from the call",
    ticks: 1_000,
    fault: (h, subject) => (h.clock.after(STOP_AT_MS, () => h.server.stop()), subject),
    failsAtMs: [STOP_AT_MS + ANSWER_WALL_MS, STOP_AT_MS + ANSWER_WALL_MS + 2 * SLICE_MS],
  },
  {
    name: "answers keep coming but the game time stands still",
    ticks: WANTED_TICKS,
    fault: (_h, subject, since) => ({ ...subject, serverGameTime: () => Promise.resolve(since) }),
    failsAtMs: [ANSWER_WALL_MS, ANSWER_WALL_MS + SLICE_MS],
  },
  {
    name: "the game time advances, then freezes: the bound counts from the advance",
    ticks: WANTED_TICKS,
    fault: (_h, subject, since) => ({ ...subject, serverGameTime: () => subject.serverGameTime().then((age) => Math.min(age, since + FREEZE_AFTER_TICKS)) }),
    failsAtMs: [ANSWER_WALL_MS + 900, ANSWER_WALL_MS + 1_000 + 2 * SLICE_MS],
  },
  {
    name: "unchanged answers do not renew the bound when the next query stops answering",
    ticks: WANTED_TICKS,
    fault: (h, subject, since) => {
      const startMs = h.clock.now();
      h.server.stop();
      return { ...subject, serverGameTime: () => (h.clock.now() - startMs < SILENT_AFTER_MS ? Promise.resolve(since) : subject.serverGameTime()) };
    },
    failsAtMs: [ANSWER_WALL_MS, ANSWER_WALL_MS + SLICE_MS],
  },
];

for (const row of STALLS) {
  test(`afterGameTicks fails by its own message within the wall bound: ${row.name}`, async () => {
    const { harness, subject } = subjectOn(20);
    using _installed = harness.clock.install();
    const since = harness.server.gameTime;
    const startMs = harness.clock.now();
    const faulty = row.fault(harness, subject, since);
    // The check's own failure, not the clock's outer "did not settle": `afterGameTicks: ... moved <seen> of <wanted> ticks`.
    await assert.rejects(harness.clock.settle(afterGameTicks(faulty, since, row.ticks), OUTER_MS), new RegExp(`afterGameTicks: .*moved \\d+ of ${row.ticks} ticks`));
    const failedAfterMs = harness.clock.now() - startMs;
    assert.ok(failedAfterMs >= row.failsAtMs[0] && failedAfterMs <= row.failsAtMs[1], `failed ${failedAfterMs} ms after the call; wanted ${row.failsAtMs.join(" to ")}`);
  });
}

test("afterGameTicks names the ticks seen when the server's query rejects", async () => {
  const { harness, subject } = subjectOn(20);
  using _installed = harness.clock.install();
  const since = harness.server.gameTime;
  const rejecting = { ...subject, serverGameTime: () => Promise.reject(new Error("/time query gametime: no answer after 3000 ms")) };
  await assert.rejects(harness.clock.settle(afterGameTicks(rejecting, since, WANTED_TICKS), OUTER_MS), /afterGameTicks: .*moved 0 of 60 ticks, then the game time query failed: .*no answer after 3000 ms/);
});
