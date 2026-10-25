/** The world settings a shared server holds for all its lanes: lifted out of a scenario, keyed, and applied once per server. */
import type { Scenario } from "mine-labs";

export interface WorldSettings {
  readonly version: string;
  readonly type: string;
  readonly seed: string | null;
  readonly structures: boolean;
  readonly spawn: string | null;
  readonly time: string;
  readonly difficulty: string;
  /** `clear`, `rain`, `thunder`, with the duration when the scenario gave one; null when the scenario sets no weather. */
  readonly weather: string | null;
  readonly tickRate: number | null;
  /** The effective value of every rule except the ones Mine Labs or the scenario daemon own. */
  readonly gamerules: Readonly<Record<string, string>>;
}

/** The value every rule has on a fresh server of one version, read from that server by the scenario daemon. */
export type GameruleDefaults = Readonly<Record<string, string>>;

/** Mine Labs sets the first and third itself at every arrangement and the daemon owns the block limit; none belongs to a key. */
const OWNED_RULES: ReadonlySet<string> = new Set(["sendCommandFeedback", "commandModificationBlockLimit", "commandBlockOutput"]);

/** A fresh vanilla server runs at easy: its `server.properties` has no `difficulty` line (Mine Labs writes none). */
const DEFAULT_DIFFICULTY = "easy";

interface Lifted {
  time?: string;
  difficulty?: string;
  weather?: string;
  tickRate?: number;
  readonly rules: Array<readonly [string, string]>;
  readonly remaining: string[];
}

/** Whole `setup` commands that set a server-wide value once; anything with other arguments stays for the command shift to refuse. */
const LIFTABLE: ReadonlyArray<readonly [RegExp, (lifted: Lifted, match: RegExpExecArray) => void]> = [
  [/^time set (\S+)$/u, (lifted, match) => void (lifted.time = match[1])],
  [/^difficulty (peaceful|easy|normal|hard)$/u, (lifted, match) => void (lifted.difficulty = match[1])],
  [/^gamerule (\S+) (\S+)$/u, (lifted, match) => void lifted.rules.push([match[1]!, match[2]!])],
  [/^weather (clear|rain|thunder)(?: (\S+))?$/u, (lifted, match) => void (lifted.weather = match[2] ? `${match[1]} ${match[2]}` : match[1])],
  [/^tick rate (\d+(?:\.\d+)?)$/u, (lifted, match) => void (lifted.tickRate = Number(match[1]))],
];

function liftSetup(setup: readonly string[]): Lifted {
  const lifted: Lifted = { rules: [], remaining: [] };
  for (const command of setup) {
    const trimmed = command.trim();
    const hit = LIFTABLE.map(([pattern, apply]) => ({ match: pattern.exec(trimmed), apply })).find(({ match }) => match !== null);
    if (hit) hit.apply(lifted, hit.match!);
    else lifted.remaining.push(command);
  }
  return lifted;
}

/**
 * The settings of a scenario's world, with `time`, `difficulty`, `gamerule`, `weather` and `tick rate` lines lifted out of
 * `setup` (a later one wins over `world.*`, as `compile.ts` runs `setup` last). `key` names the server that can hold the
 * scenario; `scenario` is the lane scenario, which carries the effective values in its `world` so Mine Labs' per-trial
 * settings re-set the key's values and never another.
 */
export function settingsOf(scenario: Scenario, defaults: GameruleDefaults): { readonly key: string; readonly settings: WorldSettings; readonly scenario: Scenario } {
  const lifted = liftSetup(scenario.setup);
  const settings = settingsFrom(scenario, lifted, defaults);
  const carried: Scenario = {
    ...scenario,
    setup: lifted.remaining,
    world: { ...scenario.world, time: settings.time, difficulty: settings.difficulty as Scenario["world"]["difficulty"], gamerules: { ...settings.gamerules } },
  };
  return { key: keyOf(settings), settings, scenario: carried };
}

function settingsFrom(scenario: Scenario, lifted: Lifted, defaults: GameruleDefaults): WorldSettings {
  const { world } = scenario;
  const weather = lifted.weather ?? null;
  return {
    version: scenario.minecraft.version,
    type: world.type,
    seed: world.seed === undefined ? null : String(world.seed),
    structures: world.structures,
    spawn: world.spawn === undefined ? null : [world.spawn].flat().join(" "),
    time: lifted.time ?? String(world.time),
    difficulty: lifted.difficulty ?? world.difficulty ?? DEFAULT_DIFFICULTY,
    weather,
    tickRate: lifted.tickRate ?? null,
    gamerules: effectiveRules(scenario, lifted, defaults, weather !== null),
  };
}

/** Server default, then Mine Labs' flat-world `doMobSpawning false` when the scenario sets none, then `world.gamerules`, then lifted lines. */
function effectiveRules(scenario: Scenario, lifted: Lifted, defaults: GameruleDefaults, weatherSet: boolean): Record<string, string> {
  const rules: Record<string, string> = { ...defaults };
  if (scenario.world.type === "flat" && !("doMobSpawning" in scenario.world.gamerules)) rules.doMobSpawning = "false";
  for (const [rule, value] of Object.entries(scenario.world.gamerules)) rules[rule] = String(value);
  for (const [rule, value] of lifted.rules) rules[rule] = value;
  if (weatherSet) rules.doWeatherCycle = "false";
  for (const owned of OWNED_RULES) delete rules[owned];
  return rules;
}

/** Stable text of the settings: rules sorted, so two scenarios that write the same world differently share a key. */
function keyOf(settings: WorldSettings): string {
  return JSON.stringify({ ...settings, gamerules: Object.entries(settings.gamerules).sort(([a], [b]) => a.localeCompare(b)) });
}

/** What a new server of this key runs once, before its first lane. */
export function settingsCommands(settings: WorldSettings): string[] {
  const commands = [`difficulty ${settings.difficulty}`, `time set ${settings.time}`];
  for (const [rule, value] of Object.entries(settings.gamerules).sort(([a], [b]) => a.localeCompare(b))) commands.push(`gamerule ${rule} ${value}`);
  if (settings.weather !== null) commands.push(`weather ${settings.weather}`);
  if (settings.tickRate !== null) commands.push(`tick rate ${settings.tickRate}`);
  return commands;
}
