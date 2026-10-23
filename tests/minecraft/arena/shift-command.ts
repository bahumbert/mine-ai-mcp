/** Moves one scenario command into a lane: the coordinate grammar of the commands scenarios use, or a reason it cannot be moved. */
import type { ArenaOffset } from "./frame.ts";
import { isCoordinateWord, splitCommand } from "./command-tokens.ts";
import { shiftWord } from "./shift-selector.ts";
import { Refusal, incomplete, shiftPairAt, shiftTripleAt, take, type CommandContext, type ShiftWalk } from "./shift-walk.ts";

export type { CommandContext } from "./shift-walk.ts";

export type CommandShift = { readonly ok: true; readonly command: string } | { readonly ok: false; readonly reason: string };

/**
 * Verbs that change what every lane on the server sees. `settings.ts` lifts the ones a scenario runs once in `setup`;
 * any left in `setup`, `tick` or `reset` (or behind `execute run`) change the world during a trial.
 */
const SERVER_WIDE_VERBS: ReadonlySet<string> = new Set([
  "tick", "time", "weather", "gamerule", "difficulty", "setworldspawn", "spawnpoint", "worldborder", "reload", "datapack", "function",
]);

/** Verbs whose state belongs to the whole server, not to a place: two lanes using them would meet. */
const SHARED_STATE_VERBS: ReadonlySet<string> = new Set(["scoreboard", "team", "bossbar", "schedule"]);

/** Index of each position triple in the verbs that take absolute block positions. */
const TRIPLE_STARTS: Readonly<Record<string, readonly number[]>> = {
  fill: [1, 4],
  setblock: [1],
  clone: [1, 4, 7],
  summon: [2],
};

/** The command with its positions moved into the lane, or the reason it cannot be (the scenario then gets a server of its own). */
export function shiftCommand(command: string, offset: ArenaOffset, context: CommandContext): CommandShift {
  return attempt(() => shiftWords(splitCommand(command), { offset, context, inLane: false }).join(" "));
}

/** A position written as text (`"0 -60 0"`, a player's or entity's `pos`) moved into the lane. */
export function shiftPositionText(position: string, offset: ArenaOffset, context: CommandContext): CommandShift {
  return attempt(() => {
    const words = splitCommand(position);
    if (words.length !== 3) throw new Refusal(`'${position}' is not a coordinate triple`);
    shiftTripleAt(words, 0, { offset, context, inLane: false });
    return words.join(" ");
  });
}

function attempt(shift: () => string): CommandShift {
  try {
    return { ok: true, command: shift() };
  } catch (cause) {
    if (cause instanceof Refusal) return { ok: false, reason: cause.message };
    throw cause;
  }
}

