// One `submit` message: load its files, place each scenario, queue them, and stream the results back until the batch is done.
import type { Scenario } from "mine-labs";
import type { ScenarioServerConfig } from "./config.ts";
import type { GameruleDefaultsCache } from "./gamerule-defaults.ts";
import { gameruleNamesOf, placeScenario } from "./placement.ts";
import type { DaemonMessage, SubmitMessage } from "./protocol.ts";
import { loadScenarioFiles } from "./scenario-files.ts";
import type { Scheduler, SubmissionHandle } from "./scheduler.ts";

export interface SubmissionHandlerDeps {
  readonly scheduler: Scheduler;
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

async function queueSubmission(deps: SubmissionHandlerDeps, message: SubmitMessage, onHandle: (handle: SubmissionHandle) => void): Promise<void> {
  const { scenarios, errors } = await loadScenarioFiles(message.paths);
  for (const text of errors) deps.send({ type: "error", text });
  if (scenarios.length === 0) {
    deps.send({ type: "done", runs: errors.length, passed: 0, failed: errors.length, cancelled: 0 });
    return;
  }
  await readDefaults(deps, scenarios);
  const entries = scenarios.map(({ id, scenario: loaded }) => {
    const scenario = withSubmitterEnv(loaded, message.env);
    return { name: id, scenario, placement: placeScenario(scenario, deps.defaults.forVersion(scenario.minecraft.version)) };
  });
  const own = entries.filter(entry => entry.placement.kind === "own");
  deps.send({
    type: "info",
    text: `${entries.length} scenarios: ${entries.length - own.length} on lanes, ${own.length} on servers of their own`
      + own.map(entry => `\n  own server: ${entry.name} (${entry.placement.kind === "own" ? entry.placement.reason : ""})`).join(""),
  });
  const handle = deps.scheduler.submit({
    entries, repeat: message.repeat, maxLanes: message.lanes, lock: message.lock, outDir: message.out,
    emit: event => deps.send({ ...event }),
  });
  onHandle(handle);
  const summary = await handle.finished;
  deps.send({ type: "done", runs: summary.runs + errors.length, passed: summary.passed, failed: summary.failed + errors.length, cancelled: summary.cancelled });
}

export function handleSubmit(deps: SubmissionHandlerDeps, message: SubmitMessage): RunningSubmission {
  let handle: SubmissionHandle | undefined;
  let closedEarly = false;
  let waitTimer: ReturnType<typeof setInterval> | undefined;
  const finished = queueSubmission(deps, message, started => {
    handle = started;
    if (closedEarly) started.cancel("submitter left");
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
      closedEarly = true;
      handle?.cancel("submitter left");
    },
  };
}
