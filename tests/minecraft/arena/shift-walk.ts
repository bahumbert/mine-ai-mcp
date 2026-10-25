/** What a command rewriter carries while it walks a command: the lane offset, where the command runs, and how a refusal is raised. */
import type { ArenaOffset } from "./frame.ts";
import type { LaneCell } from "./lanes.ts";
import { addToNumberWord, isNumberWord, isRelativeWord } from "./command-tokens.ts";

/** Where a command runs: over RCON (the server, at the world origin) or in the lane's tick command blocks (at y -63). */
export interface CommandContext {
  readonly where: "rcon" | "tick";
  readonly cell: LaneCell;
  /** Player name in the scenario file -> the name that player has in the lane. */
  readonly renames: ReadonlyMap<string, string>;
}

export interface ShiftWalk {
  readonly offset: ArenaOffset;
  readonly context: CommandContext;
  /** The position `~` and `^` count from is a lane entity or a lane position (after `at`, `positioned`). */
  readonly inLane: boolean;
}

/** A command the lane shift will not move; `reason` says why in words the scenario author can act on. */
export class Refusal extends Error {}

export function incomplete(what: string): Refusal {
  return new Refusal(`the command is incomplete, or leaves ${what} to the executor: in a lane it must be written out`);
}

/** The `count` words from `from`, or a refusal when the command ends before them. */
export function take(words: readonly string[], from: number, count: number, what: string): string[] {
  const taken = words.slice(from, from + count);
  if (taken.length < count) throw incomplete(what);
  return taken;
}

/** One coordinate word of an axis: x and z move by the lane offset, y never moves, a relative word is kept where the executor is in the lane. */
export function shiftCoordinateWord(word: string, axis: "x" | "y" | "z", walk: ShiftWalk): string {
  if (isRelativeWord(word)) {
    if (walk.inLane) return word;
    throw new Refusal(`'${word}' is relative to where the command runs, which is not the lane (use it after 'at' or 'positioned as')`);
  }
  if (!isNumberWord(word)) throw new Refusal(`'${word}' is not a coordinate`);
  if (axis === "y") return word;
  const moved = addToNumberWord(word, walk.offset[axis]);
  refuseOutsideCell(Number(moved), axis, walk.context.cell, `'${word}'`);
  return moved;
}

/** An absolute x or z that lands outside the lane's cell would act in a neighbouring lane. */
export function refuseOutsideCell(value: number, axis: "x" | "z", cell: LaneCell, what: string): void {
  const [min, max] = axis === "x" ? [cell.minX, cell.maxX] : [cell.minZ, cell.maxZ];
  if (value < min || value >= max + 1) throw new Refusal(`${what} puts ${axis} ${value} outside the lane's cell (${axis} ${min}..${max}): the command would act in another lane`);
}

/** Shifts the x y z words that start at `from`, in place. */
export function shiftTripleAt(words: string[], from: number, walk: ShiftWalk): void {
  const [x, y, z] = take(words, from, 3, "a coordinate triple") as [string, string, string];
  words[from] = shiftCoordinateWord(x, "x", walk);
  words[from + 1] = shiftCoordinateWord(y, "y", walk);
  words[from + 2] = shiftCoordinateWord(z, "z", walk);
}

/** Shifts the x z words that start at `from`, in place (`forceload`). */
export function shiftPairAt(words: string[], from: number, walk: ShiftWalk): void {
  const [x, z] = take(words, from, 2, "an x z pair") as [string, string];
  words[from] = shiftCoordinateWord(x, "x", walk);
  words[from + 1] = shiftCoordinateWord(z, "z", walk);
}
