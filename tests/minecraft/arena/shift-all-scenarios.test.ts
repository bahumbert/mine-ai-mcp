import assert from "node:assert/strict";
import test from "node:test";
import { compileScenario, scenarioSchema, type Scenario } from "mine-labs";
import { isCoordinateWord, isNumberWord, splitCommand } from "./command-tokens.ts";
import { loadAllScenarios } from "./all-scenarios.ts";
import { FRESH_SERVER_GAMERULES } from "./gamerule-defaults.ts";
import { laneOf } from "./lanes.ts";
import { settingsOf } from "./settings.ts";
import { shiftCommand, type CommandContext } from "./shift-command.ts";
import { shiftScenario } from "./shift-scenario.ts";

const LANE = laneOf(3);
const Z = LANE.offset.z;
const BOX = `x=${LANE.cell.minX},y=-64,z=${LANE.cell.minZ},dx=${LANE.cell.maxX - LANE.cell.minX},dy=383,dz=${LANE.cell.maxZ - LANE.cell.minZ}`;
/** The six selector arguments the shift appends to a selector with no x or z of its own. */
const BOX_ARGUMENTS = BOX.split(",");
const RENAMES = new Map([["Actor", "ActorL3"], ["Diver", "DiverL3"]]);
const RCON: CommandContext = { where: "rcon", cell: LANE.cell, renames: RENAMES };
const TICK: CommandContext = { where: "tick", cell: LANE.cell, renames: RENAMES };

/** Files the shift refuses today, each with the reason the scenario gets a server of its own. */
const REFUSED: ReadonlyMap<string, RegExp> = new Map([
  // A server-tick scoreboard paces this target every twenty ticks.
  ["scenarios/combat/pacing-target.yaml", /exclusive/u],
  // Its ten-tick-per-second sibling: the same scoreboard pacing, on a server whose rate it sets itself.
  ["scenarios/combat/pacing-target-slow-server.yaml", /exclusive/u],
  // Passenger-gated hurts use execute on; the lane grammar cannot translate entity relations.
  ["scenarios/boat/hostile-at-sea-seated.yaml", /execute on/u],
  ["scenarios/boat/hostile-near-shore-take-back.yaml", /execute on/u],
  // Natural terrain at a fixed place (seeded default world): lanes are flat.
  ["scenarios/collect/cast-obsidian.yaml", /world\.type/u],
  ["scenarios/pathfinder/obsidian-lava-approach.yaml", /world\.type/u],
  // Contract checks whose subject changes a server-wide setting while they run (the mobGriefing rule, the weather).
  ["contract/scenarios/explosion-knockback.yaml", /exclusive/u],
  ["contract/scenarios/deflect-fireball.yaml", /exclusive/u],
  ["contract/scenarios/projectile-hit-bot.yaml", /exclusive/u],
  ["contract/scenarios/item-pickup-after-delay.yaml", /exclusive/u],
  ["contract/scenarios/rain-and-thunder-state.yaml", /exclusive/u],
  // A contract check that sleeps: the sleeping share and the night skip are the whole server's (a second sleeper, or a `time set` at another's trial, changes them).
  ["contract/scenarios/bed-sleep-and-wake.yaml", /exclusive/u],
  ["contract/scenarios/bed-refused-monster-near.yaml", /exclusive/u],
  // A contract check that measures server ticks from the wall clock: another lane's clone would stall the server thread under it.
  ["contract/scenarios/bow-draw-and-release.yaml", /exclusive/u],
  // A contract check that sets the server's tick rate while it runs.
  ["contract/scenarios/world-age-at-slow-tick.yaml", /exclusive/u],
  // The heightmap check teleports outside its lane to make the server resend a chunk.
  ["contract/scenarios/heightmap-in-chunk-packet.yaml", /exclusive/u],
  // The hostile-night bed: midnight and the difficulty are the whole server's, and a death reader must not share a server with another lane's mob.
  ["scenarios/combat/zombie-at-night.yaml", /exclusive/u],
  ["scenarios/combat/death-is-read.yaml", /exclusive/u],
  // A bot killed mid-action respawns at the world spawn, which must not be another lane's cell (same bed, `killed-mid-action.ts`).
  ["scenarios/pathfinder/killed-mid-navigate.yaml", /exclusive/u],
  ["scenarios/collect/killed-mid-sand-dig.yaml", /exclusive/u],
  // A contract check whose chat assertion is exact: another lane's join and leave lines reach every player.
  ["contract/scenarios/whisper-echo.yaml", /exclusive/u],
  // The arena and its scratch copy pin more than the 256 chunks Minecraft force-loads.
  ["scenarios/collect/obsidian-by-exploring.yaml", /chunks/u],
  ["scenarios/pathfinder/at-sea-land-behind-kelp.yaml", /chunks/u],
]);

