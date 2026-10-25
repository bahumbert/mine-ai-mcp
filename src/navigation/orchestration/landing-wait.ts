/**
 * The wait for an airborne body to land, bounded by the wall clock.
 *
 * `stabilize` counts physics ticks, so a body whose physics has stopped (a
 * ride, an unloaded chunk, a death waiting for the respawn) would wait for
 * ticks that never come, with the run's hold and listeners still on the bot.
 * Twenty ticks are one second; two seconds of wall clock without them read as
 * stopped physics.
 *
 * A body whose ticks flow but which never lands, hovering within a quarter
 * block over a cell its own world shows as air, is held by the server (ghost
 * air, run 16): the wait asks the server to send that cell again, once, and
 * waits again.
 */
import type { NavigationBot, CellResync } from "../bot.js";
import { isPassable } from "../world/block-geometry.js";
import { type Position3, supportCellOf, type WorldView } from "../world/world.js";

/** Twice the 20 ticks `stabilize` observes: enough for a server that stalls briefly, short enough to answer the model. */
export const LANDING_WALL_MS = 2_000;
/** A real fall descends further than this while `stabilize` watches; a body held by the server hardly moves. */
const HELD_VERTICAL_BLOCKS = 0.3;
const HELD_HORIZONTAL_BLOCKS = 0.2;

export type LandingResult =
  | { readonly kind: "stable" }
  | { readonly kind: "failed"; readonly observation: string }
  | { readonly kind: "stopped" };

export interface LandingOptions {
  readonly wallMs?: number;
  /** The client's cells. Without it a failed wait is never read as a held body, and nothing is asked of the server. */
  readonly world?: Pick<WorldView, "blockAt">;
}

/** One wait: the landing result, or `silent` when the wall clock ended it with no physics tick at all. */
type Wait = LandingResult | { readonly kind: "silent"; readonly observation: string };

/**
 * The wait failed with ticks flowing, the body stayed within a third of a block where it began, and its own world shows
 * air under its feet: the server holds it up, or something it holds the client has not been told.
 */
export function heldInAirByServer(before: Position3, after: Position3, world: Pick<WorldView, "blockAt">): boolean {
  if (Math.abs(after.y - before.y) >= HELD_VERTICAL_BLOCKS) return false;
  if (Math.hypot(after.x - before.x, after.z - before.z) >= HELD_HORIZONTAL_BLOCKS) return false;
  const cell = supportCellOf(after);
  return isPassable(world.blockAt(cell.x, cell.y, cell.z));
}

const at = (position: Position3) => `${position.x.toFixed(2)}, ${position.y.toFixed(2)}, ${position.z.toFixed(2)}`;

async function waitForLanding(bot: Pick<NavigationBot, "stabilize" | "observe">, signal: AbortSignal | null, wallMs: number): Promise<Wait> {
  const wall = new AbortController();
  const timer = setTimeout(() => wall.abort(new Error(`no landing within ${wallMs} ms`)), wallMs);
  try {
    return await bot.stabilize(signal ? AbortSignal.any([signal, wall.signal]) : wall.signal);
  } catch (cause) {
    if (signal?.aborted) return { kind: "stopped" };
    if (!wall.signal.aborted) throw cause;
    return {
      kind: "silent",
      observation:
        `No physics tick for ${wallMs / 1000} s while airborne at ${at(bot.observe().position)}; ` +
        `the landing could not be observed. Wait until the bot stands on the ground, then give the order again.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The failure of a body the server holds although a resend of its cell was asked: the model's next step is an order that makes the server resend. */
function heldAfterResend(position: Position3): LandingResult {
  return {
    kind: "failed",
    observation:
      `The server holds the bot at ${at(position)} while its world shows air under the feet; a resend of the cell was ` +
      `asked and changed nothing. Digging or placing a block beside the bot makes the server resend its cells; give an ` +
      `order that does, then walk again.`,
  };
}

/**
 * `signal` is the run's: its abort ends the wait as `stopped`. `null` bounds the
 * wait by the wall clock only, for the search's `finally`, which keeps its hold
 * through a cancel on purpose until the landing is seen or the bound passes.
 */
export async function awaitLanding(
  bot: Pick<NavigationBot, "stabilize" | "observe" | "requestCellResync">,
  signal: AbortSignal | null,
  options: LandingOptions = {},
): Promise<LandingResult> {
  const wallMs = options.wallMs ?? LANDING_WALL_MS;
  const before = bot.observe().position;
  const first = await waitForLanding(bot, signal, wallMs);
  if (first.kind === "silent") return { kind: "failed", observation: first.observation };
  if (first.kind !== "failed" || !options.world || !bot.requestCellResync) return first;
  if (!heldInAirByServer(before, bot.observe().position, options.world)) return first;
  let asked: CellResync;
  try {
    asked = await bot.requestCellResync(supportCellOf(bot.observe().position), signal ?? new AbortController().signal);
  } catch (cause) {
    if (signal?.aborted) return { kind: "stopped" };
    throw cause;
  }
  if (asked === "unavailable") return first;
  const second = await waitForLanding(bot, signal, wallMs);
  if (second.kind === "silent") return { kind: "failed", observation: second.observation };
  return second.kind === "failed" ? heldAfterResend(bot.observe().position) : second;
}
