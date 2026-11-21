/**
 * Mine matching blocks until the caller's inventory quantity is satisfied.
 * The target set is one continuously revalidated composite goal: excavation
 * goals price the work remaining at each stance, and drop goals recover the
 * items that work leaves behind. Search owns approach and dig selection;
 * this process owns quantities, target observation, and lava preparation.
 */
import type { Bot } from "mineflayer";
import { asVec3, cellIntersectsBody, cellKey, waitForTicksOrCancel } from "../../../utils/index.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import type { useItemAt } from "../../../world/item-use.js";
import { isLiquidSource, sourceInSight } from "../../../world/liquid.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import {
  describeCalculationFailure, type BlockPosition, type BreakBlockInPlace, type BreakBlockInPlaceResult,
  type MovementPolicy, type Navigate, type NavigationResult,
} from "../../index.js";
import { liveBlockReader } from "../../mineflayer/world.js";
import { botEyesInWater } from "../../../world/eyes-in-water.js";
import { isWater } from "../../world/block-geometry.js";
import { settleInWaterForDig } from "../../steering/hold-water-position.js";
import { carriesWaterBucket, castOntoPool } from "./cast-obsidian.js";
import type { DropLossObserver } from "./mine-drops.js";
import { clearMiningWater } from "./mining-water.js";
import { hasWetFace, IN_WATER_PREFIX } from "./drowned-target.js";
import { waterMiningStance } from "../../world/water.js";
import { lavaClosuresOf, lavaFacesOf, standsOnBlock, type MineTargetDecision } from "./target-safety.js";
import type { PassedOverNearest } from "./target-weighing.js";
import { MineTargeting } from "./mine-targeting.js";
import { castStance, isDropTarget, targetIdentity, targetInSight, waterStance, workingCells } from "./mine-target-goal.js";
import { mineStopAfterScan, settledMineResult } from "./mine-result.js";

export { MAX_MINE_TARGETS } from "./mine-target-scan.js";

/** A loaded Mineflayer block, which is what `matches` is asked about. */
export type MinecraftBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

/**
 * Stopped routes in a row, with nothing broken or gained between them, before
 * mining settles as stopped. Each stop already gives up one target, but a
 * lava pool casts a fresh obsidian target for every one given up, and a bot
 * pinned in its own poured water stopped forty such routes in a row.
 */
const MAX_FRUITLESS_STOPS = 5;

/** A loaded matching block is owned by its world cell. */
export interface MineBlockTarget {
  readonly position: BlockPosition;
  readonly kind: "block";
  /**
   * Whether a route may break this cell on its way into it. False when liquid
   * touches it: the flood rule refuses such a break in passing, so the process
   * walks into reach, closes the lava faces, and breaks it in place.
   */
  readonly routeMayBreak: boolean;
  readonly drained?: true;
  readonly excludedStances: ReadonlySet<string>;
}

/** A live Mineflayer item remains the same target while its position changes. */
export interface MineDropTarget {
  readonly position: BlockPosition;
  readonly kind: "drop";
  readonly entityId: number;
}

/** A broken source bridges the packet interval before its item entity exists. */
export interface MineAnticipatedDropTarget {
  readonly position: BlockPosition;
  readonly kind: "anticipated_drop";
}

/** An observed item vanished while Mineflayer is still applying its pickup. */
export interface MineSettlingDropTarget {
  readonly position: BlockPosition;
  readonly kind: "settling_drop";
  readonly entityId: number;
}

/**
 * A lava pool the request can cast into, held at its nearest source.
 *
 * Obsidian is the one block a bot manufactures rather than finds, so when a
 * cast request has nothing to mine the lava becomes a target like any other:
 * the route walks to it, the loop pours where it arrives, and the obsidian
 * that forms is an ordinary block target for the next pass.
 */
export interface MinePoolTarget {
  readonly position: BlockPosition;
  readonly kind: "pool";
  readonly sources: readonly BlockPosition[];
  readonly excludedStances: ReadonlySet<string>;
}

/** Water left by a cast must return to its bucket before mining resumes. */
export interface MineWaterTarget {
  readonly kind: "water";
  readonly position: BlockPosition;
  readonly excludedStances: ReadonlySet<string>;
}

