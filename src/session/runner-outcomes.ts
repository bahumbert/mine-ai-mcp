// What the action runner reports: the texts of a refused, stalled or limited request, and the output shapes around them.
import type { ActionOutput, ActionResult, RuntimeFailure } from "../actions/index.js";
import type { ReflexLimitKind } from "./abort.js";

// ── Reported outcomes ────────────────────────────────────────────────────────

export const outcomes = {
  actionBusy: (activeAction: { action: string; startedAt: string }) =>
    `[ACTION_BUSY] ${activeAction.action} has been running since ${activeAction.startedAt}; no new action started.`,
  invalidArguments: (cause: unknown) => `[INVALID_ARGUMENTS] ${message(cause)}`,
  executionError: message,
  physicsStalled: (action: string, stalledMs: number) =>
    `[RUNTIME_PHYSICS_STALLED] ${action} owned the body for ${Math.round(stalledMs / 1000)} s with no physics tick; it was stopped, physics restarted where it stands, and the body released.`,
  reflexLimit: (reflex: string, limit: Exclude<ReflexLimitKind, "physics_stalled">, elapsedMs: number) =>
    `[REFLEX_LIMIT] ${reflex} held the body ${limit === "ceiling" ? `for ${Math.round(elapsedMs / 1000)} s, its limit` : `${Math.round(elapsedMs / 1000)} s without progress`}; it was stopped and the body released. Look at the surroundings, then start your action again or choose another.`,
  cancelledWithoutTicks: (action: string, reason: string) =>
    `${reason} (${action} did not stop: no physics tick since the cancel; the body was released and the next action may start)`,
} as const;

export function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A request that never reached the bot: nothing ran, so nothing was spent. */
export function refusal<Name extends string, Result extends ActionResult>(
  action: Name,
  error: string,
): ActionOutput<Name, Result> {
  const result: RuntimeFailure = { kind: "runtime_failure", status: "failed", error };
  return { action, durationMs: 0, result };
}

export function measured<Name extends string, Result extends ActionResult>(
  action: Name,
  startedAtMs: number,
  result: Result | RuntimeFailure,
  interruptions: readonly string[] = [],
): ActionOutput<Name, Result> {
  // The wall clock can step back (WSL resyncing its clock, live 2026-10-07): a negative duration failed the output
  // schema and every view_status call with it.
  const output: ActionOutput<Name, Result> = { action, durationMs: Math.max(0, Date.now() - startedAtMs), result };
  return interruptions.length > 0 ? { ...output, interruptions: [...interruptions] } : output;
}
