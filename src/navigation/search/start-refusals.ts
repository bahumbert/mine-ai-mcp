/**
 * Why a bot that found no way out of its own cell is shut in: the breaks the policy refused around the start, counted
 * by cause (run 15: Dirk and Sana, 216 and 164 minutes pinned behind a "dead end" claim that named no reason).
 *
 * Asked once, after a search is exhausted, of the cells a first move could dig: the four sides at feet and head height,
 * the block over the head and the block under the feet. Never part of the search itself.
 */
import { standsFree } from "../movements/catalogue.js";
import { breakRefusalCause, type MovementPolicy } from "../movements/policy.js";
import { isPassable } from "../world/block-geometry.js";
import type { BlockPosition, WorldView } from "../world/world.js";
import type { SearchEvidence } from "./search-result.js";

/** Refusal counts by cause: the policy's own causes, `policy_dig_down` (the style override), `unloaded`. */
export type StartRefusals = Readonly<Record<string, number>>;

/**
 * Whether an exhausted search visited the start cell and nothing else (Dirk and Sana: "visited 1 nodes, generated 1"):
 * only then are the refusals counted at the start what shuts the bot in. A shore with an unreachable goal visits every
 * cell of the shore, and a refusal there says nothing of why the goal is out of reach.
 */
export function neverLeftStart(search: Pick<SearchEvidence, "visited">): boolean {
  return search.visited <= 1;
}

const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/** Count the refused first digs around `feet`; a cell the bot can already pass, swim or stand in refuses nothing. */
export function countStartRefusals(world: WorldView, policy: MovementPolicy, feet: BlockPosition): StartRefusals {
  const counts: Record<string, number> = {};
  const count = (cause: string) => { counts[cause] = (counts[cause] ?? 0) + 1; };
  const refusalAt = (x: number, y: number, z: number): string | null => {
    const block = world.blockAt(x, y, z);
    if (block.kind === "unloaded") return "unloaded";
    if (isPassable(block) || block.traits.liquid !== null) return null;
    const priced = policy.priceBreak(block, x, y, z, world).decision;
    if (priced.kind === "prohibited") return breakRefusalCause(priced);
    const confirmed = policy.confirmBreak(block, { x, y, z }, world);
    return confirmed.kind === "prohibited" ? breakRefusalCause(confirmed) : null;
  };
  const sides = SIDES.flatMap(([dx, dz]) => [[feet.x + dx, feet.y, feet.z + dz], [feet.x + dx, feet.y + 1, feet.z + dz]] as const);
  for (const [x, y, z] of [...sides, [feet.x, feet.y + 2, feet.z] as const, [feet.x, feet.y - 1, feet.z] as const]) {
    const cause = refusalAt(x, y, z);
    if (cause !== null) count(cause);
  }
  // The style override refuses a dig down that nothing else refuses, so it is named only when it is the one reason.
  const below = world.blockAt(feet.x, feet.y - 1, feet.z);
  if (below.kind === "loaded" && !isPassable(below) && refusalAt(feet.x, feet.y - 1, feet.z) === null
    && !policy.allowDownward && !standsFree(world.blockAt.bind(world), feet.x, feet.y - 1, feet.z)) {
    count("policy_dig_down");
  }
  return counts;
}