/** One thing worth standing at: a block to break, an item to walk over, or a pool to pour on. */
export type MineTarget =
  | MineBlockTarget
  | MineDropTarget
  | MineAnticipatedDropTarget
  | MineSettlingDropTarget
  | MinePoolTarget
  | MineWaterTarget;

export interface MineRequest extends DropLossObserver {
  /** Deliberate discards are excluded from both scans and anticipated drops. */
  readonly ignoredDropIds?: ReadonlySet<number>;
  /** Milliseconds on a monotonic clock; the drop and refresh timers read it. Tests inject a fake. */
  readonly now?: () => number;
  /** Which blocks count as ore. */
  readonly matches: (block: MinecraftBlock) => boolean;
  /**
   * Whether this loaded target can come out, and what must happen first.
   * `target-safety.ts` holds the rule; the caller supplies its policy and world.
   */
  readonly canMine: (block: MinecraftBlock) => MineTargetDecision;
  /** Every raw block-state ID accepted by `matches`. */
  readonly matchingStateIds: ReadonlySet<number>;
  /**
   * Optional exact loaded cell. Kept separate because Mineflayer also calls
   * `matches` on palette blocks with null positions.
   */
  readonly exactTarget?: BlockPosition;
  /** Which dropped item names are worth walking to. */
  readonly collects: (itemName: string) => boolean;
  /**
   * Whether the caller has what it asked for. Baritone's `MineProcess` counts
   * matching items in the inventory itself; ours asks, because what counts as a
   * gain depends on loot tables and silk touch that belong with the caller.
   */
  readonly isSatisfied: () => boolean;
  /** Inventory gain already observed for this collection request. */
  readonly observedInventoryGain: () => number;
  readonly movements: MovementPolicy;
  /** Radius for finding lava pools to cast when no matching block is loaded. */
  readonly castSearchRadius: number;
  /** Search outward from the first empty scan until a loaded column reveals a target. */
  readonly explore: boolean;
  /** A bound on mining for a quantity that never arrives. */
  readonly maximumBreaks: number;
  readonly signal?: AbortSignal;
  /** A policy stop observed between completed digs/routes, preserving safe settlement. */
  readonly stopSignal?: AbortSignal;
  /** Synchronous observer of each changed target set, including refreshes during a route. */
  readonly onTargets?: (targets: readonly MineTarget[]) => void;
  /** Optional per-scan cost budget and additional target distance; absent preserves the legacy scan. */
  readonly targetCost?: { beginScan(): void; cost(position: BlockPosition): number | null };
  /** Every actual scan, including unchanged target sets and candidates passed over by weighing. */
  readonly onScan?: (scan: MineScan) => void;
  /** Preserve observed matching-block removals even when this attempt is cancelled. */
  readonly onBroken?: (position: BlockPosition) => void;
  /** Injectable physical effect for process regressions. */
  readonly breakInPlace: BreakBlockInPlace;
  /** Injectable physical placement: how a lava face is closed before a target break. */
  readonly placeInto: PlaceIntoCell;
  /**
   * How the bot uses its water bucket to cast this request's block out of a
   * lava source, or null when the block cannot be made that way — which is
   * every block but obsidian. With it, a run that finds no target and does
   * find lava makes its own targets rather than reporting none.
   */
  readonly cast: typeof useItemAt | null;
  /**
   * Route execution, injectable so the process can be exercised without a
   * server. Every bug this loop has had was in how it reacts to a route's
   * outcome, which is a question a fake can answer in a millisecond.
   */
  readonly route: Navigate;
}

export type MineResult = {
  readonly status: "satisfied" | "no_targets" | "unreachable" | "exhausted" | "stopped";
  /** Cells of matching blocks that stopped matching while this process was running, in the order observed. */
  readonly broken: readonly BlockPosition[];
  readonly reason: string | null;
  readonly underWater?: true;
  /** Present with targetCost: the largest number passed over in any one scan, and its nearest target. */
  readonly passedOver?: number;
  readonly passedOverNearest?: PassedOverNearest | null;
};