const all = await loadAllScenarios();

test("both resume scenes shift the actor and use no lee tag selector", () => {
  const base = laneOf(3);
  const lane = { ...base, offset: { x: 64, z: base.offset.z },
    cell: { ...base.cell, minX: base.cell.minX + 64, maxX: base.cell.maxX + 64 } };
  for (const name of ["detour", "no-cover"] as const) {
    const entry = all.find(item => item.file === `scenarios/combat/evade-stationary-shooter-${name}.yaml`);
    assert.ok(entry, name);
    const result = shiftScenario(settingsOf(entry.scenario, FRESH_SERVER_GAMERULES).scenario, lane);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    assert.ok(result.scenario.players[0]!.name.startsWith("Actor"));
    assert.ok(result.scenario.tick.every(command => !command.includes("evade_resume_lee")));
  }
});

test("the census reads the scenarios of both directories", () => {
  assert.ok(all.length >= 91, `only ${all.length} scenario files found`);
  assert.ok(all.some(({ file }) => file.startsWith("contract/scenarios/")));
  assert.ok(all.some(({ file }) => file.startsWith("scenarios/")));
});

test("exactly the listed scenarios are refused, each for its listed reason", () => {
  const refused = new Map<string, string>();
  for (const { file, scenario } of all) {
    const result = shiftScenario(settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario, LANE);
    if (!result.ok) refused.set(file, result.reason);
  }
  assert.deepEqual([...refused.keys()].sort(), [...REFUSED.keys()].sort());
  for (const [file, reason] of refused) assert.match(reason, REFUSED.get(file)!, file);
});

/** The placeholder an absolute z word leaves in a command's shape. */
const Z_SLOT = "\u0000z";

/** A command as its words, each absolute z word replaced by `Z_SLOT`, with the z words it had in order. */
interface ZCensus {
  readonly words: readonly string[];
  readonly zValues: readonly string[];
}

/**
 * What one census reads: the scenario's name for each lane player (`unrename` maps lane names back), whether a selector's
 * lane box is taken off (the shifted side only: an original selector's own x, y, z, dx, dy, dz are scenario numbers), and the
 * absolute z words found so far, in order.
 */
interface Scope {
  readonly unrename: ReadonlyMap<string, string>;
  readonly unbox: boolean;
  readonly zValues: string[];
}

/**
 * The census of one command, counted from its words by the grammar a scenario may use, apart from the shifter's code.
 * A construct this grammar does not know throws, so a new one fails the census until it is added here.
 */
function zCensus(command: string, unrename: ReadonlyMap<string, string> = new Map(), unbox = false): ZCensus {
  const scope: Scope = { unrename, unbox, zValues: [] };
  return { words: markWords(splitCommand(command), scope), zValues: scope.zValues };
}

/** Marks the word at `index` as a z slot when it is an absolute number; a relative `~` or `^` word stays where it is. */
function markZ(words: string[], index: number, scope: Scope): void {
  const word = words[index];
  if (!isNumberWord(word)) return;
  scope.zValues.push(word);
  words[index] = Z_SLOT;
}

/** A plain word in an entity slot (a target or a destination name) with the lane name undone. Any other plain word, a chat payload included, stays as written. */
function unrenameEntity(words: string[], index: number, scope: Scope): void {
  const word = words[index];
  if (word !== undefined && !word.startsWith("@")) words[index] = scope.unrename.get(word) ?? word;
}

