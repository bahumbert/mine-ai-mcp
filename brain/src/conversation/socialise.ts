import { setTimeout as sleep } from "node:timers/promises";
import { namesWord } from "../llm-mind.ts";
import type { BotRuntime, BotSnapshot, Position } from "../runtime-client.ts";
import { runStep, type SkillContext, type SkillResult } from "../skills.ts";
import type { ConversationController, OpenFacts } from "./controller.ts";
import { manhattan } from "./state.ts";

/** A partner out of earshot is waited for this long after the call (spec 2026-10-18-conversations-design). */
const CALL_WAIT_MS = 60_000;
/** How often the partner is looked for while waiting for them, and the conversation while following them. */
const WAIT_POLL_MS = 2_000;
const FOLLOW_POLL_MS = 1_000;
/** How close it keeps to the partner while they talk. */
const FOLLOW_DISTANCE = 3;
/** The routine reports at most this long after the talk, whatever its gist is waiting for. */
const GIST_REPORT_MS = 10_000;

export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined),
};

export interface SocialiseDeps {
  readonly runtime: BotRuntime;
  readonly signal: AbortSignal;
  readonly partner: string;
  readonly talks: ConversationController;
  readonly context: SkillContext;
  /** What the opening call is told besides the snapshot, which is taken fresh. */
  readonly openFacts: Omit<OpenFacts, "snapshot">;
  /** The persona's settings the routine needs: opening distance, talk range, the conversation's minutes cap. */
  readonly limits: { readonly openingDistance: number; readonly talkRange: number; readonly maxMinutes: number };
  /** When the objective started (the clock's time): a talk with the partner that ended since is the one it came for. */
  readonly since: number;
  /** How long a deliberate opening waits for the model, a conversation slot or the bot's own talk (wall clock); default none. */
  readonly openWaitMs?: number;
  readonly clock?: Clock;
}

/** The first partner the objective names as a word, else the nearest one with a position, else the first. */
export function pickPartner(objective: string, partners: readonly string[], snapshot: BotSnapshot): string | null {
  const named = partners.find((partner) => namesWord(objective, partner));
  if (named !== undefined) return named;
  let nearest: { partner: string; away: number } | null = null;
  for (const partner of partners) {
    const position = positionOf(snapshot, partner);
    if (position === null) continue;
    const away = manhattan(snapshot.position, position);
    if (nearest === null || away < nearest.away) nearest = { partner, away };
  }
  return nearest?.partner ?? partners[0] ?? null;
}

export function positionOf(snapshot: BotSnapshot, partner: string): Position | null {
  return snapshot.players.find((player) => player.username.toLowerCase() === partner.toLowerCase())?.position ?? null;
}

/**
 * The `socialising` routine (a code routine like the night shelter: its steps are fixed, a model call per step would
 * only cost latency): call or walk up to the partner, open the conversation, stay with them until it ends.
 */
export async function socialise(deps: SocialiseDeps): Promise<SkillResult> {
  const { runtime, signal, partner, talks, context, openFacts, limits, since } = deps;
  const clock = deps.clock ?? realClock;
  const stopped: SkillResult = { status: "stopped" };
  // Set aside while it talked and back with the conversation over: it talked, it opens nothing new.
  if (talks.current === null) {
    const earlier = talks.lastTalk(partner);
    if (earlier !== null && earlier.endedAt >= since) return talked(earlier, partner);
  }
  let snapshot = await runtime.status();
  let position = positionOf(snapshot, partner);
  if (position === null || manhattan(snapshot.position, position) > limits.talkRange) {
    // Out of earshot: the opening line calls them over, then they are waited for.
    if (!(await talks.openSocial(partner, position, { ...openFacts, snapshot }, signal, deps.openWaitMs))) return signal.aborted ? stopped : noOpening(talks, partner);
    const deadline = clock.now() + CALL_WAIT_MS;
    for (;;) {
      await clock.sleep(WAIT_POLL_MS, signal);
      if (signal.aborted) return stopped;
      snapshot = await runtime.status();
      position = positionOf(snapshot, partner);
      if (position !== null && manhattan(snapshot.position, position) <= limits.openingDistance) break;
      // The record is gone before they came (the tick ended it): the call failed, it is not made again.
      if (talks.current === null) return { status: "failed", detail: `${partner} did not come`, reason: "did_not_come" };
      if (clock.now() >= deadline) {
        talks.end("out_of_range", signal);
        return { status: "failed", detail: `${partner} did not come`, reason: "did_not_come" };
      }
    }
  } else if (manhattan(snapshot.position, position) > limits.openingDistance) {
    const walked = await runStep({ skill: "go_to_player", player: partner }, context);
    if (walked.status !== "done") return walked;
    snapshot = await runtime.status();
    position = positionOf(snapshot, partner);
  }
  if (talks.current !== null || signal.aborted) {
    // Opened while they came (or by their own line): nothing more to say first.
  } else if (!(await talks.openSocial(partner, position, { ...openFacts, snapshot }, signal, deps.openWaitMs))) {
    return signal.aborted ? stopped : noOpening(talks, partner);
  }
  if (signal.aborted) return stopped;
  // Stay with them until the conversation ends: the follow step is aborted as soon as the record is gone.
  const follow = new AbortController();
  const joined = AbortSignal.any([signal, follow.signal]);
  const watching = (async () => {
    while (!joined.aborted) {
      if (talks.current === null) {
        follow.abort();
        return;
      }
      await clock.sleep(FOLLOW_POLL_MS, joined);
    }
  })();
  const result = await runStep({ skill: "follow_player", player: partner, distance: FOLLOW_DISTANCE, minutes: Math.max(1, Math.ceil(limits.maxMinutes)) }, { ...context, signal: joined });
  follow.abort();
  await watching;
  if (signal.aborted) return stopped;
  if (result.status === "failed" && talks.current !== null) return result;
  // The gist may wait for a model slot for minutes: the routine reports with the topic after a few seconds.
  const waiting = new AbortController();
  await Promise.race([talks.finished(), clock.sleep(GIST_REPORT_MS, AbortSignal.any([signal, waiting.signal]))]);
  waiting.abort();
  return talked(talks.lastTalk(partner), partner);
}

function talked(talk: { readonly topic: string; readonly gist: string } | null, partner: string): SkillResult {
  const gist = talk === null ? "" : talk.gist !== "" ? talk.gist : talk.topic;
  return { status: "done", detail: `talked with ${partner}${gist === "" ? "" : `: ${gist}`}` };
}

/** The routine could not open (reason `no_talk`, which trading reads), then why the controller held back (when it was not the model that had nothing to say). */
function noOpening(talks: ConversationController, partner: string): SkillResult {
  const why = talks.openRefusal;
  return { status: "failed", detail: `had nothing to say to ${partner}${why === null ? "" : ` (${why})`}`, reason: "no_talk" };
}