/**
 * Matching blocks and collectable items within range, optionally weighed by the caller.
 *
 * Baritone's `prune` drops duplicates, blacklisted cells, cells that no longer
 * match, and anything implausible to break, then sorts by distance and caps the
 * list. The raw scan is already nearest-first, so only candidates retained for
 * the composite goal need to become Mineflayer's richer block objects.
 */
export interface MineScan {
  readonly targets: readonly MineTarget[];
  readonly candidates: readonly MineBlockTarget[];
  readonly passedOver: readonly MineBlockTarget[];
  /** How many loaded matching blocks were rejected, by the reason each was rejected for. */
  readonly rejections: ReadonlyMap<string, number>;
  readonly underWaterRejections: number;
}

/**
 * Close every lava cell touching the target with a carried block, from where
 * the bot stands, and say why if one of them would not close. A drop that
 * would fall down an open column into lava gets a floor under the target too.
 *
 * The count is taken here, over the six neighbours, from the live world after
 * the route has ended — not from the scan that chose the target, which may be
 * seconds and several blocks stale. A face missed by the count floods the
 * mined cell, which is the one way this whole design goes wrong.
 */
async function sealLavaFaces(
  bot: Bot,
  request: MineRequest,
  position: BlockPosition,
  signal?: AbortSignal,
): Promise<SealRefusal | null> {
  for (const cell of lavaClosuresOf(bot, position)) {
    signal?.throwIfAborted();
    const placed = await request.placeInto(bot, cell, { ...(signal && { signal }) });
    signal?.throwIfAborted();
    if (placed.kind === "failed") {
      const what = bot.blockAt(asVec3(cell))?.name === "lava" ? "the lava" : "the floor over lava";
      // The bot's own body in the cell is this stance's fault, not the block's; another body leaves the block refused.
      const ownBody = placed.cause === "entity" && cellIntersectsBody(cell, bot.entity);
      return { reason: `${what} at ${cellKey(cell)} could not be closed: ${placed.error}`, ownBody };
    }
  }
  return null;
}

/** Why a lava face would not close, and whether the bot's own body held the cell. */
interface SealRefusal {
  readonly reason: string;
  readonly ownBody: boolean;
}

/**
 * A lava source touching an obsidian target is more obsidian, and a seal
 * would turn it into rock: pour on it from here first. One attempt per
 * source; a pour that cannot land or forms nothing leaves it to the seal.
 * No sight line is opened, since the nearest block in the way may be the
 * target itself with lava behind it.
 */
async function castTouchingSources(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  position: BlockPosition,
  signal?: AbortSignal,
): Promise<boolean> {
  const useItem = request.cast;
  if (useItem === null || !carriesWaterBucket(bot)) return false;
  const sources = lavaFacesOf(bot, position).filter(
    (face) => isLiquidSource(bot, bot.blockAt(asVec3(face)), "lava") && targeting.mayCastTouching(face),
  );
  if (sources.length === 0) return false;
  targeting.castTouching(sources);
  const physics = { useItem, breakInPlace: request.breakInPlace, movements: request.movements, ...(signal && { signal }) };
  targeting.beginCast();
  let outcome;
  try {
    outcome = await castOntoPool(bot, physics, sources, { openSightLine: false });
  } finally {
    targeting.endCast();
  }
  if (outcome.kind !== "cast") return false;
  if (!outcome.formationsAnswered) targeting.forgetCastTouching(sources);
  if (!outcome.waterRecovered) targeting.recoverWater(outcome.landing);
  targeting.refresh();
  return !outcome.formationsAnswered || outcome.obsidianFormed > 0 || !outcome.waterRecovered;
}

/**
 * After the drain or the seal changed the world, whether this step ends before the swing. The target must still be the
 * block the step set out to break, the body must still stand on one of its working cells (else the next pass
 * re-arrives), and the live eye must still see it: a dig this stance cannot make refuses the stance, not the block,
 * and spends no seal block (t00780: three seals after a plug that hid the only ray).
 */
