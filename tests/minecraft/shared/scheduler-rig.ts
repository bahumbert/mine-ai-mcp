// A scheduler on fake servers and a runner the test finishes by hand, for the scheduler and daemon tests.
import type { RunResult } from "mine-labs";
import { settingsOf } from "../arena/settings.ts";
import { loadScenarioServerConfig, type ScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import type { Placement } from "./placement.ts";
import { ServerPool } from "./pool.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { Scheduler, type SubmissionEvent, type SubmissionHandle, type SubmissionSpec } from "./scheduler.ts";
import type { TrialRunInput } from "./trial.ts";

export interface RunningTrial {
  readonly input: TrialRunInput;
  /** Ends the trial with this outcome (after it has been prepared). */
  finish(outcome?: RunResult["outcome"]): void;
}

export const TEST_CONFIG_ENV = { MINE_AI_SCENARIO_MAX_PLAYERS: "12", MINE_AI_SCENARIO_SERVER_IDLE_MS: "1000" };

export function lanePlacement(key: string): Placement {
  const scenario = fixtureScenario(60);
  return { kind: "lane", key, settings: settingsOf(scenario, {}).settings, scenario };
}

export function ownPlacement(key: string, reusable = true): Placement {
  return { kind: "own", key, reason: "default world", reusable };
}

export class SchedulerRig {
  readonly config: ScenarioServerConfig;
  readonly factory = new FakeFactory();
  readonly pool: ServerPool;
  readonly scheduler: Scheduler;
  readonly running: RunningTrial[] = [];
  readonly events: SubmissionEvent[] = [];
  clock = 100_000;

  constructor(env: Record<string, string> = {}) {
    this.config = loadScenarioServerConfig({ ...TEST_CONFIG_ENV, ...env });
    this.pool = new ServerPool(this.factory, this.config, () => {});
    this.scheduler = new Scheduler({
      pool: this.pool, config: this.config, now: () => this.clock, log: () => {},
      runTrial: input => this.#runTrial(input),
      runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
    });
  }

  #runTrial(input: TrialRunInput): Promise<RunResult> {
    return new Promise(resolve => {
      void input.onPrepared().then(() => {
        input.deferReset(async () => {});
        this.running.push({
          input,
          finish: (outcome = "pass") => {
            this.running.splice(this.running.findIndex(trial => trial.input === input), 1);
            resolve({ scenario: input.scenario.name ?? "demo", outcome, elapsedMs: 1, goal: { state: "passed", detail: "ok" }, goalText: "" });
          },
        });
      });
    });
  }

  /** One admission sample, by default of an idle, roomy machine. */
  sample(overrides: { cpuBusy?: number | null; memAvailableMb?: number } = {}): void {
    this.scheduler.onSample({ cpuBusy: 0.2, memAvailableMb: 28_000, threads: 24, ...overrides }, this.clock);
  }

  submit(entries: { name: string; placement: Placement }[], overrides: Partial<SubmissionSpec> = {}): SubmissionHandle {
    return this.scheduler.submit({
      entries: entries.map(entry => {
        const scenario = fixtureScenario(60, entry.name);
        return { name: entry.name, scenario, placement: entry.placement.kind === "lane" ? { ...entry.placement, scenario } : entry.placement };
      }),
      repeat: 1, maxLanes: null, lock: false, outDir: "/tmp/out", emit: event => this.events.push(event), ...overrides,
    });
  }

  /** Let promise callbacks (server ready, prepared, settled) run. */
  async settle(): Promise<void> {
    for (let turn = 0; turn < 20; turn++) await new Promise(resolve => setImmediate(resolve));
  }

  /** Waits (real time, for file reads) until the condition holds. */
  async until(condition: () => boolean, what: string): Promise<void> {
    for (let waited = 0; !condition(); waited += 5) {
      if (waited > 5_000) throw new Error(`timed out waiting for ${what}`);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  lanesInFlight(): number[] {
    return this.running.map(trial => Number(/lane-(\d+)/u.exec(trial.input.arena?.id ?? "")?.[1] ?? 0));
  }
}
