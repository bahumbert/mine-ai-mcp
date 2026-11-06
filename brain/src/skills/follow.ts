// Following a player and walking up to one (follow_player, go_to_player).
import { setTimeout as sleep } from "node:timers/promises";
import { elapsedSince, monotonicNow } from "../monotonic-clock.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { distanceBetween, findPlayer, navigateInput } from "./positions.ts";

/** Pause between follow checks while already close enough. */
const FOLLOW_POLL_MS = 750;
/**
 * A follow asked for by a player ends after this long without a word from them; on her own goal it lasts the minutes
 * the step says, {@link FOLLOW_OWN_MINUTES} by default (spec 2026-10-04-activity-time-travel-terraforming: live, Vex
 * followed Tester, who never asked, until an order came).
 */
const FOLLOW_QUIET_MS = 10 * 60_000;
const FOLLOW_OWN_MINUTES = 5;
/** Extra blocks tolerated beyond the follow distance before moving, so the bot does not twitch at every step. */
const FOLLOW_SLACK = 1.5;
/** A followed player this far from the current navigation target triggers a re-plan. */
const REPLAN_DISTANCE = 4;
/** Consecutive checks without seeing the followed player before giving up (~ FOLLOW_LOST_CHECKS * poll). */
const FOLLOW_LOST_CHECKS = 8;
/** Consecutive failed navigation legs before following gives up (unreachable player). */
const FOLLOW_MAX_FAILURES = 3;
/** Stop this close to a player we walk up to. */
const COME_RANGE = 2;

type FollowStep =
  | { readonly kind: "lost" }
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly target: Position };

/** Pure follow decision for one tick. */
export function planFollowStep(snapshot: BotSnapshot, player: string, distance: number): FollowStep {
  const target = findPlayer(snapshot, player)?.position ?? null;
  if (target === null) return { kind: "lost" };
  if (distanceBetween(snapshot.position, target) <= distance + FOLLOW_SLACK) return { kind: "hold" };
  return { kind: "move", target };
}

export async function follow(context: SkillContext, player: string, distance: number, minutes?: number): Promise<SkillResult> {
  const { runtime, body, signal, heardFrom, alive } = context;
  const started = monotonicNow();
  const until = started + (minutes ?? FOLLOW_OWN_MINUTES) * 60_000;
  let unseen = 0;
  let failures = 0;
  while (!signal.aborted) {
    alive?.();
    // Asked for by a player: it lasts while they keep talking (any line restarts the count). On her own goal: its minutes.
    if (heardFrom !== undefined && minutes === undefined) {
      if (monotonicNow() - heardFrom() >= FOLLOW_QUIET_MS) {
        return { status: "done", detail: `followed ${player}; they said nothing for ${FOLLOW_QUIET_MS / 60_000} minutes, so I went back to my own things` };
      }
    } else if (monotonicNow() >= until) {
      return { status: "done", detail: `followed ${player} for ${Math.round(elapsedSince(started) / 60_000)} minutes` };
    }
    const step = planFollowStep(await runtime.status(), player, distance);
    if (step.kind === "lost") {
      unseen += 1;
      if (unseen >= FOLLOW_LOST_CHECKS) return { status: "failed", detail: `lost sight of ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    unseen = 0;
    if (step.kind === "hold") {
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    const target = step.target;
    const outcome = await body.act("navigate", navigateInput(target, distance), `Follow ${player}.`, {
      signal,
      interruptWhen: async () => {
        const now = findPlayer(await runtime.status(), player)?.position ?? null;
        return now !== null && distanceBetween(now, target) > REPLAN_DISTANCE;
      },
    });
    // Pre-empted legs and partial arrivals are normal while following: the next tick re-plans from where we are.
    if (outcome.status === "refused") return { status: "failed", detail: outcome.error ?? "navigation refused" };
    if (outcome.status === "failed" && !outcome.preempted) {
      failures += 1;
      if (failures >= FOLLOW_MAX_FAILURES) return { status: "failed", detail: outcome.error ?? `cannot reach ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
    } else {
      failures = 0;
    }
  }
  return { status: "stopped" };
}

export async function come(context: SkillContext, player: string): Promise<SkillResult> {
  const target = findPlayer(await context.runtime.status(), player)?.position ?? null;
  if (target === null) return { status: "failed", detail: `cannot see ${player}` };
  const outcome = await context.body.act("navigate", navigateInput(target, COME_RANGE), `Go to ${player} who called me.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: `reached ${player}` };
  return { status: "failed", detail: outcome.error ?? `navigation ${outcome.status}` };
}
