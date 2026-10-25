import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** The reflex's no-progress window (5 s) plus the cancel grace of a work that stops at once, with the server's slack. */
const LONGEST_CLAIM_MS = 6_500;
/** The stand-down is 2 s; a claim sooner than this after a release means the limit did not stand the reflex down. */
const SHORTEST_PAUSE_MS = 1_800;
/** A status read must answer within this long while a reflex holds the body: the host is not blocked. */
const STATUS_DEADLINE_MS = 2_000;
/** Drowning starts about 15 s after the air bar empties; the verdict is in well before the bot is at risk. */
const OBSERVE_MS = 24_000;

/** One stretch of the breath reflex owning the body, on the wall clock. */
interface Claim {
  readonly from: number;
  to: number | null;
}

/**
 * Pins the limit, not survival: with no way to air and an undiggable roof, the breath reflex's claim ends after its
 * no-progress window, the reflex pauses, and it claims again; a status read answers throughout.
 */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  assert.ok(await standStill(context));
  await using runtime = await openRuntime(context, "breath-undiggable-roof");
  const status = runtime.actions.find((action) => action.name === "view_status")!;
  const claims: Claim[] = [];
  let died = false;
  let slowestStatusMs = 0;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  const startedAt = performance.now();
  const observe = () => {
    const now = performance.now() - startedAt;
    const owned = runtime.status().activeAction?.action === "breath_reflex";
    const open = claims.at(-1);
    if (owned && (open === undefined || open.to !== null)) claims.push({ from: now, to: null });
    else if (!owned && open !== undefined && open.to === null) open.to = now;
  };
  const verdict = () => {
    const [first, second] = claims;
    if (!first || first.to === null || !second) return null;
    return {
      firstClaimMs: Math.round(first.to - first.from),
      pauseMs: Math.round(second.from - first.to),
    };
  };
  try {
    let nextStatusAt = 0;
    // Polled on the wall clock: the point of the limit is that it does not need physics ticks.
    while (!died && performance.now() - startedAt < OBSERVE_MS && verdict() === null) {
      signal.throwIfAborted();
      observe();
      if (performance.now() - startedAt >= nextStatusAt) {
        const asked = performance.now();
        await runtime.run(status, {}, signal);
        slowestStatusMs = Math.max(slowestStatusMs, performance.now() - asked);
        nextStatusAt = performance.now() - startedAt + 1_000;
      }
      await sleep(50, undefined, { signal });
    }
    const result = verdict();
    const detail = JSON.stringify({ died, claims, result, slowestStatusMs: Math.round(slowestStatusMs) });
    log(detail);
    assert.ok(result, `the reflex did not claim twice with a release between: ${detail}`);
    assert.ok(result.firstClaimMs <= LONGEST_CLAIM_MS, `the first claim held the body ${result.firstClaimMs} ms: ${detail}`);
    assert.ok(result.pauseMs >= SHORTEST_PAUSE_MS, `the reflex claimed again after ${result.pauseMs} ms: ${detail}`);
    assert.ok(slowestStatusMs < STATUS_DEADLINE_MS, `a status read took ${slowestStatusMs} ms: ${detail}`);
    return { status: "succeeded", detail };
  } finally {
    bot.off("death", death);
  }
};