function shiftWords(words: readonly string[], walk: ShiftWalk): string[] {
  const verb = (take(words, 0, 1, "the verb")[0]!).replace(/^\//u, "");
  if (SERVER_WIDE_VERBS.has(verb)) {
    throw new Refusal(
      `'${verb}' changes the whole server, so it cannot run inside one lane (every lane would see it); as a whole line of setup (time set, difficulty, gamerule, weather, tick rate) the server's settings take it over, otherwise tag the scenario exclusive`,
    );
  }
  if (SHARED_STATE_VERBS.has(verb)) throw new Refusal(`'${verb}' reads or writes state every lane shares (scores, teams, bossbars, schedules), so it cannot run inside one lane`);
  if (verb === "data" && words.includes("storage")) throw new Refusal("'data ... storage' is command storage every lane shares, so it cannot run inside one lane");
  if (verb === "execute") return shiftExecute(words, walk);
  const shifted = [...words];
  if (verb === "tp" || verb === "teleport") shiftTeleportPositions(shifted, walk);
  else if (verb === "forceload") shiftForceloadPositions(shifted, walk);
  else if (verb === "item") shiftItemPositions(shifted, walk);
  else if (verb in TRIPLE_STARTS) for (const from of TRIPLE_STARTS[verb]!) shiftTripleAt(shifted, from, walk);
  else if (hasCoordinateRun(words)) throw new Refusal(`'${verb}' is not in the coordinate grammar of the lane shift and is followed by a coordinate triple`);
  return shifted.map((word, index) => (index === 0 ? word : shiftWord(word, walk)));
}

/** Three coordinate words in a row after an unknown verb: a position the shift cannot place. */
function hasCoordinateRun(words: readonly string[]): boolean {
  return words.some((_, index) => isCoordinateWord(words[index]) && isCoordinateWord(words[index + 1]) && isCoordinateWord(words[index + 2]));
}

/** `tp <destination>`, `tp <location>`, `tp <targets> <destination>`, `tp <targets> <location> [facing <location>]`. */
function shiftTeleportPositions(words: string[], walk: ShiftWalk): void {
  const [first] = take(words, 1, 1, "the target or location");
  const location = isCoordinateWord(first) ? 1 : 2;
  if (!isCoordinateWord(words[location])) return;
  shiftTripleAt(words, location, walk);
  const facing = words.indexOf("facing", location + 3);
  if (facing >= 0 && words[facing + 1] !== "entity") shiftTripleAt(words, facing + 1, walk);
}

/** `item replace|modify block <pos> <slot> ...` and, in `item replace`, a source `from block <pos> <slot>`; an entity target needs no position. */
function shiftItemPositions(words: string[], walk: ShiftWalk): void {
  if (words[2] === "block") shiftTripleAt(words, 3, walk);
  const source = words.findIndex((word, index) => index > 2 && word === "from" && words[index + 1] === "block");
  if (source >= 0) shiftTripleAt(words, source + 2, walk);
}

/** `forceload add|remove <x z> [<x z>]` and `forceload query [<x z>]`; `forceload remove all` has no position. */
function shiftForceloadPositions(words: string[], walk: ShiftWalk): void {
  if (words[2] === undefined || words[2] === "all") return;
  shiftPairAt(words, 2, walk);
  if (words[4] !== undefined) shiftPairAt(words, 4, walk);
}

/** One `execute` clause: its words, shifted, and whether the position after it is in the lane. */
interface ExecuteClause {
  readonly words: string[];
  readonly inLane: boolean;
}

function shiftExecute(words: readonly string[], walk: ShiftWalk): string[] {
  const out = [words[0]!];
  let inLane = walk.inLane;
  let index = 1;
  take(words, 1, 1, "the first execute clause");
  while (index < words.length) {
    if (words[index] === "run") {
      const command = words.slice(index + 1);
      if (command.length === 0) throw incomplete("the command after run");
      return [...out, "run", ...shiftWords(command, { ...walk, inLane })];
    }
    const clause = shiftExecuteClause(words, index, { ...walk, inLane });
    out.push(...clause.words);
    inLane = clause.inLane;
    index += clause.words.length;
  }
  return out;
}

function shiftExecuteClause(words: readonly string[], index: number, walk: ShiftWalk): ExecuteClause {
  const keyword = words[index]!;
  switch (keyword) {
    case "as":
    case "at": {
      const [, target] = take(words, index, 2, `the selector after ${keyword}`);
      return { words: [keyword, shiftWord(target!, walk)], inLane: keyword === "at" ? true : walk.inLane };
    }
    case "positioned":
      return shiftPositionedClause(words, index, walk);
    case "if":
    case "unless":
      return shiftConditionClause(words, index, walk);
    default:
      throw new Refusal(`execute ${keyword} is not in the coordinate grammar of the lane shift`);
  }
}

/** `positioned <x y z>` (shifted) or `positioned as <selector>`; either way the position after it is in the lane. */
function shiftPositionedClause(words: readonly string[], index: number, walk: ShiftWalk): ExecuteClause {
  if (words[index + 1] === "as") {
    const [, , target] = take(words, index, 3, "the selector after positioned as");
    return { words: ["positioned", "as", shiftWord(target!, walk)], inLane: true };
  }
  const clause = [...take(words, index, 4, "the coordinates after positioned")];
  shiftTripleAt(clause, 1, walk);
  return { words: clause, inLane: true };
}

/** `if|unless block <pos> <block>`, `blocks <pos> <pos> <pos> <mode>`, `entity <selector>`. */
function shiftConditionClause(words: readonly string[], index: number, walk: ShiftWalk): ExecuteClause {
  const [keyword, kind] = take(words, index, 2, "the condition");
  const clause = (length: number, positions: readonly number[]): ExecuteClause => {
    const shifted = [...take(words, index, length, `the ${kind} condition`)];
    for (const at of positions) shiftTripleAt(shifted, at, walk);
    return { words: shifted, inLane: walk.inLane };
  };
  if (kind === "block") return clause(6, [2]);
  if (kind === "blocks") return clause(12, [2, 5, 8]);
  if (kind === "entity") {
    const [, , target] = take(words, index, 3, "the selector after entity");
    return { words: [keyword!, kind, shiftWord(target!, walk)], inLane: walk.inLane };
  }
  throw new Refusal(`execute ${keyword} ${kind} is not in the coordinate grammar of the lane shift`);
}
