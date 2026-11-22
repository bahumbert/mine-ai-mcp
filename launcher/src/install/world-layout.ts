// The world folders of the local server in vanilla's layout and in Paper's, and the way from Paper's back to vanilla's.
// Measured 2026-11-14 (facts `paper-server.md` D, E): Paper moves `world/DIM-1` to `world_nether/DIM-1` and `world/DIM1` to
// `world_the_end/DIM1` at its first start; vanilla reads the moved-back folders with the same blocks, and Paper moves them again.
import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";

const WORLD_FOLDER = "world";

/** Where Paper keeps a dimension (`paperFolder`) and where vanilla keeps it inside the world (`dimensionFolder`). */
const PAPER_DIMENSIONS = [
  { paperFolder: "world_nether", dimensionFolder: "DIM-1" },
  { paperFolder: "world_the_end", dimensionFolder: "DIM1" },
] as const;

const ASIDE_BEFORE = ".before-vanilla";
const ASIDE_AFTER = ".after-vanilla";

type Rename = (from: string, to: string) => Promise<void>;

/** A rename failed; the moves made before it were undone, and the message says which ones (if any) could not be. */
export class WorldMoveError extends Error {}

/** True when the world in `serverDir` ran on Paper: Paper keeps the Nether and the End in `world_nether` and `world_the_end`, vanilla inside `world`. */
export function worldRanOnPaper(serverDir: string): boolean {
  return PAPER_DIMENSIONS.some(({ paperFolder }) => existsSync(join(serverDir, paperFolder)));
}

/** `path + suffix`, or `path + suffix-2`, `-3`... when an earlier round trip already left that name. */
function freeAsideName(path: string, suffix: string): string {
  let candidate = `${path}${suffix}`;
  for (let n = 2; existsSync(candidate); n++) candidate = `${path}${suffix}-${n}`;
  return candidate;
}

/** The renames of one dimension, in order: the vanilla target aside (if it exists), the dimension home, the emptied Paper folder aside. */
function planDimensionMoves(serverDir: string, paperFolder: string, dimensionFolder: string): { from: string; to: string; line: string }[] {
  const paperPath = join(serverDir, paperFolder);
  if (!existsSync(paperPath)) return [];
  const from = join(paperPath, dimensionFolder);
  const target = join(serverDir, WORLD_FOLDER, dimensionFolder);
  const moves: { from: string; to: string; line: string }[] = [];
  if (existsSync(from)) {
    if (existsSync(target)) {
      const aside = freeAsideName(target, ASIDE_BEFORE);
      moves.push({ from: target, to: aside, line: `Kept the earlier ${WORLD_FOLDER}/${dimensionFolder} beside it as ${WORLD_FOLDER}/${aside.slice(join(serverDir, WORLD_FOLDER).length + 1)}.` });
    }
    moves.push({ from, to: target, line: `Moved ${paperFolder}/${dimensionFolder} to ${WORLD_FOLDER}/${dimensionFolder}.` });
  }
  const after = freeAsideName(paperPath, ASIDE_AFTER);
  moves.push({ from: paperPath, to: after, line: `Renamed ${paperFolder} (Paper's own files) to ${after.slice(serverDir.length + 1)}, so the world no longer reads as one Paper ran.` });
  return moves;
}

/** Puts the renames already made back, newest first; returns the folders that could not be put back. */
async function undoMoves(done: readonly { from: string; to: string }[], renameFolder: Rename): Promise<string[]> {
  const stuck: string[] = [];
  for (const move of [...done].reverse()) {
    try {
      await renameFolder(move.to, move.from);
    } catch {
      stuck.push(move.to);
    }
  }
  return stuck;
}

function failureText(serverDir: string, move: { from: string; to: string }, error: unknown, stuck: readonly string[]): string {
  const relative = (path: string): string => path.slice(serverDir.length + 1);
  const undone = stuck.length === 0 ? "The moves already made were undone, so the folders are as they were." : `The moves already made could not all be undone: ${stuck.map(relative).join(", ")} still sit where they were moved.`;
  return `Could not move ${relative(move.from)} to ${relative(move.to)}: ${(error as Error).message}. ${undone}`;
}

/**
 * Moves the Nether and the End Paper split out of `world` back into it, for vanilla: `world_nether/DIM-1` to `world/DIM-1` and
 * `world_the_end/DIM1` to `world/DIM1` (an existing target is renamed `<target>.before-vanilla` first), then `world_nether` and
 * `world_the_end` to `<name>.after-vanilla`. Returns one line per rename for the player. A failed rename undoes the ones made and throws
 * a `WorldMoveError` naming the folder.
 */
export async function moveDimensionsBack(serverDir: string, renameFolder: Rename = rename): Promise<string[]> {
  const done: { from: string; to: string }[] = [];
  const lines: string[] = [];
  for (const { paperFolder, dimensionFolder } of PAPER_DIMENSIONS) {
    for (const move of planDimensionMoves(serverDir, paperFolder, dimensionFolder)) {
      try {
        await renameFolder(move.from, move.to);
      } catch (error) {
        throw new WorldMoveError(failureText(serverDir, move, error, await undoMoves(done, renameFolder)));
      }
      done.push(move);
      lines.push(move.line);
    }
  }
  return lines;
}
