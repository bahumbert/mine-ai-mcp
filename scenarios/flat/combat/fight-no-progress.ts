import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { MELEE_RANGE } from "../../../src/survival/weapons/equipment.ts";
import { meleeDistance } from "../../../src/survival/weapons/melee.ts";
import { openRuntime, standStill, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";

/** The fight's no-progress window is 30 s; its claim ends within this long of starting (window, cancel grace, slack). */
const LONGEST_FIGHT_MS = 36_000;
const SHORTEST_FIGHT_MS = 29_000;
/** The stand-down from the target is 10 s: no new fight claim sooner than this after the release. */
const STAND_DOWN_MS = 9_000;
/** A status read must answer within this long while a reflex holds the body. */
const STATUS_DEADLINE_MS = 2_000;
const POLL_MS = 250;
const OBSERVE_MS = 80_000;
/** The zombie is summoned by the world setup; the scripted hit waits this long for its entity to reach the client. */
const ZOMBIE_SEEN_TIMEOUT_MS = 5_000;
const ZOMBIE_SEEN_POLL_MS = 50;

interface Claim {
  readonly kind: string;
  readonly from: number;
  to: number | null;
  /** The zombie's melee distance when the claim started and ended (`null`: the zombie is not seen). */
  readonly reachFrom: number | null;
  reachTo: number | null;
}

/** One physics tick of the evidence log: the raw melee distance (not rounded) and the bot's x and x velocity. */
interface TickSample {
  readonly t: number;
  readonly reach: number | null;
  readonly x: number;
  readonly vx: number;
}

/** What the log keeps of one claim when it ends: why a fight ended is read from these numbers, not guessed. */
interface ClaimEnd {
  readonly kind: string;
  readonly minReach: number | null;
  readonly maxReach: number | null;
  /** Consecutive ticks out of melee reach just before the end (0: the last tick was in reach, or the zombie was not seen). */
  readonly ticksOutOfReachAtEnd: number;
  /** The bot's x and x velocity on the claim's last tick (`null`: no tick fell inside the claim). */
  readonly lastTick: { readonly x: number; readonly vx: number } | null;
  readonly answered: unknown;
  /** The newest `survival_outcome` event's evidence (`null`: none read; `{ unreadable }`: the read failed). */
  readonly outcomeEvidence: unknown;
  /** `true` for the claim still open when the observation ended (never released). */
  readonly openAtEnd: boolean;
}

function findZombie(bot: Bot) {
  return Object.values(bot.entities).find((entity) => entity.name === "zombie");
}

/** The raw melee distance to the zombie; `null` while it is not seen. */
function rawReach(bot: Bot): number | null {
  const zombie = findZombie(bot);
  return zombie ? meleeDistance(bot, zombie) : null;
}

/** The scripted hit needs the zombie in `bot.entities`: the reflex defends only against an attacker it can observe (race removed, not measured as the flake's cause). */
async function waitForZombie(bot: Bot, signal: AbortSignal): Promise<void> {
  const waitStart = performance.now();
  while (findZombie(bot) === undefined) {
    signal.throwIfAborted();
    assert.ok(performance.now() - waitStart < ZOMBIE_SEEN_TIMEOUT_MS, "zombie never seen");
    await sleep(ZOMBIE_SEEN_POLL_MS, undefined, { signal });
  }
}

/** The claim's tick samples reduced to the numbers the log keeps. */
function summarizeClaimTicks(samples: readonly TickSample[], from: number, to: number) {
  const inClaim = samples.filter((sample) => sample.t >= from && sample.t <= to);
  const reaches = inClaim.flatMap((sample) => (sample.reach === null ? [] : [sample.reach]));
  let ticksOutOfReachAtEnd = 0;
  for (let index = inClaim.length - 1; index >= 0; index -= 1) {
    const reach = inClaim[index]!.reach;
    if (reach === null || reach <= MELEE_RANGE) break;
    ticksOutOfReachAtEnd += 1;
  }
  const last = inClaim.at(-1);
  return {
    minReach: reaches.length > 0 ? Math.min(...reaches) : null,
    maxReach: reaches.length > 0 ? Math.max(...reaches) : null,
    ticksOutOfReachAtEnd,
    lastTick: last === undefined ? null : { x: last.x, vx: last.vx },
  };
}

/** One page of `read_recent_events`, narrowed to what the evidence log reads. */
interface EventPage {
  readonly events?: readonly { readonly type: string; readonly payload: { readonly evidence?: unknown } }[];
  readonly remainingEventCount?: number;
}

/**
 * The newest `survival_outcome` event's evidence, read with the runtime's own action. It returns the oldest unread page
 * and advances the read cursor, so the pages are read until none remain. A failed read is evidence too (`{ unreadable }`):
 * a diagnostic must not turn the scenario red.
 */
async function newestOutcomeEvidence(runtime: Runtime, signal: AbortSignal): Promise<unknown> {
  const read = runtime.actions.find((action) => action.name === "read_recent_events");
  if (read === undefined) return null;
  let newest: unknown = null;
  try {
    for (let remaining = 1; remaining > 0; ) {
      const page = (await runtime.run(read, { limit: 100 }, signal)).result as EventPage;
      const events = page.events ?? [];
      newest = events.filter((event) => event.type === "survival_outcome").at(-1)?.payload.evidence ?? newest;
      remaining = events.length === 0 ? 0 : (page.remainingEventCount ?? 0);
    }
  } catch (error) {
    signal.throwIfAborted();
    return { unreadable: error instanceof Error ? error.message : String(error) };
  }
  return newest;
}

/**
 * Samples every physics tick from `startedAt` (raw, the claim ends are explained by these numbers) and logs one line per
 * claim end; disposing removes the tick listener.
 */
function logClaimEnds(context: Pick<MineAiScenarioContext, "bot" | "signal" | "log">, runtime: Runtime, startedAt: number) {
  const { bot, signal, log } = context;
  const ticks: TickSample[] = [];
  const sampleTick = () => {
    ticks.push({ t: performance.now() - startedAt, reach: rawReach(bot), x: bot.entity.position.x, vx: bot.entity.velocity.x });
  };
  bot.on("physicsTick", sampleTick);
  const logClaim = async (claim: Claim, now: number, answered: readonly unknown[], openAtEnd: boolean): Promise<void> => {
    const end: ClaimEnd = {
      kind: claim.kind,
      ...summarizeClaimTicks(ticks, claim.from, now),
      answered: answered.at(-1) ?? null,
      outcomeEvidence: await newestOutcomeEvidence(runtime, signal),
      openAtEnd,
    };
    log(`claim-end ${JSON.stringify(end)}`);
  };
  return {
    /** Closes the open claim and logs what ended it. */
    async endClaim(open: Claim, now: number, survival: { answered: readonly unknown[] }): Promise<void> {
      Object.assign(open, { to: now, reachTo: zombieReach(bot) });
      await logClaim(open, now, survival.answered, false);
    },
    /** Logs a claim that was never released, without closing it (the verdict reads its `to`). */
    logOpenClaim: (open: Claim, now: number, survival: { answered: readonly unknown[] }) => logClaim(open, now, survival.answered, true),
    [Symbol.dispose]: () => bot.off("physicsTick", sampleTick),
  };
}

/** The bot's melee distance to the zombie, rounded to the centimetre; `null` while the zombie is not seen. */
function zombieReach(bot: Bot): number | null {
  const reach = rawReach(bot);
  return reach === null ? null : Math.round(reach * 100) / 100;
}

/**
 * The fixture's own failure, told apart from the limit's: the scripted hit's knockback can carry the bot out of melee
 * reach, where an ordinary melee attacker is not fought (owner 2026-10-21, Q1), so the first fight ends at once or is
 * never chosen. `null` when the first fight held its window or the zombie stayed in reach. A short fight followed by
 * another response (an evade) is not blamed on the fixture: that response may have carried the bot out of reach
 * before the poll read it, and an early release in reach is the limit's own failure.
 */
function fixtureOutOfReach(claims: readonly Claim[], reachNow: number | null): string | null {
  const fightIndex = claims.findIndex((claim) => claim.kind === "fight");
  const fight = claims[fightIndex];
  const endedAloneEarly = fight?.to != null && fight.to - fight.from < SHORTEST_FIGHT_MS && claims[fightIndex + 1] === undefined;
  const reach = fight === undefined ? reachNow : endedAloneEarly ? fight.reachTo : null;
  return reach !== null && reach > MELEE_RANGE
    ? `the scripted hit left the bot ${reach} blocks from the zombie, out of melee reach: fixture, not the limit`
    : null;
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
  // One scripted hit by the zombie: the reflex defends only against an observed attacker, and NoAI keeps it from hitting.
  // The hit knocks the bot back about a block (towards -x): the wall in the YAML stops it inside melee reach.
  let hurtBy: string | null = null;
  bot.on("entityHurt", (entity, source) => {
    if (entity.id === bot.entity.id) hurtBy = source?.name ?? "unattributed";
  });
  await waitForZombie(bot, signal);
  bot.chat("/damage @s 1 minecraft:mob_attack by @e[type=minecraft:zombie,limit=1]");
  const startedAt = performance.now();
  using claimLog = logClaimEnds(context, runtime, startedAt);
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
        await claimLog.endClaim(open, now, survival);
      // The response that follows a released one (the evade after the fight) is a new claim.
      if (owned && (claims.at(-1) === undefined || claims.at(-1)!.to !== null)) claims.push({ kind, from: now, to: null, reachFrom: zombieReach(bot), reachTo: null });
      else if (owned && open !== undefined && open.kind === "unknown" && kind !== "unknown") Object.assign(open, { kind });
      if (survival.answered.some((entry) => entry.failure.kind === "reflex_limit")) limitEntry = true;
      await sleep(POLL_MS, undefined, { signal });
    }
    const stillOpen = claims.at(-1);
    if (stillOpen?.to === null) await claimLog.logOpenClaim(stillOpen, performance.now() - startedAt, runtime.status().survival);
    const result = verdict();
    const reachNow = zombieReach(bot);
    const detail = JSON.stringify({ claims, result, limitEntry, hurtBy, reachNow, health: bot.health, lastSurvival, slowestStatusMs: Math.round(slowestStatusMs), zombies: Object.values(bot.entities).filter((entity) => entity.name === "zombie").length });
    log(detail);
    const fixtureFailure = fixtureOutOfReach(claims, reachNow);
    assert.ok(fixtureFailure === null, `${fixtureFailure}: ${detail}`);
    assert.ok(result, `no fight claim ended with a reflex_limit answer: ${detail}`);
    assert.ok(result.fightMs >= SHORTEST_FIGHT_MS && result.fightMs <= LONGEST_FIGHT_MS, `the fight held the body ${result.fightMs} ms: ${detail}`);
    assert.ok(result.nextFightAfterMs === null || result.nextFightAfterMs >= STAND_DOWN_MS, `the target was fought again after ${result.nextFightAfterMs} ms: ${detail}`);
    assert.ok(slowestStatusMs < STATUS_DEADLINE_MS, `a status read took ${slowestStatusMs} ms: ${detail}`);
    return { status: "succeeded", detail };
  } finally {
    // nothing to release: the tick log and the runtime close with the scope
  }
};
