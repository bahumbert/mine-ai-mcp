import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_RESTART, type RestartSettings } from "./runtime-liveness.js";
import { decideRestart, NO_STREAK, readyAgain, type RestartDecision, type RestartStreak } from "./restart-policy.js";

// Times are ms since the host's start in run 34 (host start taken as 00:49:00Z; any start more than 10 min before
// 01:20Z gives the same answers). Host logs: run33-ollama/.tmp/r34/out/host-*.log.
const AT_0120_32_8 = 1_892_832; // Ayla's first failure, 01:20:32.8Z

const restartOf = (decision: RestartDecision) => {
  assert.equal(decision.kind, "restart");
  return decision as Extract<RestartDecision, { kind: "restart" }>;
};
const half = () => 0.5;

test("a first failure after ten minutes of play restarts within the first jitter", () => {
  const afterReady = readyAgain(NO_STREAK, 0);
  const decision = restartOf(decideRestart(afterReady, AT_0120_32_8, RUNTIME_RESTART, half));
  assert.equal(decision.attempt, 1);
  assert.equal(decision.of, 6);
  assert.equal(decision.delayMs, 2_500);
});

test("a second failure four minutes after the restart is attempt 2, 15-30 s later", () => {
  const first = restartOf(decideRestart(readyAgain(NO_STREAK, 0), AT_0120_32_8, RUNTIME_RESTART, half));
  // Bruno: attempt 1 at 01:20:32.5Z, ready again at 01:20:45Z (any time before 01:24:21Z gives the same), fails 01:24:21.762Z.
  const ready = readyAgain(first.streak, AT_0120_32_8 + 12_500);
  const failedAt = AT_0120_32_8 + 228_930; // 01:24:21.762Z
  const low = restartOf(decideRestart(ready, failedAt, RUNTIME_RESTART, () => 0));
  assert.equal(low.attempt, 2);
  assert.equal(low.delayMs, 15_000);
  assert.equal(restartOf(decideRestart(ready, failedAt, RUNTIME_RESTART, half)).delayMs, 22_500);
  assert.ok(restartOf(decideRestart(ready, failedAt, RUNTIME_RESTART, () => 0.999)).delayMs < 30_000);
});

test("a restart that misses its start-up deadline is the next attempt", () => {
  // Tom: attempt 1 at 01:20:27.665Z, no ready, fails 01:21:04.285Z.
  const first = restartOf(decideRestart(readyAgain(NO_STREAK, 0), AT_0120_32_8 - 5_167, RUNTIME_RESTART, half));
  const second = restartOf(decideRestart(first.streak, AT_0120_32_8 + 31_453, RUNTIME_RESTART, half));
  assert.equal(second.attempt, 2);
});

test("ten minutes of play after a restart starts a new streak", () => {
  const streak: RestartStreak = { attempts: 3, readyAt: 0 };
  assert.equal(restartOf(decideRestart(streak, 600_000, RUNTIME_RESTART, half)).attempt, 1);
  assert.equal(restartOf(decideRestart(streak, 599_999, RUNTIME_RESTART, half)).attempt, 4);
});

test("each attempt's delay lies in its own range", () => {
  const lows = [15_000, 60_000, 240_000, 300_000, 300_000];
  const highs = [30_000, 120_000, 480_000, 600_000, 600_000];
  for (let attempt = 2; attempt <= 6; attempt++) {
    const streak: RestartStreak = { attempts: attempt - 1, readyAt: null };
    const low = restartOf(decideRestart(streak, 0, RUNTIME_RESTART, () => 0));
    const high = restartOf(decideRestart(streak, 0, RUNTIME_RESTART, () => 0.999999));
    assert.equal(low.attempt, attempt);
    assert.equal(low.delayMs, lows[attempt - 2]);
    assert.ok(high.delayMs < highs[attempt - 2] && high.delayMs > highs[attempt - 2] - 100, `attempt ${attempt}: ${high.delayMs}`);
  }
});

test("past the list the last range repeats", () => {
  const settings: RestartSettings = {
    delays: [{ minMs: 0, maxMs: 0 }, { minMs: 100, maxMs: 100 }],
    attempts: 4,
    healthyMs: 1_000,
  };
  let streak = NO_STREAK;
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const decision = restartOf(decideRestart(streak, 0, settings, half));
    delays.push(decision.delayMs);
    streak = decision.streak;
  }
  assert.deepEqual(delays, [0, 100, 100, 100]);
});

test("after six attempts in a row it gives up", () => {
  const decision = decideRestart({ attempts: 6, readyAt: null }, 0, RUNTIME_RESTART, half);
  assert.equal(decision.kind, "give_up");
  assert.equal(decision.of, 6);
});

test("a crash loop gives up after six tries, 15-31 min after its first failure", () => {
  for (const [random, expected] of [[0, 915_000], [0.999999, 1_835_000]] as const) {
    let streak = NO_STREAK;
    let failedAt = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const decision = restartOf(decideRestart(streak, failedAt, RUNTIME_RESTART, () => random));
      assert.equal(decision.attempt, attempt);
      failedAt += decision.delayMs; // The restarted runtime fails right away, no ready.
      streak = decision.streak;
    }
    if (random === 0) assert.equal(failedAt, expected);
    else assert.ok(failedAt < expected && failedAt > expected - 100, `sum ${failedAt}`);
    assert.equal(decideRestart(streak, failedAt, RUNTIME_RESTART, () => random).kind, "give_up");
  }
});
