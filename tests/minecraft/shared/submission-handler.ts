// One `submit` message: load its files, place each scenario, queue them, and stream the results back until the batch is done.
import type { Scenario } from "mine-labs";
import { join } from "node:path";
import type { BenchState, CanaryRun } from "./bench-canary.ts";
import type { ScenarioServerConfig } from "./config.ts";
import { ProbeFailed, type GameruleDefaultsCache } from "./gamerule-defaults.ts";
import type { InPlace, ScenarioMirror, Snapshot } from "./mirror.ts";
import { snapshotCwd } from "./mirror.ts";
import { gameruleNamesOf, placeScenario } from "./placement.ts";
import type { DaemonMessage, SubmitMessage } from "./protocol.ts";
import { loadScenarioFiles } from "./scenario-files.ts";
import type { Scheduler, SubmissionHandle } from "./scheduler.ts";
import type { SubmissionEntry, SubmissionEvent } from "./scheduler-types.ts";
import { SUBMIT_CANARY, SUBMIT_FEATURES } from "./submit-args.ts";
import { sourceRootOf } from "./source-root.ts";
import { withTickRate } from "./tick-rate-variant.ts";

export interface SubmissionHandlerDeps {
  readonly bench?: BenchState;
  readonly stateDir?: string;
  readonly scheduler: Scheduler;
  /** Where the clients start from: a snapshot of each source root on ext4 or the root itself. Without one (a test's daemon) they start where the scenario says. */
  readonly mirror?: Pick<ScenarioMirror, "acquire">;
  readonly defaults: GameruleDefaultsCache;
  readonly config: ScenarioServerConfig;
  readonly send: (message: DaemonMessage) => void;
}

export interface RunningSubmission {
  /** Resolves after the `done` message was sent. */
  readonly finished: Promise<void>;
  /** The submitter went away: cancel its trials. */
  connectionClosed(): void;
}

/** The scenario's client also sees the submitter's MINE_AI_* variables; the YAML's own env wins, as it does over the process env in `mine-labs run`. */
function withSubmitterEnv(scenario: Scenario, env: Readonly<Record<string, string>>): Scenario {
  const clientEnv = Object.fromEntries(Object.entries({ ...env, ...scenario.client.env }).filter(([name]) => !name.startsWith("MINE_AI_SUBMIT_")));
  return { ...scenario, client: { ...scenario.client, env: clientEnv } };
}

function supportsClasses(message: SubmitMessage): boolean {
  return (message.env[SUBMIT_FEATURES] ?? "").split(",").includes("classes");
}

/** Keep old clients' strict wire schema while conveying infrastructure failures as errors. */
function resultForClient(event: SubmissionEvent, featured: boolean): DaemonMessage {
  if (event.type !== "result") return event;
  const { selfMade: _selfMade, ...result } = event;
  if (featured) return result;
  const { class: resultClass, cause, retried: _retried, ...legacy } = result;
  return resultClass === "infra" ? { ...legacy, outcome: "error", error: `infra: ${cause ?? "unknown cause"}${legacy.error ? `; ${legacy.error}` : ""}` } : legacy;
}

function versionsOf(scenarios: readonly { readonly scenario: Scenario }[]): Map<string, Scenario[]> {
  const byVersion = new Map<string, Scenario[]>();
  for (const { scenario } of scenarios) byVersion.set(scenario.minecraft.version, [...byVersion.get(scenario.minecraft.version) ?? [], scenario]);
  return byVersion;
}

async function readDefaults(deps: SubmissionHandlerDeps, scenarios: readonly { readonly scenario: Scenario }[]): Promise<void> {
  for (const [version, ofVersion] of versionsOf(scenarios)) {
    const example = ofVersion.find(scenario => scenario.world.type === "flat") ?? ofVersion[0]!;
    const unknown = await deps.defaults.ensure(version, ofVersion.flatMap(scenario => gameruleNamesOf(scenario)), example);
    if (unknown.length) deps.send({ type: "info", text: `gamerules not known to Minecraft ${version}, left as the scenario sets them: ${unknown.join(", ")}` });
  }
}