function stepEndsBeforeSwing(bot: Bot, request: MineRequest, targeting: MineTargeting, target: MineBlockTarget): boolean {
  const block = bot.blockAt(asVec3(target.position));
  const feet = bot.entity.position.floored();
  if (block === null || !request.matches(block) ||
    !workingCells(bot, target, request.movements).some((cell) => cellKey(cell) === cellKey(feet))) {
    targeting.refresh();
    return true;
  }
  if (targetInSight(bot, bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0), target.position)) return false;
  targeting.excludeBlockStance(target, feet);
  return true;
}

/** A swing that failed: the support re-reads, the stance is refused, anything else refuses the block. */
function refuseFailedSwing(
  bot: Bot,
  targeting: MineTargeting,
  target: MineBlockTarget,
  swing: Extract<BreakBlockInPlaceResult, { status: "failed" }>,
): void {
  if (swing.cause === "support") {
    targeting.lastReason = swing.reason;
    targeting.refresh();
  } else if (swing.cause === "stance") targeting.excludeBlockStance(target, bot.entity.position.floored(), swing.reason);
  else targeting.blacklist(target, swing.reason);
}

async function breakTargetInPlace(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  target: MineBlockTarget,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (refreshDependentStance(bot, targeting, target.position)) return;
  const workingFeet = bot.entity.position.floored();
  targeting.attemptedWork = true;
  if (await castTouchingSources(bot, request, targeting, target.position, signal)) return;
  signal?.throwIfAborted();
  const water = await clearMiningWater(bot, target.position, request.placeInto, request.cast, signal);
  signal?.throwIfAborted();
  if (refreshDependentStance(bot, targeting, target.position)) return;
  if (water !== null) {
    const world = { blockAt: liveBlockReader(bot), revision: 0, subscribe: () => () => {} };
    if (target.drained && hasWetFace(world, target.position)) {
      targeting.blacklist(target, `${IN_WATER_PREFIX}the drain failed: ${water}`);
      return;
    }
    // Preparation can move the bot in a current. Reject the stance we tried,
    // not the lower cell it sank into while the water was being isolated.
    targeting.excludeBlockStance(target, workingFeet, water);
    return;
  }
  if (stepEndsBeforeSwing(bot, request, targeting, target)) return;
  const seal = await sealLavaFaces(bot, request, target.position, signal);
  signal?.throwIfAborted();
  if (refreshDependentStance(bot, targeting, target.position)) return;
  if (seal !== null) {
    if (seal.ownBody) targeting.excludeBlockStance(target, bot.entity.position.floored(), seal.reason);
    else targeting.blacklist(target, seal.reason);
    return;
  }
  if (stepEndsBeforeSwing(bot, request, targeting, target)) return;
  const swing = await request.breakInPlace({ movements: request.movements, position: target.position, retainSupport: true, signal });
  // A swing that answers a refusal as the bot dies must not record one: the abort ends the step first.
  signal?.throwIfAborted();
  if (swing.status === "failed") {
    refuseFailedSwing(bot, targeting, target, swing);
    return;
  }
  targeting.refresh();
}

/** Re-select a working stance when preparation moved the body onto the target's support. */
function refreshDependentStance(bot: Bot, targeting: MineTargeting, position: BlockPosition): boolean {
  if (!standsOnBlock(bot, position)) return false;
  targeting.lastReason = `the target at ${cellKey(position)} supports the body; approach from a supported bank`;
  targeting.refresh();
  return true;
}

/**
 * Targets whose break the route refuses, or work attempted from a current:
 * prepare one and break it where the bot stands. A block with liquid against it comes out here —
 * a route that could clear the way to it would have to open that liquid into
 * its own path first.
 *
 * Exactly one per pass, unlike the shaft, because these are broken from beside
 * rather than from inside and their drops stay where the block was: the lake
 * fixture spent its whole break allowance on a burst of six and walked home
 * with four obsidian while ten lay on the ground.
 */
