// What the scheduler makes of a trial whose server's java process died: whether it ran anything, how long to wait for the death to be confirmed, what its end says.
import type { ScenarioServerConfig } from "./config.ts";
import type { ManagedServer } from "./pool.ts";
import type { TrialEnd } from "./trial.ts";

/** On top of two sampler readings: the sample that reads the death starts up to a tick late and the pool stops the server after it. */
const DEATH_CONFIRM_SLACK_MS = 2_000;

/**
 * How long a trial that failed before its arrangement waits on the wall clock for `ManagedServer.died`: the pool aborts it only after
 * JAVA_GONE_READINGS (2) samples read the java process as gone, 5-10 s after the exit, while the trial's RCON commands failed at once.
 */
export function deathConfirmBoundMs(config: Pick<ScenarioServerConfig, "sampleEveryMs">): number {
  return 2 * config.sampleEveryMs + DEATH_CONFIRM_SLACK_MS;
}

/** Resolves when `signal` aborts (the server's death, or the submission's cancel) or `boundMs` of the wall clock pass; a server still alive after the bound is not a death (`stopStalled` aborts nothing). */
export function awaitDeathOrCancel(signal: AbortSignal, boundMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = (): void => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, boundMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A trial that did not pass on a server whose java died ended because of the death, whatever it saw of it (an abort, a dead RCON, a lost client). */
export function blameDeadServer(managed: ManagedServer, submission: { readonly abort: AbortController }, end: TrialEnd): TrialEnd {
  const { result } = end;
  if (!managed.died.aborted || submission.abort.signal.aborted || result.outcome === "pass") return end;
  const seen = result.error && result.outcome !== "cancelled" ? ` (the trial saw: ${result.error})` : "";
  const error = `server ${managed.id} died: ${String(managed.died.reason)}${seen}; this trial is not a result of the scenario, run it again`;
  return { ...end, result: { ...result, outcome: "error", error, goal: { state: "pending", detail: error } } };
}