/** A scenario whose client starts in `cwd`. */
function withClientCwd(scenario: Scenario, cwd: string, sourceHead: string | null): Scenario {
  return { ...scenario, client: { ...scenario.client, cwd, env: { ...scenario.client.env, MINE_AI_SOURCE_HEAD: sourceHead ?? "" } } };
}

/** The entry with its client in `cwd`, in every copy it holds: the scenario as loaded and, on a lane, the lifted scenario the trial shifts (an own placement holds none). */
function withEntryCwd(entry: SubmissionEntry, cwd: string, sourceHead: string | null): SubmissionEntry {
  const scenario = withClientCwd(entry.scenario, cwd, sourceHead);
  return { ...entry, scenario, placement: entry.placement.kind === "lane" ? { ...entry.placement, scenario: withClientCwd(entry.placement.scenario, cwd, sourceHead) } : entry.placement };
}

/** What the submitter reads for one root: the snapshot its clients start from, or why they start from `/mnt/d`; nothing when nothing failed and no clients start anywhere else (an ext4 root, a submitter who left). */
function mirrorInfoText(answer: Snapshot | InPlace): string | null {
  if (answer.kind === "snapshot") return `clients start from snapshot g${answer.generation} of ${answer.root} (synced in ${answer.syncMs} ms, started ${answer.startedAt})`;
  return answer.fallback ? `clients start from /mnt/d for ${answer.root}: ${answer.reason}` : null;
}

/** Entries of one source root share one snapshot; a client with no `bun.lock` above it is its own group (the mirror answers it in place). */
function rootKeyOf(cwd: string): string {
  return sourceRootOf(cwd) ?? cwd;
}

/**
 * Asks the mirror once per source root for a snapshot and moves each entry's client into its root's snapshot. A hold goes into `holds` as soon as its
 * root answers, so the caller gives back every one even when another root's acquire threw.
 */
async function startFromSnapshots(
  deps: SubmissionHandlerDeps & { readonly mirror: Pick<ScenarioMirror, "acquire"> },
  entries: readonly SubmissionEntry[],
  signal: AbortSignal,
  holds: { release(): void }[],
): Promise<SubmissionEntry[]> {
  const cwdOfRoot = new Map<string, string>();
  for (const { scenario } of entries) {
    const { cwd } = scenario.client;
    if (cwd !== undefined && !cwdOfRoot.has(rootKeyOf(cwd))) cwdOfRoot.set(rootKeyOf(cwd), cwd);
  }
  const answers = new Map<string, Snapshot | InPlace>();
  await Promise.all([...cwdOfRoot].map(async ([root, cwd]) => {
    // `acquire` never throws by contract, but it reads the lockfile and the modules tree: one root failing must not fail the other roots' submission nor strand their holds.
    const answer = await deps.mirror.acquire(cwd, signal, text => deps.send({ type: "info", text })).catch((error: unknown): InPlace => ({
      kind: "in-place", root, reason: `the snapshot could not be made: ${error instanceof Error ? error.message : String(error)}`, fallback: true, release: () => {},
    }));
    holds.push(answer);
    answers.set(root, answer);
  }));
  for (const answer of answers.values()) {
    const text = mirrorInfoText(answer);
    if (text !== null) deps.send({ type: "info", text });
  }
  return entries.map(entry => {
    const { cwd } = entry.scenario.client;
    const answer = cwd === undefined ? undefined : answers.get(rootKeyOf(cwd));
    return cwd !== undefined && answer?.kind === "snapshot" ? withEntryCwd(entry, snapshotCwd(answer, cwd), answer.sourceHead) : entry;
  });
}

/** Load, place and snapshot the canary with the first waiter's client environment. */
export async function canaryEntry(deps: SubmissionHandlerDeps, path: string, env: Readonly<Record<string, string>>, signal: AbortSignal, holds: { release(): void }[]): Promise<SubmissionEntry | { error: string }> {
  const { scenarios, errors } = await loadScenarioFiles([path]);
  if (scenarios.length !== 1 || errors.length) return { error: errors.join("; ") || "expected one canary scenario" };
  await readDefaults(deps, scenarios);
  const scenario = withSubmitterEnv(scenarios[0]!.scenario, env);
  const entry = { name: scenarios[0]!.id, scenario, placement: placeScenario(scenario, deps.defaults.forVersion(scenario.minecraft.version)) };
  return deps.mirror ? (await startFromSnapshots({ ...deps, mirror: deps.mirror }, [entry], signal, holds))[0]! : entry;
}

