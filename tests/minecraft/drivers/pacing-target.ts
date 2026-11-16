// Measure fight limits and target-specific retry pauses against a pacing, invulnerable attacker.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { observeExecution } from "../../../src/execution/execution-scope.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/**
 * Longest world-age span of a passing run: 1836 ticks at 20 tps (the still-span line of the patch; the driver's own `ageTicks` 1820), 929 at 10 tps
 * (2026-11-16, 3 runs each, `--lock --lanes 1`). 1.5 x 1836 = 2754, rounded up to 20: the bound of the poll, the goal's own 138 s timeout in ticks.
 */
export const MAX_FIGHT_TICKS = 2760;

/** Observe actual physical fight starts; polling durable outcomes verifies why the preceding claims ended. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay) {
  const fights: { scope: string; target: number | null; start: number; end: number | null }[] = [];
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
    if (event.kind === "closed") { if (fight) fight.end = at; return; }
    if (!fight) fights.push({ scope: event.scopeId, target: event.owner.targetId, start: at, end: null });
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
    // wall bound: the product's stand-down is wall time (limits.ts:5 `COMBAT_LIMITS`) until the reflex-limits plan converts it to server ticks.
    for (const [index, pause] of [[0, 10_000], [1, 20_000]] as const) {
      const fight = fights[index]!;
      assert.notEqual(fight.end, null, "the preceding physical fight must finish");
      assert.equal(fights[index + 1]!.target, fight.target, "retry the same target");
      // Physical release closes synchronously before the reflex records its limit and begins the pause.
      assert.ok(fights[index + 1]!.start - fight.end! >= pause, JSON.stringify({ fights, pause }));
    }
    return { status: "succeeded" as const, detail: JSON.stringify({ fights, limits, elapsedMs: monotonicNow() - began, ageTicks: context.bot.time.age - startAge }) };
  } finally {
    stop();
    await context.call("cancel_foreground_action", {});
  }
}
