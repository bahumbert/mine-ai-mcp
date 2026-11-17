// Measure fight limits and target-specific retry pauses against a pacing, invulnerable attacker.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { observeExecution } from "../../../src/execution/execution-scope.ts";
import { STALE_AGE_TICKS } from "../../../src/world/world-age.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/**
 * Longest world-age span of a passing run: 1836 ticks at 20 tps (the still-span line of the patch; the driver's own `ageTicks` 1820), 929 at 10 tps
 * (2026-11-16, 3 runs each, `--lock --lanes 1`). 1.5 x 1836 = 2754, rounded up to 20: the bound of the poll, the goal's own 138 s timeout in ticks.
 */
export const MAX_FIGHT_TICKS = 2760;

/** A `no_progress` stand-down's fight, and the pauses after the first and the second (the owner's values of 2026-10-19 at 20 tps: 30 s, 10 s, 20 s). */
const NO_PROGRESS_FIGHT_TICKS = 600;
const PAUSE_TICKS = 200;

/** A fight's world age at its start and at its end (null while it runs), read at its execution events. */
export interface AgedFight {
  readonly startAge: number;
  readonly endAge: number | null;
}

/**
 * The problems of the first two fights (both end with `no_progress`; the driver asserts it first) and their pauses to the next fight. A
 * cached age is up to `STALE_AGE_TICKS` old, so each measured span may be that much short of its true length.
 */
export function spanProblems(fights: readonly AgedFight[]): string[] {
  const problems: string[] = [];
  for (const index of [0, 1]) {
    const fight = fights[index];
    if (!fight || fight.endAge === null) { problems.push(`fight ${index} has no end`); continue; }
    const span = fight.endAge - fight.startAge;
    const minimum = NO_PROGRESS_FIGHT_TICKS - STALE_AGE_TICKS;
    if (span < minimum) problems.push(`fight ${index} spans ${span} ticks (ages ${fight.startAge} to ${fight.endAge}), need ${minimum}`);
    const next = fights[index + 1];
    if (!next) continue;
    const pause = PAUSE_TICKS * 2 ** index - STALE_AGE_TICKS;
    const gap = next.startAge - fight.endAge;
    if (gap < pause) problems.push(`pause ${index} is ${gap} ticks (ages ${fight.endAge} to ${next.startAge}), need ${pause}`);
  }
  return problems;
}

/** True when `spanProblems` finds none: each no_progress fight and each pause lasts its world ticks at any server rate. */
export function spansHold(fights: readonly AgedFight[]): boolean {
  return spanProblems(fights).length === 0;
}

/** Observe actual physical fight starts; polling durable outcomes verifies why the preceding claims ended. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay) {
  const fights: { scope: string; target: number | null; start: number; end: number | null; startAge: number; endAge: number | null }[] = [];
  const limits: string[] = [];
  const began = monotonicNow();
  // The poll's bound is the server's age (S1); `lastAdvance` is the monotonic backstop for a server clock that stopped.
  const startAge = context.bot.time.age;
  let lastAge = startAge;
  let lastAdvance = began;
  const stop = observeExecution(event => {
    if (event.owner.bot !== context.bot.username || event.owner.operation !== "combat") return;
    const fight = fights.find(fight => fight.scope === event.scopeId);
    const at = monotonicNow() - began;
    if (event.kind === "closed") { if (fight) { fight.end = at; fight.endAge = context.bot.time.age; } return; }
    if (!fight) fights.push({ scope: event.scopeId, target: event.owner.targetId, start: at, end: null, startAge: context.bot.time.age, endAge: null });
  });
  try {
    const health = context.bot.health;
    while (fights.length < 3) {
      const age = context.bot.time.age;
      if (age !== lastAge) { lastAge = age; lastAdvance = monotonicNow(); }
      if (age - startAge > MAX_FIGHT_TICKS) break;
      // wall bound: the stall backstop counts from the last world-age advance, for a server clock that has stopped.
      assert.ok(monotonicNow() - lastAdvance < DRIVER_CLOCK_STOPPED_MS,
        `server clock stopped: world age ${age} has not moved for ${DRIVER_CLOCK_STOPPED_MS} ms, ${age - startAge} ticks after the start; ${JSON.stringify({ fights, limits })}`);
      const page = readRecentEventsResultSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
      for (const event of page.events) {
        if (event.type !== "survival_outcome" || event.payload.source !== "hostile_reflex") continue;
        const outcome = z.object({ outcome: z.object({ kind: z.literal("limit"), limit: z.string() }) }).safeParse(event.payload.evidence);
        if (outcome.success) limits.push(outcome.data.outcome.limit);
      }
      assert.equal(context.bot.health, health, "neither side deals damage in this fixture");
      await sleep(100);
    }
    assert.equal(fights.length, 3, JSON.stringify({ fights, limits }));
    assert.deepEqual(limits.slice(0, 2), ["no_progress", "no_progress"]);
    for (const index of [0, 1]) assert.equal(fights[index + 1]!.target, fights[index]!.target, "retry the same target");
    // Physical release closes synchronously before the reflex records its limit and begins the pause.
    const problems = spanProblems(fights);
    assert.ok(spansHold(fights), `${problems.join("; ")}: ${JSON.stringify({ fights, limits })}`);
    return { status: "succeeded" as const, detail: JSON.stringify({ fights, limits, elapsedMs: monotonicNow() - began, ageTicks: context.bot.time.age - startAge }) };
  } finally {
    stop();
    await context.call("cancel_foreground_action", {});
  }
}