async function sealAndBreakInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  // Working cells may be reached by swimming. The physical dig owns water
  // positioning and its slower dig time; requiring ground here leaves that
  // already-satisfied goal repeatedly arriving without ever starting the dig.
  if ((!bot.entity.onGround && Reflect.get(bot.entity, "isInWater") !== true) || targeting.isSatisfied()) return false;
  if (targeting.broken.length >= request.maximumBreaks) return false;
  // Collect what the last one of these left on the ground first.
  if (targeting.targets().some(isDropTarget)) return false;
  const feet = bot.entity.position.floored();
  const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
  const read = liveBlockReader(bot);
  const currentNeedsPreparation = isWater(read(feet.x, feet.y, feet.z)) && !waterMiningStance(read, feet, bot.entity.onGround);
  const target = targeting
    .targets()
    .find(
      (candidate): candidate is MineBlockTarget =>
        candidate.kind === "block" &&
        (!candidate.routeMayBreak || currentNeedsPreparation) &&
        workingCells(bot, candidate, request.movements).some((cell) => cellKey(cell) === cellKey(feet)) &&
        targetInSight(bot, eye, candidate.position),
    );
  if (!target) return false;
  // A goal can become satisfied during a speculative search as the swimmer
  // enters this cell. Mining needs the actual floor, not the floored Y alone.
  if (!(await settleInWaterForDig(bot, read, feet, botEyesInWater(bot), signal))) return false;
  await breakTargetInPlace(bot, request, targeting, target, signal);
  return true;
}

/**
 * Pools the bot is standing beside: pour, and let the rescan mine what formed.
 *
 * This is the cast, and it sits here rather than in a branch of its own
 * because it is the same shape as the seal — a target the route walked to that
 * has to be worked where the bot stands. A pour that made no obsidian gives up
 * on the pool and says so; one that made some is left alone, so a lake can be
 * poured again when the first ring is not enough.
 */
async function castInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const useItem = request.cast;
  if (useItem === null || bot.entity.onGround !== true || targeting.isSatisfied()) return false;
  const feet = bot.entity.position.floored();
  const target = targeting.targets().find((candidate) => candidate.kind === "pool" && castStance(candidate, feet));
  if (target?.kind !== "pool") return false;

  const physics = {
    useItem,
    breakInPlace: request.breakInPlace,
    movements: request.movements,
    ...(signal && { signal }),
  };
  targeting.beginCast();
  let outcome;
  try {
    outcome = await castOntoPool(bot, physics, target.sources);
  } finally {
    targeting.endCast();
  }
  if (outcome.kind === "reposition") {
    targeting.excludeCastStance(target, feet, outcome.reason);
    return true;
  }
  if (outcome.kind === "failed") {
    targeting.blacklist(target, `the lava at ${cellKey(target.position)} could not be cast: ${outcome.reason}`);
    return true;
  }
  if (outcome.obsidianFormed === 0 && outcome.formationsAnswered) {
    targeting.blacklist(target, `the pour into ${cellKey(outcome.landing)} formed no obsidian`);
  }
  if (!outcome.waterRecovered) targeting.recoverWater(outcome.landing);
  targeting.refresh();
  return true;
}

/** Re-approach the known source when the original pour ray can no longer scoop it. */
async function recoverWaterInReach(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  signal?: AbortSignal,
): Promise<boolean> {
  const target = targeting.targets().find((candidate) => candidate.kind === "water");
  if (target?.kind !== "water" || request.cast === null) return false;
  const feet = bot.entity.position.floored();
  if (
    !waterStance(bot, target, feet) ||
    !sourceInSight(bot, bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0), asVec3(target.position))
  )
    return false;
  const bucket = bot.inventory.items().find((item) => item.name === "bucket");
  if (!bucket) {
    targeting.blacklist(target, "the cast water remains in the world, but no empty bucket is carried");
    return true;
  }
  const outcome = await request.cast(bot, {
    item: bucket,
    lookAt: asVec3(target.position).offset(0.5, 0.9, 0.5),
    expectedHeldItem: "water_bucket",
    // The hand can change before the block update; a standing source would be plugged next.
    expectedCells: [{ position: target.position, matches: (block) => !isLiquidSource(bot, block, "water") }],
    ...(signal && { signal }),
  });
  if (outcome.kind === "failed") targeting.excludeWaterStance(target, feet, outcome.error);
  targeting.refresh();
  return true;
}

async function waitForProcessTick(bot: Bot, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await waitForTicksOrCancel(bot, 1, signal);
  signal?.throwIfAborted();
}

