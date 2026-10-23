// Where a scenario runs: a lane on a server of its settings key, or a server of its own at offset 0.
import { canResetScenario, worldCompatibilityKey, type Scenario } from "mine-labs";
import { laneOf, type Lane } from "../arena/lanes.ts";
import { settingsOf, type GameruleDefaults, type WorldSettings } from "../arena/settings.ts";
import { shiftScenario, type Shifted } from "../arena/shift-scenario.ts";

export type Placement =
  | { readonly kind: "lane"; readonly key: string; readonly settings: WorldSettings; readonly scenario: Scenario }
  | { readonly kind: "own"; readonly key: string; readonly reason: string; readonly reusable: boolean };

/** The arena and Mine Labs functions placement depends on, injectable so a refusal can be tested without a real shift. */
export interface ArenaPorts {
  settingsOf(scenario: Scenario, defaults: GameruleDefaults): { readonly key: string; readonly settings: WorldSettings; readonly scenario: Scenario };
  shiftScenario(scenario: Scenario, lane: Lane): Shifted;
  canResetScenario(scenario: Scenario): boolean;
  worldCompatibilityKey(scenario: Scenario): string;
}

const REAL_PORTS: ArenaPorts = { settingsOf, shiftScenario, canResetScenario, worldCompatibilityKey };

/** Lane 1 stands in for any lane: a shift refusal never depends on which lane it is. */
const PROBE_LANE = laneOf(1);

// Verbs that change the world's settings; run in `tick` or `reset` they change them during the trial.
const WORLD_SETTING_VERBS: ReadonlySet<string> = new Set(["tick", "time", "weather", "gamerule", "difficulty", "setworldspawn", "worldborder", "reload", "datapack"]);

function verbOf(command: string): string {
  const afterRun = command.split(/\brun\s+/u).pop() ?? command;
  return afterRun.trim().split(/\s+/u)[0] ?? "";
}

/** A scenario that runs a settings verb in `tick` or `reset` leaves its server in a different world: never reuse that server. */
export function changesWorldDuringTrial(scenario: Scenario): boolean {
  return [...scenario.tick, ...scenario.reset].some(command => WORLD_SETTING_VERBS.has(verbOf(command)));
}

function own(scenario: Scenario, reason: string, ports: ArenaPorts): Placement {
  const reusable = ports.canResetScenario(scenario) && !changesWorldDuringTrial(scenario);
  return { kind: "own", key: `own:${ports.worldCompatibilityKey(scenario)}`, reason, reusable };
}

/** Decide where `scenario` runs, once, when it is queued. */
export function placeScenario(scenario: Scenario, defaults: GameruleDefaults, ports: ArenaPorts = REAL_PORTS): Placement {
  let lifted;
  try {
    lifted = ports.settingsOf(scenario, defaults);
  } catch (error) {
    return own(scenario, `settings could not be read: ${error instanceof Error ? error.message : String(error)}`, ports);
  }
  const shifted = ports.shiftScenario(lifted.scenario, PROBE_LANE);
  if (!shifted.ok) return own(scenario, shifted.reason, ports);
  return { kind: "lane", key: lifted.key, settings: lifted.settings, scenario: lifted.scenario };
}

/** The value in "Gamerule doFireTick is currently set to: true"; null when the answer is anything else. */
export function parseGameruleAnswer(answer: string): string | null {
  return /currently set to:\s*(\S+)/u.exec(answer)?.[1] ?? null;
}

/** The gamerules a scenario sets (its own and those lifted from setup): the rules whose fresh-server value its key needs. */
export function gameruleNamesOf(scenario: Scenario, ports: ArenaPorts = REAL_PORTS): string[] {
  try {
    return Object.keys(ports.settingsOf(scenario, {}).settings.gamerules);
  } catch {
    return [];
  }
}
