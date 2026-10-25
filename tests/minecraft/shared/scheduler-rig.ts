// A scheduler on fake servers and a runner the test finishes by hand, for the scheduler and daemon tests.
import type { ClientAhead, RunResult, Scenario } from "mine-labs";
import { settingsOf } from "../arena/settings.ts";
import { ClientsAhead } from "./client-ahead.ts";
import type { ScriptedClients } from "./scripted-clients.ts";
import { loadScenarioServerConfig, type ScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import type { Placement } from "./placement.ts";
import { ServerPool } from "./pool.ts";
import { sampleOnce } from "./sampler.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { Scheduler, type SubmissionEvent, type SubmissionHandle, type SubmissionSpec } from "./scheduler.ts";
import type { TrialRunInput } from "./trial.ts";

export interface RunningTrial {
  readonly input: TrialRunInput;
  /** What the provider answered for each of the scenario's players (a runner that asks, as Mine Labs does after the arrangement); empty without clients ahead. */
  readonly clients: readonly (ClientAhead | undefined)[];
  /** Ends the trial with this outcome (after it has been prepared). */
  finish(outcome?: RunResult["outcome"]): void;
}

export const TEST_CONFIG_ENV = { MINE_AI_SCENARIO_MAX_PLAYERS: "12", MINE_AI_SCENARIO_SERVER_IDLE_MS: "1000" };

export function lanePlacement(key: string): Placement {
  const scenario = fixtureScenario(60);
  return { kind: "lane", key, settings: settingsOf(scenario, {}).settings, scenario };
}

export function ownPlacement(key: string, reusable = true, exclusive = false): Placement {
  return { kind: "own", key, reason: exclusive ? "tagged exclusive" : "default world", reusable, exclusive };
}

export class SchedulerRig {
  readonly config: ScenarioServerConfig;
  readonly factory = new FakeFactory();
  readonly pool: ServerPool;
  readonly scheduler: Scheduler;
  readonly running: RunningTrial[] = [];
  readonly events: SubmissionEvent[] = [];
  /** Every line the pool and the scheduler logged. */
  readonly logs: string[] = [];
  /** While set, a trial's arrangement does not finish: the trial counts in its server's mutex queue until the gate opens. */
  arrangeGate: Promise<void> | null = null;
  clock = 100_000;

  /** The clients booted ahead, present when the rig was given a `ScriptedClients`. */
  readonly ahead: ClientsAhead | null;

  constructor(env: Record<string, string> = {}, options: { readonly clients?: ScriptedClients } = {}) {
    this.config = loadScenarioServerConfig({ ...TEST_CONFIG_ENV, ...env });
    this.pool = new ServerPool(this.factory, this.config, message => this.logs.push(message));
    this.ahead = options.clients ? new ClientsAhead({ config: this.config, log: message => this.logs.push(message), spawn: options.clients.spawn, now: () => this.clock }) : null;
    this.scheduler = new Scheduler({
      pool: this.pool, config: this.config, now: () => this.clock, log: message => this.logs.push(message),
      runTrial: input => this.#runTrial(input),
      runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} },
      clientsAhead: this.ahead ?? undefined,
    });
  }

  #runTrial(input: TrialRunInput): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const clients: (ClientAhead | undefined)[] = [];
      void (async () => {
        await this.arrangeGate;
        await input.onArranged();
        // Mine Labs launches each player's client between the arrangement and the preparation.
        for (const player of input.scenario.players) clients.push(input.clientProvider?.(input.scenario.client, player.name));
        await input.onPrepared();
      })().then(() => {
        input.deferReset(async () => {});
        this.running.push({
          input, clients,
          finish: (outcome = "pass") => {
            this.running.splice(this.running.findIndex(trial => trial.input === input), 1);
            resolve({ scenario: input.scenario.name ?? "demo", outcome, elapsedMs: 1, goal: { state: "passed", detail: "ok" }, goalText: "" });
          },
        });
      }, (error: unknown) => {
        // Mine Labs never throws out of a trial: a failed arrangement is an error result (node_modules/mine-labs/src/trial/run.ts, the catch of runScenarioTrial).
        const message = error instanceof Error ? error.message : String(error);
        resolve({ scenario: input.scenario.name ?? "demo", outcome: "error", elapsedMs: 1, goal: { state: "pending", detail: message }, goalText: "", error: message });
      });
    });
  }

  /** One admission sample, by default of an idle, roomy machine. */
  sample(overrides: { cpuBusy?: number | null; ownCpu?: number | null; memAvailableMb?: number } = {}): void {
    this.scheduler.onSample({ cpuBusy: 0.2, memAvailableMb: 28_000, threads: 24, ...overrides }, this.clock);
  }

  submit(entries: { name: string; placement: Placement; /** Fields of this scenario's client command to change (another driver, another command). */ client?: Partial<Scenario["client"]> }[], overrides: Partial<SubmissionSpec> = {}): SubmissionHandle {
    return this.scheduler.submit({
      entries: entries.map(entry => {
        const base = fixtureScenario(60, entry.name);
        const scenario = entry.client ? { ...base, client: { ...base.client, ...entry.client } } : base;
        return { name: entry.name, scenario, placement: entry.placement.kind === "lane" ? { ...entry.placement, scenario } : entry.placement };
      }),
      repeat: 1, maxLanes: null, lock: false, hold: false, outDir: "/tmp/out", emit: event => this.events.push(event), ...overrides,
    });
  }

  /** Two samples in which the java process of the fake server `created[index]` reads 0 MB (the sampler's two readings of a death); the machine has `memAvailableMb` free. */
  async killJavaOf(index: number, memAvailableMb = 28_000): Promise<void> {
    const deadPid = 9_999;
    this.factory.created[index]!.javaPid = () => deadPid;
    const deps = {
      pool: this.pool, scheduler: this.scheduler, config: this.config, now: () => this.clock, log: () => {},
      machine: { read: async () => ({ cpuBusy: 0.2, memAvailableMb, threads: 24 }) },
      residentMbOf: async (pid: number) => (pid === deadPid ? 0 : 1_000),
    };
    await sampleOnce(deps);
    await sampleOnce(deps);
    await this.settle();
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

  /** Finishes every trial, one sample apart, until nothing runs and nothing is queued. */
  async drain(): Promise<void> {
    while (this.running.length > 0 || this.scheduler.queuedCount > 0) {
      for (const trial of [...this.running]) trial.finish();
      this.clock += 5_000;
      this.sample();
      await this.settle();
    }
  }

  /** The names of the trials running now, in start order. */
  runningNames(): string[] {
    return this.running.map(trial => trial.input.scenario.name ?? "");
  }

  /** The id of the server a running trial is on. */
  serverOf(name: string): string {
    const trial = this.running.find(candidate => candidate.input.scenario.name === name);
    if (!trial) throw new Error(`${name} is not running`);
    return trial.input.server.id;
  }

  /** Ends the running trial of that name. */
  finishNamed(name: string, outcome: RunResult["outcome"] = "pass"): void {
    const trial = this.running.find(candidate => candidate.input.scenario.name === name);
    if (!trial) throw new Error(`${name} is not running`);
    trial.finish(outcome);
  }

  lanesInFlight(): number[] {
    return this.running.map(trial => Number(/lane-(\d+)/u.exec(trial.input.arena?.id ?? "")?.[1] ?? 0));
  }
}