export async function mine(bot: Bot, request: MineRequest): Promise<MineResult> {
  const targeting = new MineTargeting(bot, request);
  const drive = request.route;
  const settle = (status: MineResult["status"]) => settledMineResult(targeting, status);
  let fruitlessStops = 0;

  while (!targeting.isSatisfied()) {
    request.signal?.throwIfAborted();
    if (request.stopSignal?.aborted) {
      targeting.lastReason = String(request.stopSignal.reason);
      return settle("stopped");
    }
    if (targeting.broken.length >= request.maximumBreaks) return settle("exhausted");

    const targets = targeting.targets();
    const stopped = mineStopAfterScan(targeting, targets);
    if (stopped) return stopped;

    if (await recoverWaterInReach(bot, request, targeting, request.signal)) continue;
    // Submerged work must occur inside navigation's scoped dive, including work already in reach.
    if (!botEyesInWater(bot) &&
      await sealAndBreakInReach(bot, request, targeting, request.signal)) continue;
    if (await castInReach(bot, request, targeting, request.signal)) continue;

    if (targeting.anticipatingDrop && targets.every(isDropTarget)) {
      // Nothing to walk to and nothing to break: let the server deliver the
      // pickup rather than asking again as fast as the loop can turn.
      await waitForProcessTick(bot, request.signal);
      continue;
    }

    const routedTargets = targets.map(targetIdentity).join("|");
    const workBefore = `${targeting.broken.length}:${request.observedInventoryGain()}`;
    const route = await runRoute(bot, request, targeting, drive);
    if (targeting.isSatisfied()) break;
    if (route.status === "stopped") {
      const currentTargets = targeting.refresh();
      if (currentTargets.map(targetIdentity).join("|") !== routedTargets) continue;
      // A live item can vanish after pickup while the route still refers to it.
      // Productive work is not evidence that the remaining block is unreachable.
      if (`${targeting.broken.length}:${request.observedInventoryGain()}` !== workBefore) {
        fruitlessStops = 0;
        continue;
      }
      fruitlessStops += 1;
      if (fruitlessStops >= MAX_FRUITLESS_STOPS) {
        targeting.lastReason = `${MAX_FRUITLESS_STOPS} routes in a row stopped without breaking or gaining anything; the last: ${route.reason}`;
        return settle("stopped");
      }
      // A goal the route could not reach is not a reason to abandon mining,
      // only that target. When a planned break is what failed, that block is
      // the one to give up; Baritone's `blacklistClosestOnFailure` guess of
      // the target nearest the bot dropped an untouched column instead.
      const blamed = route.failedBreak !== undefined && targeting.blacklistAt(route.failedBreak, route.reason);
      if (!blamed && !targeting.blacklistClosest(bot.entity.position, route.reason)) return settle("stopped");
    } else {
      // A route can settle on the same tick that a new item entity arrives.
      // Re-open the scan at this physical boundary instead of treating the
      // callback's previously empty cache as proof that mining is finished.
      const current = targeting.refresh();
      // A route that arrives and changes nothing will arrive and change
      // nothing again. A target broken from beside it has a goal that is
      // satisfied where the bot already stands, so this is now reachable
      // rather than theoretical: give up on that target and say why, instead
      // of asking the navigator the same question until the caller's deadline.
      const idle =
        `${targeting.broken.length}:${request.observedInventoryGain()}` === workBefore &&
        current.map(targetIdentity).join("|") === routedTargets &&
        current.length > 0;
      if (idle) {
        // Blame the target this stance serves, not merely the nearest one.
        const reason = "arrived, and nothing there could be broken";
        const feet = cellKey(bot.entity.position.floored());
        const served = current.find((target) =>
          target.kind === "block" && workingCells(bot, target, request.movements).some((cell) => cellKey(cell) === feet));
        const blamed = served !== undefined && targeting.blacklistAt(served.position, reason);
        if (!blamed && !targeting.blacklistClosest(bot.entity.position, reason)) return settle("stopped");
      }
    }
  }

  return settle("satisfied");
}

