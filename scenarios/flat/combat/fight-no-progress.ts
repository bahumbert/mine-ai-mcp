import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** The fight's no-progress window is 30 s; its claim ends within this long of starting (window, cancel grace, slack). */
const LONGEST_FIGHT_MS = 36_000;
const SHORTEST_FIGHT_MS = 29_000;
/** The stand-down from the target is 10 s: no new fight claim sooner than this after the release. */
const STAND_DOWN_MS = 9_000;
/** A status read must answer within this long while a reflex holds the body. */
const STATUS_DEADLINE_MS = 2_000;
const POLL_MS = 250;
const OBSERVE_MS = 80_000;

interface Claim {
  readonly kind: string;
  readonly from: number;
  to: number | null;
}

/**
 * Pins the limit, not the outcome of any fight: with a hostile the bot detects but nobody can hit or reach, the
 * hostile reflex's fight claim is released after its no-progress window, the fight stands down, and a status read
 * answers throughout. If the decision never chooses a fight for this fixture the verdict says so and fails.
 */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  assert.ok(await standStill(context));
  await using runtime = await openRuntime(context, "fight-no-progress");
  const status = runtime.actions.find((action) => action.name === "view_status")!;
  const claims: Claim[] = [];
  let slowestStatusMs = 0;
  let limitEntry = false;
  let lastSurvival: unknown = null;
  let seenLast = "";
  // One scripted hit by the zombie: the reflex defends only against an observed attacker, and the glass keeps it from hitting.
  let hurtBy: string | null = null;
  bot.on("entityHurt", (entity, source) => {
    if (entity.id === bot.entity.id) hurtBy = source?.name ?? "unattributed";
  });
  bot.chat("/damage @s 1 minecraft:mob_attack by @e[type=minecraft:zombie,limit=1]");
  const startedAt = performance.now();
  const verdict = () => {
    const fight = claims.find((claim) => claim.kind === "fight");
    if (!fight || fight.to === null || !limitEntry) return null;
    const later = claims.filter((claim) => claim.kind === "fight" && claim.from > fight.to!);
    return { fightMs: Math.round(fight.to - fight.from), nextFightAfterMs: later[0] ? Math.round(later[0].from - fight.to) : null };
  };
  try {
    // Polled on the wall clock: the point of the limit is that it does not need physics ticks.
    while (performance.now() - startedAt < OBSERVE_MS && !(verdict() && performance.now() - startedAt > (claims.find((claim) => claim.kind === "fight")?.to ?? Infinity) + STAND_DOWN_MS + 1_500)) {
      signal.throwIfAborted();
      const asked = performance.now();
      await runtime.run(status, {}, signal);
      slowestStatusMs = Math.max(slowestStatusMs, performance.now() - asked);
      const now = performance.now() - startedAt;
      const survival = runtime.status().survival;
      lastSurvival = { summary: survival.summary, decisions: survival.decisions, dangers: survival.dangers };
      const seen = JSON.stringify([survival.summary, survival.decisions]);
      if (seen !== seenLast) {
        seenLast = seen;
        log(`t=${Math.round(now)} ${seen.slice(0, 600)}`);
      }
      const owned = runtime.status().activeAction?.action === "hostile_reflex";
      const kind = survival.response?.kind ?? "unknown";
      const open = claims.at(-1);
      if (open !== undefined && open.to === null && (!owned || (kind !== "unknown" && open.kind !== "unknown" && kind !== open.kind)))
        open.to = now;
      // The response that follows a released one (the evade after the fight) is a new claim.
      if (owned && (claims.at(-1) === undefined || claims.at(-1)!.to !== null)) claims.push({ kind, from: now, to: null });
      else if (owned && open !== undefined && open.kind === "unknown" && kind !== "unknown") Object.assign(open, { kind });
      if (survival.answered.some((entry) => entry.failure.kind === "reflex_limit")) limitEntry = true;
      await sleep(POLL_MS, undefined, { signal });
    }
    const result = verdict();
    const detail = JSON.stringify({ claims, result, limitEntry, hurtBy, health: bot.health, lastSurvival, slowestStatusMs: Math.round(slowestStatusMs), zombies: Object.values(bot.entities).filter((entity) => entity.name === "zombie").length });
    log(detail);
    assert.ok(result, `no fight claim ended with a reflex_limit answer: ${detail}`);
    assert.ok(result.fightMs >= SHORTEST_FIGHT_MS && result.fightMs <= LONGEST_FIGHT_MS, `the fight held the body ${result.fightMs} ms: ${detail}`);
    assert.ok(result.nextFightAfterMs === null || result.nextFightAfterMs >= STAND_DOWN_MS, `the target was fought again after ${result.nextFightAfterMs} ms: ${detail}`);
    assert.ok(slowestStatusMs < STATUS_DEADLINE_MS, `a status read took ${slowestStatusMs} ms: ${detail}`);
    return { status: "succeeded", detail };
  } finally {
    // nothing to release: the runtime closes with the scope
  }
};