let canarySequence = 0;

/** Queue a bench-owned run; its snapshots survive a waiter's departure and are released when the run ends. */
async function startCanary(deps: SubmissionHandlerDeps, path: string, env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<CanaryRun> {
  const holds: { release(): void }[] = [];
  try {
    const entry = await canaryEntry(deps, path, env, signal, holds);
    signal.throwIfAborted();
    if ("error" in entry) throw new Error(`could not load bench canary ${path}: ${entry.error}`);
    let result: Awaited<CanaryRun["done"]> | undefined;
    const handle = deps.scheduler.submit({ entries: [entry], repeat: 1, maxLanes: null, lock: false, hold: false,
      outDir: join(deps.stateDir ?? ".tmp/scenario-server", "canary", String(++canarySequence)),
      emit: event => {
        if (event.type !== "result") return;
        if (event.class === "infra") deps.bench?.sawInfra();
        result = { class: event.class ?? (event.outcome === "pass" ? "pass" : "product"), cause: event.cause, selfMade: event.selfMade, elapsedMs: event.elapsedMs };
      },
    });
    const cancel = () => handle.cancel("no canary waiters left");
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    const done = handle.finished.then(summary => result ?? { class: summary.cancelled ? "cancelled" as const : "product" as const, elapsedMs: 0 })
      .finally(() => { signal.removeEventListener("abort", cancel); for (const hold of holds) hold.release(); });
    return { done, waitReport: () => deps.scheduler.waitReport(handle.id) };
  } catch (error) {
    for (const hold of holds) hold.release();
    if (error instanceof ProbeFailed) {
      deps.bench?.sawInfra();
      return { done: Promise.resolve({ class: "infra", cause: `probe server for ${error.version} did not start: ${error.message}`, selfMade: false, elapsedMs: 0 }), waitReport: () => null };
    }
    throw error;
  }
}

/** A cancelled waiter ends only its own requested trials, including those not yet queued. */
function sendCancelled(deps: SubmissionHandlerDeps, trials: number, errors: number): void {
  deps.send({ type: "done", runs: trials + errors, passed: 0, failed: errors, cancelled: trials });
}

/** Gate multi-trial submissions while the shared bench has not been verified. */
async function waitForCanary(deps: SubmissionHandlerDeps, message: SubmitMessage, abort: AbortSignal, trials: number, errors: number): Promise<boolean> {
  const path = message.env[SUBMIT_CANARY];
  if (!deps.bench || !path || trials < 2 || message.lock || deps.bench.isVerified()) return true;
  const verdict = await deps.bench.ensure(path, signal => startCanary(deps, path, message.env, signal), abort, text => deps.send({ type: "wait", text }));
  if (verdict === "left" || abort.aborted) { sendCancelled(deps, trials, errors); return false; }
  if (verdict.kind === "infra") {
    deps.send({ type: "error", text: `bench canary ${verdict.name} infra: ${verdict.cause}; ${trials} trials not run` });
    deps.send({ type: "done", runs: trials + errors, passed: 0, failed: trials + errors, cancelled: 0, ...(supportsClasses(message) ? { infra: trials } : {}) });
    return false;
  }
  deps.send({ type: "info", text: verdict.kind === "verified" ? `bench canary passed in ${verdict.seconds.toFixed(1)} s` : `bench canary unproven (${verdict.class}${verdict.cause ? `: ${verdict.cause}` : ""}); batch runs` });
  return true;
}

async function queueSubmission(deps: SubmissionHandlerDeps, message: SubmitMessage, abort: AbortSignal, onHandle: (handle: SubmissionHandle) => void): Promise<void> {
  const { scenarios, errors } = await loadScenarioFiles(message.paths);
  for (const text of errors) deps.send({ type: "error", text });
  if (scenarios.length === 0) {
    deps.send({ type: "done", runs: errors.length, passed: 0, failed: errors.length, cancelled: 0 });
    return;
  }
  const variants = message.tickRate === undefined ? scenarios : scenarios.map(entry => ({ ...entry, ...withTickRate(entry.scenario, message.tickRate!) }));
  if (message.tickRate !== undefined) {
    const kept = variants.filter(entry => "changed" in entry && !entry.changed);
    deps.send({ type: "info", text: `tick rate ${message.tickRate}: ${variants.length - kept.length} scenarios at ${message.tickRate} ticks/s, ${kept.length} kept their own` + kept.map(entry => `\n  ${entry.id}: ${"reason" in entry ? entry.reason : ""}`).join("") });
  }
  try {
    await readDefaults(deps, variants);
  } catch (error) {
    if (error instanceof ProbeFailed) deps.bench?.sawInfra();
    if (!(error instanceof ProbeFailed) || !supportsClasses(message)) throw error;
    const count = variants.length * message.repeat;
    deps.send({ type: "error", text: `bench: probe server for ${error.version} did not start: ${error.message}; ${count} trials not run` });
    deps.send({ type: "done", runs: count + errors.length, passed: 0, failed: count + errors.length, infra: count, cancelled: 0 });
    return;
  }
  if (!await waitForCanary(deps, message, abort, variants.length * message.repeat, errors.length)) return;
  const placed = variants.map(({ id, scenario: loaded }) => {
    const scenario = withSubmitterEnv(loaded, message.env);
    return { name: id, scenario, placement: placeScenario(scenario, deps.defaults.forVersion(scenario.minecraft.version)) };
  });
  const own = placed.filter(entry => entry.placement.kind === "own");
  deps.send({
    type: "info",
    text: `${placed.length} scenarios: ${placed.length - own.length} on lanes, ${own.length} on servers of their own`
      + own.map(entry => `\n  own server: ${entry.name} (${entry.placement.kind === "own" ? entry.placement.reason : ""})`).join(""),
  });
  // Snapshots are held until the batch ends, whichever way it ends.
  const holds: { release(): void }[] = [];
  try {
    const entries = deps.mirror ? await startFromSnapshots({ ...deps, mirror: deps.mirror }, placed, abort, holds) : placed;
    if (abort.aborted) {
      const cancelled = placed.length * message.repeat;
      deps.send({ type: "done", runs: cancelled + errors.length, passed: 0, failed: errors.length, cancelled });
      return;
    }
    const handle = deps.scheduler.submit({
      entries, repeat: message.repeat, maxLanes: message.lanes, lock: message.lock, hold: message.hold ?? false, outDir: message.out,
      emit: event => {
        if (event.type === "result" && event.class === "infra") deps.bench?.sawInfra();
        deps.send(resultForClient(event, supportsClasses(message)));
      },
    });
    onHandle(handle);
    const summary = await handle.finished;
    if (errors.length === 0 && summary.runs === 1 && summary.passed === 1) deps.bench?.sawPass();
    deps.send({ type: "done", runs: summary.runs + errors.length, passed: summary.passed, failed: summary.failed + errors.length, cancelled: summary.cancelled,
      ...(supportsClasses(message) ? { infra: summary.infra ?? 0, ...(summary.retried === undefined ? {} : { retried: summary.retried }) } : {}) });
  } finally {
    for (const hold of holds) hold.release();
  }
}

export function handleSubmit(deps: SubmissionHandlerDeps, message: SubmitMessage): RunningSubmission {
  let handle: SubmissionHandle | undefined;
  let waitTimer: ReturnType<typeof setInterval> | undefined;
  const closed = new AbortController();
  const finished = queueSubmission(deps, message, closed.signal, started => {
    handle = started;
    if (closed.signal.aborted) started.cancel("submitter left");
    waitTimer = setInterval(() => {
      const report = deps.scheduler.waitReport(started.id);
      if (report) deps.send({ type: "wait", text: report });
    }, deps.config.waitReportMs);
  }).catch((error: unknown) => {
    // A failure here (a probe server that did not start) must end this submission only: a rejection would stop the daemon.
    const text = error instanceof Error ? error.message : String(error);
    deps.send({ type: "error", text: `submission failed: ${text}` });
    deps.send({ type: "done", runs: 1, passed: 0, failed: 1, cancelled: 0 });
  }).finally(() => clearInterval(waitTimer));
  return {
    finished,
    connectionClosed: () => {
      closed.abort();
      handle?.cancel("submitter left");
    },
  };
}