/**
 * One leg: walk under a goal that keeps re-evaluating, and stop as soon as the
 * quantity is met rather than finishing a route nobody needs any more.
 */
async function runRoute(
  bot: Bot,
  request: MineRequest,
  targeting: MineTargeting,
  drive: Navigate,
): Promise<NavigationResult> {
  const enough = new AbortController();
  const poll = setInterval(() => {
    if (targeting.isSatisfied()) enough.abort("the requested quantity is in the inventory");
  }, 100);
  try {
    return await drive({
      movements: request.movements,
      goal: targeting.routeGoal(),
      onArrival: async ({ signal }) => {
        if (targeting.isSatisfied() || targeting.broken.length >= request.maximumBreaks) return { kind: "completed" };

        const targets = targeting.refresh();
        if (targeting.isSatisfied() || targets.length === 0 || targeting.broken.length >= request.maximumBreaks)
          return { kind: "completed" };

        const acted =
          (await recoverWaterInReach(bot, request, targeting, signal)) ||
          (await sealAndBreakInReach(bot, request, targeting, signal)) ||
          (await castInReach(bot, request, targeting, signal));
        if (!acted) {
          // A stone lip can occlude a target even from an adjoining cell.
          // Re-approach that target instead of repeating the same arrival.
          if (bot.entity.onGround || Reflect.get(bot.entity, "isInWater") === true) {
            const feet = bot.entity.position.floored();
            for (const target of targets) {
              if (
                target.kind === "block" &&
                !target.routeMayBreak &&
                workingCells(bot, target, request.movements).some((cell) => cellKey(cell) === cellKey(feet)) &&
                !targetInSight(bot, bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0), target.position)
              ) {
                targeting.excludeBlockStance(target, feet);
              }
            }
          }
          // Baritone reaches this state once per client tick. Our continuation
          // callback can resolve again immediately, so wait for the next real
          // Mineflayer physics tick before evaluating the occupied drop cell.
          await waitForProcessTick(bot, signal);
        }

        return targeting.isSatisfied() || targeting.broken.length >= request.maximumBreaks
          ? { kind: "completed" }
          : { kind: "continue" };
      },
      onCalculationFailure: async ({ failure, observation, signal }) => {
        const failedTarget = targeting.closestTarget(observation.position);
        if (failedTarget === null) {
          targeting.failExploration(describeCalculationFailure(failure));
          return { kind: "completed" };
        }
        if (failedTarget.kind === "drop" && targeting.dropInFlight(failedTarget.entityId)) {
          // A top log's item is initially too high for any pickup stance.
          // Let its native flight settle before judging reachability. Contact
          // with a block/fluid, disappearance, or cancellation ends this wait;
          // a stationary unreachable item still takes the blacklist path below.
          do {
            await waitForProcessTick(bot, signal);
          } while (targeting.dropInFlight(failedTarget.entityId) && !targeting.isSatisfied());
          targeting.refresh();
          return targeting.isSatisfied() ? { kind: "completed" } : { kind: "continue" };
        }
        // Only an in-flight packet transition has something left to wait for.
        // A live unreachable item can remain forever; waiting there drowned
        // the miner after a failed route into a water-filled pickup hole.
        if (failedTarget.kind === "anticipated_drop" || failedTarget.kind === "settling_drop") {
          const failedDrop = targetIdentity(failedTarget);
          for (;;) {
            await waitForProcessTick(bot, signal);
            const waitingTargets = targeting.refresh();
            if (targeting.isSatisfied() || waitingTargets.length === 0) return { kind: "completed" };
            const failedDropStillExists = waitingTargets.some((target) => targetIdentity(target) === failedDrop);
            if (!failedDropStillExists) return { kind: "continue" };
          }
        }
        const blacklisted = targeting.blacklistClosest(observation.position, describeCalculationFailure(failure));
        if (!blacklisted) return { kind: "completed" };

        const targets = targeting.refresh();
        return targets.length === 0 ? { kind: "completed" } : { kind: "continue" };
      },
      signal: request.signal,
      stopSignal: request.stopSignal
        ? AbortSignal.any([enough.signal, request.stopSignal])
        : enough.signal,
    });
  } finally {
    clearInterval(poll);
  }
}
