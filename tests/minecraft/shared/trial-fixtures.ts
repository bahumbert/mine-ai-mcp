// The config, server, scenario, job and runner the trial tests build their cases from.
import type { RunResult, Scenario } from "mine-labs";
import { laneOf } from "../arena/lanes.ts";
import { ArrangementMutex } from "./arrangement-mutex.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import type { ScenarioServer } from "./scenario-server.ts";
import type { TrialJob, TrialRunInput, TrialRunner } from "./trial.ts";

/** A config with a short wall-clock slack and restore bound. */
export const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_TRIAL_SLACK_MS: "20", MINE_AI_SCENARIO_RESTORE_BOUND_MS: "60" });

/** The server every test trial runs on. */
export const server: ScenarioServer = {
  id: "s1", kind: "shared", gamePort: 25_400, heapMb: 3_072,
  command: async () => "", javaPid: () => null, stop: async () => {},
};

/** The fixture scenario with its goal timeout. */
export function scenario(timeoutSeconds = 0.03): Scenario {
  return fixtureScenario(timeoutSeconds);
}

/** A run result with this outcome. */
export function result(outcome: RunResult["outcome"]): RunResult {
  return { scenario: "demo", outcome, elapsedMs: 5, goal: { state: outcome === "pass" ? "passed" : "pending", detail: "" }, goalText: "" };
}

/** A lane trial of lane 3 on a mutex of its own. */
export function job(overrides: Partial<TrialJob> = {}): TrialJob {
  return {
    name: "demo", scenario: scenario(), lane: laneOf(3), server, mutex: new ArrangementMutex(), runDir: "/tmp/run", log: () => {},
    signal: new AbortController().signal, reuseServer: true, ...overrides,
  };
}

/** A runner that prepares, then ends with `outcome`, leaving `restore` to be run by the caller. */
/** A runner that prepares, then ends with `outcome`, leaving `restore` to be run by the caller. */
export function runnerOf(steps: { outcome?: RunResult["outcome"]; restore?: () => Promise<void>; events?: string[] } = {}): TrialRunner {
  return async (input: TrialRunInput) => {
    steps.events?.push("arrange");
    await input.onPrepared();
    steps.events?.push("prepared");
    input.deferReset(steps.restore ?? (async () => { steps.events?.push("restore"); }));
    return result(steps.outcome ?? "pass");
  };
}
