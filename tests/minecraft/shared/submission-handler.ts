// One `submit` message: load its files, place each scenario, queue them, and stream the results back until the batch is done.
import type { Scenario } from "mine-labs";
import type { ScenarioServerConfig } from "./config.ts";
import type { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import type { InPlace, ScenarioMirror, Snapshot } from "./mirror.ts";
import { snapshotCwd } from "./mirror.ts";
import { gameruleNamesOf, placeScenario } from "./placement.ts";
import type { DaemonMessage, SubmitMessage } from "./protocol.ts";
import { loadScenarioFiles } from "./scenario-files.ts";
import type { Scheduler, SubmissionHandle } from "./scheduler.ts";
import type { SubmissionEntry } from "./scheduler-types.ts";
import { sourceRootOf } from "./source-root.ts";

export interface SubmissionHandlerDeps {
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
  return { ...scenario, client: { ...scenario.client, env: { ...env, ...scenario.client.env } } };
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
function withClientCwd(scenario: Scenario, cwd: string): Scenario {
  return { ...scenario, client: { ...scenario.client, cwd } };
}

/** The entry with its client in `cwd`, in every copy it holds: the scenario as loaded and, on a lane, the lifted scenario the trial shifts (an own placement holds none). */
function withEntryCwd(entry: SubmissionEntry, cwd: string): SubmissionEntry {
  const scenario = withClientCwd(entry.scenario, cwd);
  return { ...entry, scenario, placement: entry.placement.kind === "lane" ? { ...entry.placement, scenario: withClientCwd(entry.placement.scenario, cwd) } : entry.placement };
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
    return cwd !== undefined && answer?.kind === "snapshot" ? withEntryCwd(entry, snapshotCwd(answer, cwd)) : entry;
  });
}

async function queueSubmission(deps: SubmissionHandlerDeps, message: SubmitMessage, abort: AbortSignal, onHandle: (handle: SubmissionHandle) => void): Promise<void> {
  const { scenarios, errors } = await loadScenarioFiles(message.paths);
  for (const text of errors) deps.send({ type: "error", text });
  if (scenarios.length === 0) {
    deps.send({ type: "done", runs: errors.length, passed: 0, failed: errors.length, cancelled: 0 });
    return;
  }
  await readDefaults(deps, scenarios);
  const placed = scenarios.map(({ id, scenario: loaded }) => {
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
      emit: event => deps.send({ ...event }),
    });
    onHandle(handle);
    const summary = await handle.finished;
    deps.send({ type: "done", runs: summary.runs + errors.length, passed: summary.passed, failed: summary.failed + errors.length, cancelled: summary.cancelled });
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
