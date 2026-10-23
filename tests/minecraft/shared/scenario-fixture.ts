// A real parsed scenario for the daemon's tests, with the name and goal timeout the test wants.
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "mine-labs";

const FIXTURE_YAML = fileURLToPath(new URL("../contract/scenarios/air-supply-under-water.yaml", import.meta.url));

const base = await loadScenario(FIXTURE_YAML);

export function fixtureScenario(timeoutSeconds: number, name = "demo"): Scenario {
  return { ...base, name, goal: { ...base.goal, timeout: timeoutSeconds } };
}
