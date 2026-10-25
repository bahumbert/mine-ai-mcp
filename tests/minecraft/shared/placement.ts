// Where a scenario runs: a lane on a server of its settings key, or a server of its own at offset 0.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canResetScenario, worldCompatibilityKey, type Scenario } from "mine-labs";
import { laneOf, type Lane } from "../arena/lanes.ts";
import { settingsOf, type GameruleDefaults, type WorldSettings } from "../arena/settings.ts";
import { EXCLUSIVE_TAG, shiftScenario, type Shifted } from "../arena/shift-scenario.ts";

/** `reservedFor`: the id of the locked batch whose servers this placement uses (set by the scheduler, never by placement itself). */
export type Placement =
  | { readonly kind: "lane"; readonly key: string; readonly settings: WorldSettings; readonly scenario: Scenario; readonly reservedFor?: number }
  | { readonly kind: "own"; readonly key: string; readonly reason: string; readonly reusable: boolean; readonly exclusive?: boolean; readonly reservedFor?: number };

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
  return { kind: "own", key: `own:${ports.worldCompatibilityKey(scenario)}`, reason, reusable, ...(scenario.tags.includes(EXCLUSIVE_TAG) ? { exclusive: true } : {}) };
}


/** A trial that times something: the scenario says so (`exclusive`), or its batch is locked. */
export function isTimingTrial(placement: Placement, batchLocked: boolean): boolean {
  return batchLocked || (placement.kind === "own" && placement.exclusive === true);
}

/** The placement a locked batch's trial gets: a pool key of its own, so no other submission's trial can match its servers. */
export function reservePlacement(placement: Placement, submissionId: number): Placement {
  return { ...placement, key: `${placement.key}#batch${submissionId}`, reservedFor: submissionId };
}

/** Our client host, the only client that reads the arena frame (`MINE_AI_ARENA`); a missing file here means our install is broken, so it throws at load. */
const OUR_CLIENT_HOST = realpathSync(fileURLToPath(new URL("../client-host.ts", import.meta.url)));

const NOT_FRAME_AWARE = "does not read the arena frame (MINE_AI_ARENA): its coordinates would stay at offset zero (only tests/minecraft/client-host.ts gets a lane)";

/** Why the scenario's client cannot run in a lane (it is not our client host, so nothing moves its coordinates into the lane); null when it is our host. */
function clientRefusal(scenario: Scenario): string | null {
  const { command, args, cwd } = scenario.client;
  const runner = path.basename(command).replace(/\.exe$/iu, "");
  if (runner !== "bun") return `its client command ${command} ${NOT_FRAME_AWARE}`;
  const entry = args[0];
  if (entry === undefined) return `its client has no entry file and ${NOT_FRAME_AWARE}`;
  const resolved = path.resolve(cwd ?? process.cwd(), entry);
  try {
    return realpathSync(resolved) === OUR_CLIENT_HOST ? null : `its client ${resolved} ${NOT_FRAME_AWARE}`;
  } catch (error) {
    return `its client entry ${resolved} could not be resolved (${(error as NodeJS.ErrnoException).code ?? String(error)}): client.args[0] must be the entry file`;
  }
}

/** Decide where `scenario` runs, once, when it is queued. */
export function placeScenario(scenario: Scenario, defaults: GameruleDefaults, ports: ArenaPorts = REAL_PORTS): Placement {
  const clientReason = clientRefusal(scenario);
  if (clientReason) return own(scenario, clientReason, ports);
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

/** Whether the scenario's client is our client host: the one that writes its booted line, so the only one the daemon can boot ahead of its trial. */
export function runsOurClientHost(scenario: Scenario): boolean {
  return clientRefusal(scenario) === null;
}
