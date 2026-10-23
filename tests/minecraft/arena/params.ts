/**
 * zod schemas for the coordinates a scenario's YAML `params` hold. YAML writes them in arena-local coordinates (the
 * same file runs at offset zero and in any lane); a driver builds its schema from `context.arena` and so reads them
 * as world coordinates, in the frame its observed positions and action inputs are in.
 */
import { z } from "zod";
import type { ArenaFrame } from "./frame.ts";

/** `[x, y, z]` (decimals allowed: a feet position) as a world position. */
export function arenaPoint(frame: ArenaFrame) {
  return z.tuple([z.number(), z.number(), z.number()]).transform(([x, y, z]) => frame.world([x, y, z]));
}

/** `{ x, y, z }` block cell as a world cell. */
export function arenaCell(frame: ArenaFrame) {
  return z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).transform((cell) => {
    const [x, y, z] = frame.world([cell.x, cell.y, cell.z]);
    return { x, y, z };
  });
}

/** A lone x (a line the bot must cross) as a world x. */
export function arenaX(frame: ArenaFrame) {
  return z.number().transform((x) => frame.world([x, 0, 0])[0]);
}
