import { z } from "zod";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";

/** The params of the two pinned-watch scenarios: the shortened window, the navigate target, how long to stand shut in. */
export const pinnedWindowParamsIn = (arena: ArenaFrame) => z.strictObject({
  /** The runtime's pinned window, shortened from ten minutes: the host reads it. */
  pinnedWindowMs: z.number().int().positive(),
  target: arenaPoint(arena),
  /** Ticks to stand in the corridor or box once the failures are in, a little longer than the window. */
  waitTicks: z.number().int().positive(),
});
