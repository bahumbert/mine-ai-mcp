/** The scaffold takedown of a complete build: the blocks its routes placed are dug out again, their items picked up. */
import type { Bot } from "mineflayer";
import { asVec3 } from "../../../utils/index.js";
import { DIG_CLEAR_BLOCK } from "../../../world/dig-clear.js";
import { snapshotEntityIds } from "../../../world/item-pickup.js";
import { packKey, type BlockPosition } from "../../index.js";
import { build, BuildProgress, type BuildRequest, type BuildResult, type PlacedScaffold } from "./build-process.js";
import { pickUpScaffoldDrops } from "./scaffold-drops.js";

/** Rounds of scaffold takedown: the highest block first, and a round's own pillars are taken down in the next (live count unmeasured: a pillar is a few blocks). */
const MAX_TAKEDOWN_ROUNDS = 4;

const keyOf = (position: BlockPosition) => packKey(position.x, position.y, position.z);

/** Whether the scaffold block placed at a cell still stands there. */
const standsStill = (bot: Bot, placed: PlacedScaffold): boolean => bot.blockAt(asVec3(placed.position))?.stateId === placed.stateId;

/** One round's digs: the build's own loop with `before` as air; what its routes placed to reach them goes into `known`, abort or not. */
async function digRound(bot: Bot, request: BuildRequest, before: readonly PlacedScaffold[], known: Map<number, PlacedScaffold>): Promise<void> {
  const takedown = new BuildProgress();
  try {
    await build(bot, { ...request, removeWrongBlocks: true, cells: [...request.cells, ...before.map(({ position }) => ({ position, blockName: DIG_CLEAR_BLOCK }))] }, true, takedown);
  } catch (error) {
    request.signal?.throwIfAborted();
    void error;
  } finally {
    for (const [key, placed] of takedown.scaffold) known.set(key, placed);
  }
}

/**
 * Takes the scaffold down after a complete build: every block the routes placed (in any attempt) that is no cell of
 * the structure and still stands, highest first, through the build's own loop with those cells as air (the
 * structure's cells stay as they are, so they stay protected). A round's own routes may pillar up to reach the highest
 * block, and what they place is scaffold too (house-templates scenario ndebele-house: one dirt block stayed, later calls
 * forgot it): rounds repeat while the standing scaffold changes, at most `MAX_TAKEDOWN_ROUNDS` (a round after which nothing
 * stands, or the same blocks stand as before it, ends it; each round is bounded by the build loop's own idle passes and the abort signal).
 * Scaffold already gone (taken down by an earlier attempt, a reflex or another bot) is skipped and counts as removed;
 * what cannot be reached stays and is reported. The items a round's digs dropped are walked to and picked up at the end of
 * that round (`pickUpScaffoldDrops`: a block dug from a few blocks away drops its item there, and the next call needs it as
 * scaffold). What that walk places is scaffold too (Mine Labs 2026-11-17: a step block under an item still falling, 13 of 60
 * runs): it stands after the round's sweep, so the next round digs it; only a sweep of the last round leaves its block, reported. A failure here never fails the build, except an abort, which a resume
 * runs again: what a round placed is written into the request's own `scaffold` map at once, abort or not, so the resume
 * takes it down too, and the entities lying when the request's first takedown began are kept in its progress, so the
 * resume's sweep still finds the drops of the cut one.
 */
export async function takeScaffoldDown(
  bot: Bot,
  request: BuildRequest,
  built: BuildResult,
  progress: BuildProgress,
): Promise<BuildResult> {
  if (progress.scaffold.size === 0) return built;
  const structure = new Set(request.cells.map((cell) => keyOf(cell.position)));
  const known = progress.scaffold;
  const temporary = () => [...known.entries()].filter(([key]) => !structure.has(key)).map(([, placed]) => placed);
  const standing = () => temporary().filter((placed) => standsStill(bot, placed)).sort((a, b) => b.position.y - a.position.y);
  // Only what the takedown's own digs drop is picked up afterwards: the items already lying about are not its business.
  progress.lyingBeforeTakedown ??= snapshotEntityIds(bot);
  const triedDrops = new Set<number>();
  for (let round = 0; round < MAX_TAKEDOWN_ROUNDS; round += 1) {
    const before = standing();
    if (before.length > 0) await digRound(bot, request, before, known);
    // The sweep belongs to its round: what its walk places stands after it and is dug by the next round, not left behind.
    try {
      await pickUpScaffoldDrops(bot, request, progress, temporary().filter((placed) => !standsStill(bot, placed)).map(({ position }) => position), triedDrops);
    } catch (error) {
      request.signal?.throwIfAborted();
      void error;
    }
    const after = standing();
    if (after.length === 0 || (after.length === before.length && after.every((placed, index) => keyOf(placed.position) === keyOf(before[index]!.position)))) break;
  }
  const left = standing().map(({ position }) => position);
  return { ...built, scaffold: { placed: known.size, removed: temporary().length - left.length, left } };
}
