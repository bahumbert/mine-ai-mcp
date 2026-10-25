// The server spec, trial end, pool and ready server the pool tests build their cases from.
import { loadScenarioServerConfig } from "./config.ts";
import { FakeFactory } from "./fake-servers.ts";
import { ServerPool, type ServerSpec } from "./pool.ts";
import type { TrialEnd } from "./trial.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

/** A config whose servers idle out after 1 s and give 4 lanes. */
export const config = loadScenarioServerConfig({ MINE_AI_SCENARIO_SERVER_IDLE_MS: "1000", MINE_AI_SCENARIO_MAX_PLAYERS: "6" });

/** A shared server spec of the key k1. */
export function spec(overrides: Partial<ServerSpec> = {}): ServerSpec {
  return { kind: "shared", key: "k1", heapMb: 3_072, setup: ["difficulty normal", "gamerule commandModificationBlockLimit 25165824"], scenario: fixtureScenario(10), ...overrides };
}

/** The end of a passing trial that was restored. */
export function end(overrides: Partial<TrialEnd> = {}): TrialEnd {
  return { result: { scenario: "x", outcome: "pass", elapsedMs: 1, goal: { state: "passed", detail: "" }, goalText: "" }, lane: "free",
    serverSick: false, hitWallBound: false, restored: true, mutexWaitMs: 0, arranged: true, ...overrides };
}

/** A pool on fake servers. */
export function setup() {
  const factory = new FakeFactory();
  return { factory, pool: new ServerPool(factory, config, () => {}) };
}

/** A shared server of the pool, started and ready. */
export async function readyShared(pool: ServerPool, overrides: Partial<ServerSpec> = {}) {
  const managed = pool.startServer(spec(overrides), 0);
  await managed.ready;
  return managed;
}