/** The words of one command: an `execute` by its clauses, any other verb by the positions it takes. */
function markWords(words: readonly string[], scope: Scope): string[] {
  const verb = words[0];
  if (verb === undefined) return [];
  const name = verb.replace(/^\//u, "");
  if (name === "execute") return markExecute(words, scope);
  const out = [verb, ...words.slice(1).map((word) => markWord(word, scope))];
  markVerbPositions(name, out, scope);
  return out;
}

/** A selector with its lane box taken off (shifted side) and its z argument marked; any other word stays as written. */
function markWord(word: string, scope: Scope): string {
  if (!word.startsWith("@")) return word;
  const open = word.indexOf("[");
  if (open < 0) return word;
  if (!word.endsWith("]")) throw new Error(`selector '${word}' is not closed`);
  const inner = selectorArguments(word.slice(open + 1, -1));
  const args = (scope.unbox ? withoutBox(inner) : inner).map((arg) => markArgument(arg, scope));
  return args.length === 0 ? word.slice(0, open) : `${word.slice(0, open)}[${args.join(",")}]`;
}

/** A selector's arguments: split at commas outside brackets, braces and quotes; each trimmed. */
function selectorArguments(inner: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of inner) {
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") args.push(current.trim());
  return args;
}

/** The selector arguments without the lane box, when they end with it (the shift appends it last). */
function withoutBox(args: readonly string[]): string[] {
  const tail = args.slice(-BOX_ARGUMENTS.length);
  const isBox = tail.length === BOX_ARGUMENTS.length && tail.every((arg, index) => arg === BOX_ARGUMENTS[index]);
  return isBox ? args.slice(0, -BOX_ARGUMENTS.length) : [...args];
}

function markArgument(arg: string, scope: Scope): string {
  const equals = arg.indexOf("=");
  if (equals < 0) return arg;
  const key = arg.slice(0, equals);
  const value = arg.slice(equals + 1);
  if (key === "z" && isNumberWord(value)) {
    scope.zValues.push(value);
    return `z=${Z_SLOT}`;
  }
  if (key === "name") return `name=${unrenameName(value, scope.unrename)}`;
  return arg;
}

/** `Actor`, `!Actor`, `"Actor"`, `!"Actor"`: the name undone, the negation and the quotes kept. */
function unrenameName(value: string, unrename: ReadonlyMap<string, string>): string {
  const [, negation = "", quote = "", name = value] = /^(!?)(["']?)(.*)\2$/u.exec(value) ?? [];
  return `${negation}${quote}${unrename.get(name) ?? name}${quote}`;
}

/** The z words a verb takes as positions, by index in the command (the verb is index 0). */
function markVerbPositions(verb: string, words: string[], scope: Scope): void {
  const at = (...indices: number[]): void => {
    for (const index of indices) markZ(words, index, scope);
  };
  switch (verb) {
    case "fill":
      return at(3, 6);
    case "setblock":
      return at(3);
    case "clone":
      return at(3, 6, 9);
    case "summon":
      return at(4);
    case "forceload":
      return at(3, 5);
    case "tp":
    case "teleport":
      return markTeleport(words, scope);
    case "item":
      return markItem(words, scope);
    // The player target of each verb that names one, by index; a bare name is renamed by the shift wherever it stands.
    case "effect":
      return unrenameEntity(words, 2, scope);
    case "gamemode":
      return unrenameEntity(words, 2, scope);
    case "kill":
    case "give":
    case "damage":
    case "tag":
      return unrenameEntity(words, 1, scope);
    default:
      return;
  }
}

/** `tp <dest>`, `tp <location>`, `tp <targets> <dest>`, `tp <targets> <location> [facing <location> | facing entity <selector>]`. */
function markTeleport(words: string[], scope: Scope): void {
  unrenameEntity(words, 1, scope);
  const location = isCoordinateWord(words[1]) ? 1 : 2;
  if (location === 2) unrenameEntity(words, 2, scope);
  if (!isCoordinateWord(words[location])) return;
  markZ(words, location + 2, scope);
  const facing = words.indexOf("facing", location + 3);
  if (facing >= 0 && words[facing + 1] !== "entity") markZ(words, facing + 3, scope);
}

/** `item replace|modify block <pos> ...`, and the source `from block <pos>` of an `item replace`; an entity target has no position. */
function markItem(words: string[], scope: Scope): void {
  if (words[2] === "block") markZ(words, 5, scope);
  const from = words.findIndex((word, index) => index > 2 && word === "from" && words[index + 1] === "block");
  if (from >= 0) markZ(words, from + 4, scope);
}

/** One `execute` clause: its width, the start offsets of its position triples, and the offset of its entity name, if any. */
interface Clause {
  readonly width: number;
  readonly triples: readonly number[];
  readonly entity?: number;
}

/** The `execute if` conditions this census reads. */
const CONDITIONS: ReadonlyMap<string, Clause> = new Map([
  ["block", { width: 6, triples: [2] }],
  ["blocks", { width: 12, triples: [2, 5, 8] }],
  ["entity", { width: 3, triples: [], entity: 2 }],
]);

function clauseAt(words: readonly string[], index: number): Clause {
  const keyword = words[index]!;
  switch (keyword) {
    case "as":
    case "at":
      return { width: 2, triples: [], entity: 1 };
    case "positioned":
      return words[index + 1] === "as" ? { width: 3, triples: [], entity: 2 } : { width: 4, triples: [1] };
    case "if":
    case "unless": {
      const condition = CONDITIONS.get(words[index + 1] ?? "");
      if (condition === undefined) throw new Error(`execute ${keyword} ${words[index + 1] ?? ""}: not in the census grammar`);
      return condition;
    }
    default:
      throw new Error(`execute ${keyword}: not in the census grammar`);
  }
}

/** The execute clauses this census reads, then the command after `run`. */
function markExecute(words: readonly string[], scope: Scope): string[] {
  const out = [words[0]!];
  let index = 1;
  while (index < words.length) {
    if (words[index] === "run") return [...out, "run", ...markWords(words.slice(index + 1), scope)];
    const clause = clauseAt(words, index);
    const part = markClause(words, index, clause, scope);
    out.push(...part);
    index += clause.width;
  }
  return out;
}

/** The `clause.width` words from `start`: each word marked, the entity name undone, and the z of each triple marked. */
function markClause(words: readonly string[], start: number, clause: Clause, scope: Scope): string[] {
  const part = words.slice(start, start + clause.width);
  if (part.length < clause.width) throw new Error(`the clause at word ${start} is cut short`);
  const out = part.map((word) => markWord(word, scope));
  if (clause.entity !== undefined) unrenameEntity(out, clause.entity, scope);
  for (const offset of clause.triples) markZ(out, offset + 2, scope);
  return out;
}

/**
 * The census of two commands: `shifted` is `original` with each absolute z word moved by the lane offset and nothing
 * else changed (the shifted side's lane names undone, its lane box taken off); null when it is.
 */
function censusProblem(original: string, shifted: string, renames: ReadonlyMap<string, string>): string | null {
  const unrename = new Map([...renames].map(([name, renamed]) => [renamed, name]));
  const before = zCensus(original);
  const after = zCensus(shifted, unrename, true);
  const show = (words: readonly string[]): string => words.map((word) => (word === Z_SLOT ? "<z>" : word)).join(" ");
  if (show(after.words) !== show(before.words)) return `'${show(before.words)}' became '${show(after.words)}'`;
  if (after.zValues.length !== before.zValues.length) return `${before.zValues.length} absolute z words, ${after.zValues.length} after the shift`;
  for (const [index, value] of before.zValues.entries()) {
    const moved = after.zValues[index]!;
    if (Math.abs(Number(moved) - Number(value) - Z) > 1e-9) return `z ${value} became ${moved}, not ${value} + ${Z}`;
  }
  return null;
}

function renamesIn(original: Scenario, shifted: Scenario): Map<string, string> {
  return new Map(original.players.map((player, index) => [player.name, shifted.players[index]!.name]));
}

/** The WIP roofed-dive witness (`tick[2]` of `8e4561c9`): two seals and a selector at absolute z, and a `~` z that stays. */
const WITNESS = "execute if block 2 -59 0 stone if block 0 -59 0 stone as @a[name=Diver,x=-7,y=-58.5,z=-3,dx=6,dy=4,dz=10] at @s if block ~ ~1.62 ~ air run say diver_returned";

/** Each shape the census reads, with its count of absolute z words written by hand (the oracle; not the shifter's). */
const SHAPES: ReadonlyArray<{ readonly command: string; readonly slots: number; readonly context?: CommandContext }> = [
  { command: "fill 0 -60 0 2 -60 1 stone", slots: 2 },
  { command: "setblock 1 -60 -3 glass", slots: 1 },
  { command: "/setblock 1 -60 -3 glass", slots: 1 },
  { command: "clone 0 -60 0 1 -60 1 2 -60 2", slots: 3 },
  { command: "summon zombie 25.5 -60 0.5", slots: 1 },
  { command: "forceload add 0 0 1 1", slots: 2 },
  { command: "forceload add 0 0", slots: 1 },
  { command: "forceload query 3 4", slots: 1 },
  { command: "forceload remove all", slots: 0 },
  { command: "tp @s 0 -60 0", slots: 1 },
  { command: "tp @s @a", slots: 0 },
  { command: "tp Diver 0 -60 0", slots: 1 },
  { command: "tp @s Actor", slots: 0 },
  { command: "effect give Actor minecraft:hunger 2 120 true", slots: 0 },
  { command: "gamemode spectator @a[name=!Actor,gamemode=!spectator]", slots: 0 },
  { command: "tp 0 -60 0 facing 1 -60 2", slots: 2 },
  { command: "tp @s 0 -60 0 facing entity @a", slots: 1 },
  { command: "teleport 0 -60 0", slots: 1 },
  { command: "teleport 0 -60 0 facing 1 -60 2", slots: 2 },
  { command: "item replace block 0 -60 0 container.0 with stone", slots: 1 },
  { command: "item replace entity @s weapon.mainhand from block 0 -60 0 container.1", slots: 1 },
  { command: "execute if block 0 -60 0 stone run say x", slots: 1 },
  { command: "execute unless blocks 0 -60 0 2 -60 1 0 -60 2 all run say x", slots: 3 },
  { command: "execute positioned 0 -60 0 run setblock ~ ~ 5 air", slots: 2 },
  { command: "execute as @a at @s positioned ~ ~1 5 run say x", slots: 1 },
  { command: "execute as @a at @s run setblock ~ -60 5 air", slots: 1 },
  { command: "/execute as @a run setblock 0 -60 5 air", slots: 1 },
  { command: "execute as @a at @s run setblock ^1 ^ ^2 air", slots: 0 },
  { command: "execute positioned as @a run say hello", slots: 0 },
  { command: "execute as @e[x=0,y=-60,z=0,dx=3,dy=2,dz=2] run kill @s", slots: 1 },
  { command: "kill @e[x=0,y=-60,z=0,dx=2,dy=2,dz=2]", slots: 1 },
  { command: "kill @e[x=0,y=-64,z=-256,dx=2047,dy=383,dz=511]", slots: 1 },
  { command: 'execute as @a run say "run z=5 Diver []"', slots: 0 },
  { command: "execute if entity @a[name=Diver] run say hello", slots: 0 },
  { command: WITNESS, slots: 3, context: TICK },
];

for (const { command, slots, context = RCON } of SHAPES) {
  test(`the census counts ${slots} absolute z words in '${command}' and the shift moves exactly those`, () => {
    const result = shiftCommand(command, LANE.offset, context);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    assert.equal(zCensus(command).zValues.length, slots, "the hand count of absolute z words");
    assert.equal(censusProblem(command, result.command, RENAMES), null);
  });
}

test("an original selector keeps its own x, y, z box numbers: its z word counts, the census does not take them off", () => {
  assert.equal(zCensus("kill @e[x=-512,y=-64,z=1280,dx=2047,dy=383,dz=511]").zValues.length, 1);
});

test("a bare player name in a chat payload is not an entity slot: the shift renames it and the census refuses that", () => {
  const result = shiftCommand("say Diver", LANE.offset, RCON);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  assert.notEqual(censusProblem("say Diver", result.command, RENAMES), null, result.command);
});

/** Shifted commands with one mistake each: the census must refuse every one. */
const MUTANTS: ReadonlyArray<{ readonly command: string; readonly mutate: (shifted: string) => string }> = [
  // A z word the shift skipped.
  { command: "setblock 1 -60 -3 glass", mutate: (shifted) => shifted.replace("1533", "-3") },
  { command: "/setblock 1 -60 -3 glass", mutate: (shifted) => shifted.replace("1533", "-3") },
  { command: "summon zombie 25.5 -60 0.5", mutate: (shifted) => shifted.replace("1536.5", "0.5") },
  // The right delta on the wrong axis: x moved, z not.
  { command: "setblock 1 -60 -3 glass", mutate: (shifted) => shifted.replace("setblock 1 -60 1533", "setblock 1537 -60 -3") },
  // A relative word rewritten to an absolute one.
  { command: "execute as @a at @s if block ~ ~1.62 ~ air run say x", mutate: (shifted) => shifted.replace("if block ~ ~1.62 ~ air", "if block 0 ~1.62 ~ air") },
  // A payload altered inside quotes.
  { command: 'execute as @a run say "run z=5 Diver []"', mutate: (shifted) => shifted.replace("z=5", "z=6") },
];

for (const { command, mutate } of MUTANTS) {
  test(`the census refuses a mutant of the shift of '${command}'`, () => {
    const result = shiftCommand(command, LANE.offset, RCON);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    const mutant = mutate(result.command);
    assert.notEqual(mutant, result.command, "the mutation changed nothing");
    assert.notEqual(censusProblem(command, mutant, RENAMES), null, mutant);
  });
}

for (const { file, scenario } of all) {
  if (REFUSED.has(file)) continue;
  test(`${file} shifts to lane 3 with its commands, region and pins moved by exactly the offset`, () => {
    const lifted = settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario;
    const result = shiftScenario(lifted, LANE);
    assert.ok(result.ok, result.ok ? "" : result.reason);
    const shifted = result.scenario;
    assert.ok(scenarioSchema.safeParse(shifted).success, "the shifted scenario is no longer a valid scenario");

    const before = compileScenario(lifted);
    const after = compileScenario(shifted);
    const renames = renamesIn(lifted, shifted);
    // `tick` is not compiled into commands (Mine Labs writes it to a datapack), so it is compared as it stands.
    const lists = { setup: [before.setup, after.setup], activation: [before.activation, after.activation], teardown: [before.teardown, after.teardown], tick: [lifted.tick, shifted.tick] } as const;
    for (const [list, [originals, shiftedCommands]] of Object.entries(lists)) {
      assert.equal(shiftedCommands.length, originals.length, `${list} length`);
      for (const [index, command] of shiftedCommands.entries()) {
        const original = originals[index]!;
        assert.equal(censusProblem(original, command, renames), null, `${list}[${index}] '${original}' -> '${command}'`);
      }
    }

    assert.deepEqual(after.region && { ...after.region, minZ: after.region.minZ - Z, maxZ: after.region.maxZ - Z }, before.region);
    for (const region of after.snapshot?.pin ?? []) {
      assert.ok(region.minX >= LANE.cell.minX && region.maxX <= LANE.cell.maxX, `pin x ${region.minX}..${region.maxX} leaves the cell`);
      assert.ok(region.minZ >= LANE.cell.minZ && region.maxZ <= LANE.cell.maxZ, `pin z ${region.minZ}..${region.maxZ} leaves the cell`);
    }
  });
}
