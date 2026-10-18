import { placeCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  createMovements,
  nearGoal,
  type Goal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { cellIntersectsPlayerBody, cellKey } from "../../utils/index.js";
import {
  carriedCount,
  isReplaceableForPlacement,
  placeBlock,
  placeCarriedBlockNearby,
  settledNow,
  settleInventoryCount,
  type BlockPlacementResult,
  type SettledInventoryCount,
  type WorldBlock,
} from "../../world/index.js";
import type { ObserveRequest } from "../../session/request.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import { unconfirmedCount } from "../markdown.js";
import {
  parsePlaceBlockRequest,
  placeBlockAnnotations,
  placeBlockOutcomes,
  placeBlockOutcomesNearby,
  PLACE_BLOCK,
  PLACE_BLOCK_DESCRIPTION,
  placeBlockInputSchema,
  placeBlockResultSchema,
  type BlockPlacementEvidence,
  type PlaceBlockRequest,
  type PlaceBlockResult,
} from "./contract.js";

const PLACEMENT_REACH = 4;

const SUPPORT_DIRECTIONS = [
  { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
  { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
  { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
  { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) },
  { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
  { offset: new Vec3(0, 1, 0), face: new Vec3(0, -1, 0) },
] as const;

export interface PlaceBlockDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly placeBlock: (bot: Bot, placement: Parameters<typeof placeBlock>[1]) => Promise<BlockPlacementResult>;
  readonly placeNearby: typeof placeCarriedBlockNearby;
}

function productionDependencies(navigate: Navigate): PlaceBlockDependencies {
  return { createMovements, navigate, placeBlock, placeNearby: placeCarriedBlockNearby };
}

function coordinates(position: Vec3): { x: number; y: number; z: number } {
  return { x: position.x, y: position.y, z: position.z };
}

function evidence(
  bot: Bot,
  request: PlaceBlockRequest,
  target: Vec3,
  inventoryBefore: number,
  beforeBlock: string | null,
  support?: { block: WorldBlock; face: Vec3 },
  placed = false,
  /** The settled count, on the paths that put a block down. */
  after: SettledInventoryCount = settledNow(bot, request.blockName),
): BlockPlacementEvidence {
  return {
    dimension: bot.game.dimension,
    requestedBlock: request.blockName,
    target: coordinates(target),
    beforeBlock,
    afterBlock: bot.blockAt(target)?.name ?? null,
    inventoryBefore,
    inventoryAfter: after.count,
    confirmed: after.confirmed,
    placed,
    ...(support && { support: coordinates(support.block.position), face: coordinates(support.face) }),
  };
}

function findSupport(bot: Bot, target: Vec3): { block: WorldBlock; face: Vec3 } | null {
  for (const candidate of SUPPORT_DIRECTIONS) {
    const block = bot.blockAt(target.plus(candidate.offset));
    if (block?.boundingBox === "block") return { block, face: candidate.face };
  }
  return null;
}

async function approachTarget(
  bot: Bot,
  target: Vec3,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
): Promise<NavigationResult | null> {
  if (
    bot.entity.position.distanceTo(target) <= PLACEMENT_REACH &&
    !cellIntersectsPlayerBody(target, bot.entity.position)
  ) {
    return null;
  }
  // The goal is the whole reach, not a tighter ring: a target four blocks up a
  // wall is reachable from the floor beneath it, and asking for closer left
  // only cells inside the wall, which the route then planned to dig.
  const reach = nearGoal({ x: target.x, y: target.y, z: target.z }, PLACEMENT_REACH);
  const goal: Goal = {
    resolve(observation) {
      const resolved = reach.resolve(observation);
      if (resolved.kind !== "active") return resolved;
      const currentCell = cellKey(navigationFeet(observation.position, observation.stance === "supported"));
      const obstructed = cellIntersectsPlayerBody(target, observation.position);
      return {
        ...resolved,
        revision: `placement-clear:${resolved.revision}:${obstructed ? currentCell : "clear"}`,
        isSatisfied: (node, world) => {
          // Future stances are planned at their centres. At the actual cell,
          // require the observed body to clear the target: entering the adjacent
          // cell can still leave the player's shoulder inside the doorway.
          const position =
            cellKey(node.feet) === currentCell
              ? observation.position
              : {
                  x: node.feet.x + 0.5,
                  y: node.feet.y,
                  z: node.feet.z + 0.5,
                };
          return resolved.isSatisfied(node, world) && !cellIntersectsPlayerBody(target, position);
        },
      };
    },
  };
  return dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal,
    signal: context.signal,
  });
}

/** What one place_block request keeps across the attempts a reflex cuts it into. */
interface PlaceRun {
  readonly bot: Bot;
  readonly request: PlaceBlockRequest;
  readonly dependencies: PlaceBlockDependencies;
  /** The count of the block carried when the request was taken: a resume that finds fewer knows a block was put down. */
  readonly inventoryBefore: number;
  /** What the target cell held before this request put anything there, for the evidence of a resumed attempt. */
  beforeBlock: string | null;
  /** The cell a block put down beside the bot went to, once an attempt has seen it (the progress checkpoint reads it too). */
  chosen: Vec3 | null;
  /** Where the bot stood when the first nearby placement began, and the cells around it that already held the block. */
  nearby: { readonly origin: Vec3; readonly alreadyHolding: ReadonlySet<string> } | null;
}

/** How far around the first nearby placement's origin a block it put down is looked for after an abort. */
const NEARBY_SEARCH_RADIUS = 5;

const cellId = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;

/** The cells around `origin` (feet level, one down and one up) that hold `blockName` now. */
function cellsHolding(bot: Bot, blockName: string, origin: Vec3): Vec3[] {
  const found: Vec3[] = [];
  for (let dx = -NEARBY_SEARCH_RADIUS; dx <= NEARBY_SEARCH_RADIUS; dx += 1)
    for (let dz = -NEARBY_SEARCH_RADIUS; dz <= NEARBY_SEARCH_RADIUS; dz += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = origin.offset(dx, dy, dz);
        if (bot.blockAt(cell)?.name === blockName) found.push(cell);
      }
  return found;
}

function supportBelow(bot: Bot, cell: Vec3): { block: WorldBlock; face: Vec3 } | undefined {
  const block = bot.blockAt(cell.offset(0, -1, 0));
  return block ? { block, face: new Vec3(0, 1, 0) } : undefined;
}

/**
 * The block an earlier, aborted attempt put down beside the bot, as a success: the carried count fell from the baseline
 * and a cell that did not hold the block before now does. Null when no earlier attempt put one down.
 */
async function nearbyBlockAlreadyPlaced(run: PlaceRun, context: ActionContext): Promise<PlaceBlockResult | null> {
  const { bot, request, inventoryBefore, nearby } = run;
  if (nearby === null || carriedCount(bot, request.blockName) >= inventoryBefore) return null;
  const cell = run.chosen ?? cellsHolding(bot, request.blockName, nearby.origin)
    .filter((candidate) => !nearby.alreadyHolding.has(cellId(candidate)))
    .sort((a, b) => a.distanceTo(nearby.origin) - b.distanceTo(nearby.origin))[0] ?? null;
  if (cell === null) {
    return {
      status: "failed",
      error: placeBlockOutcomes.failed("An earlier attempt used a block, but no placed block was found beside the bot."),
      placement: evidence(bot, request, bot.entity.position.floored(), inventoryBefore, null),
    };
  }
  run.chosen = cell;
  return {
    status: "succeeded",
    placement: evidence(bot, request, cell, inventoryBefore, "air", supportBelow(bot, cell), true,
      await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal })),
  };
}

/** Put one carried block on a cell chosen around the bot, without moving. */
async function placeNearby(run: PlaceRun, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore, dependencies } = run;
  const placedBefore = await nearbyBlockAlreadyPlaced(run, context);
  if (placedBefore !== null) return placedBefore;
  const feet = bot.entity.position.floored();
  run.nearby ??= { origin: feet, alreadyHolding: new Set(cellsHolding(bot, request.blockName, feet).map(cellId)) };
  const result = await dependencies.placeNearby(bot, request.blockName, { signal: context.signal });
  switch (result.kind) {
    case "placed":
      run.chosen = result.position;
      return {
        status: "succeeded",
        placement: evidence(
          bot,
          request,
          result.position,
          inventoryBefore,
          "air",
          { block: bot.blockAt(result.position.offset(0, -1, 0)) ?? result.block, face: new Vec3(0, 1, 0) },
          true,
          // The block update resolved the placement; the slot that loses the
          // block is broadcast after it.
          await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal }),
        ),
      };
    case "failed":
      return {
        status: "failed",
        error: placeBlockOutcomes.failed(result.error),
        placement: evidence(bot, request, result.position, inventoryBefore, "air"),
      };
    case "no_item":
      return {
        status: "failed",
        error: placeBlockOutcomes.noItem(request.blockName, 0),
        placement: evidence(bot, request, feet, inventoryBefore, null),
      };
    case "no_cell":
      return {
        status: "failed",
        error: placeBlockOutcomesNearby.noFreeCell,
        placement: evidence(bot, request, feet, inventoryBefore, null),
      };
  }
}

/** Walk within reach of the target, or the failure that says why not; null when the bot may place from where it stands. */
async function reachTarget(run: PlaceRun, target: Vec3, context: ActionContext): Promise<PlaceBlockResult | null> {
  const { bot, request, inventoryBefore, dependencies } = run;
  const stopped = (error: string): PlaceBlockResult => ({
    status: "failed",
    error,
    placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
  });
  let route: NavigationResult | null;
  try {
    route = await approachTarget(bot, target, context, dependencies);
  } catch (cause) {
    context.signal?.throwIfAborted();
    return stopped(placeBlockOutcomes.routeStopped(cause instanceof Error ? cause.message : String(cause)));
  }
  if (route?.status === "stopped") return stopped(placeBlockOutcomes.routeStopped(route.reason));
  if (cellIntersectsPlayerBody(target, bot.entity.position)) {
    return stopped(placeBlockOutcomes.failed("The bot's body still intersects the requested cell after approaching it."));
  }
  return null;
}

/** The target already holds the requested block: ours when an earlier attempt took one from the inventory, else it was there. */
async function targetAlreadyHoldsBlock(run: PlaceRun, target: Vec3, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore } = run;
  if (carriedCount(bot, request.blockName) >= inventoryBefore) {
    return { status: "succeeded", placement: evidence(bot, request, target, inventoryBefore, request.blockName) };
  }
  return {
    status: "succeeded",
    placement: evidence(bot, request, target, inventoryBefore, run.beforeBlock ?? "air", supportBelow(bot, target), true,
      await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal })),
  };
}

/** Place one carried block at the exact cell asked for. */
async function placeAtTarget(run: PlaceRun, target: Vec3, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore, dependencies } = run;
  if (inventoryBefore < 1) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noItem(request.blockName, inventoryBefore),
      placement: evidence(bot, request, target, inventoryBefore, bot.blockAt(target)?.name ?? null),
    };
  }
  const unreached = await reachTarget(run, target, context);
  if (unreached !== null) return unreached;

  const targetBlock = bot.blockAt(target);
  if (!targetBlock) {
    return {
      status: "failed",
      error: placeBlockOutcomes.targetUnloaded,
      placement: evidence(bot, request, target, inventoryBefore, null),
    };
  }
  if (targetBlock.name === request.blockName) return targetAlreadyHoldsBlock(run, target, context);
  run.beforeBlock ??= targetBlock.name;
  if (!isReplaceableForPlacement(targetBlock)) {
    return {
      status: "failed",
      error: placeBlockOutcomes.targetOccupied(targetBlock.name),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name),
    };
  }

  const support = findSupport(bot, target);
  if (!support) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noSupport,
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name),
    };
  }

  const item = bot.inventory.items().find((candidate) => candidate.name === request.blockName);
  if (!item) {
    return {
      status: "failed",
      error: placeBlockOutcomes.noItem(request.blockName, 0),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name, support),
    };
  }

  const result = await dependencies.placeBlock(bot, {
    item,
    support: support.block,
    face: support.face,
    expectedCells: [target],
    matches: (block) => block.name === request.blockName,
    signal: context.signal,
  });
  if (result.kind === "failed") {
    return {
      status: "failed",
      error: placeBlockOutcomes.failed(result.error),
      placement: evidence(bot, request, target, inventoryBefore, targetBlock.name, support),
    };
  }

  return {
    status: "succeeded",
    placement: evidence(
      bot,
      request,
      target,
      inventoryBefore,
      targetBlock.name,
      support,
      true,
      await settleInventoryCount(bot, request.blockName, inventoryBefore - 1, { signal: context.signal }),
    ),
  };
}

/** One attempt: do only what the world still needs of the request. */
async function placeAttempt(run: PlaceRun, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore } = run;
  if (!bot.registry.blocksByName[request.blockName]) {
    return {
      status: "failed",
      error: placeBlockOutcomes.unknownBlock(request.blockName),
      placement: evidence(bot, request, bot.entity.position.floored(), inventoryBefore, null),
    };
  }
  if (request.target === null) return placeNearby(run, context);
  return placeAtTarget(run, new Vec3(request.target.x, request.target.y, request.target.z), context);
}

/**
 * Take the request: the carried count (the baseline a resume measures what it put down against) and the cell chosen
 * beside the bot are kept here, and the executor it returns runs one attempt each time the runner calls it.
 */
export function beginPlaceBlock(
  bot: Bot,
  request: PlaceBlockRequest,
  dependencies: PlaceBlockDependencies,
  observe: ObserveRequest = () => {},
): RequestExecution<PlaceBlockResult> {
  const run: PlaceRun = {
    bot, request, dependencies, beforeBlock: null, chosen: null, nearby: null,
    inventoryBefore: carriedCount(bot, request.blockName),
  };
  const progressTarget = () => run.chosen ?? request.target;
  const blockAtProgressTarget = () => {
    const target = progressTarget();
    return target ? bot.blockAt(new Vec3(target.x, target.y, target.z))?.name ?? null : null;
  };
  observe(() => ({ baseline: { inventory: run.inventoryBefore },
    checkpoint: { phase: "placing", inventory: carriedCount(bot, request.blockName), target: progressTarget() ? { ...progressTarget()! } : null,
      currentBlock: blockAtProgressTarget() },
    completion: { kind: "current", observed: progressTarget() !== null && blockAtProgressTarget() === request.blockName,
      owes: "Observed placement of the requested block in the selected cell." },
  }));
  return (context) => placeAttempt(run, context);
}

/** Place one carried block, at the exact cell asked for or on a cell chosen nearby, and report only what was observed. */
export function executePlaceBlock(
  bot: Bot,
  request: PlaceBlockRequest,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
): Promise<PlaceBlockResult> {
  return beginPlaceBlock(bot, request, dependencies, context.observeProgress)(context);
}

export function formatPlaceBlockResult(result: PlaceBlockResult): string {
  const { placement } = result;
  const summary = placement.placed
    ? `Placed **${placement.requestedBlock}** at the requested cell.`
    : placement.afterBlock === placement.requestedBlock
      ? `The requested **${placement.requestedBlock}** was already present.`
      : `Did not place **${placement.requestedBlock}**.`;
  const lines = [
    summary,
    `- Target: \`${placement.target.x}, ${placement.target.y}, ${placement.target.z}\` in \`${placement.dimension}\``,
    `- Before: \`${placement.beforeBlock ?? "unloaded"}\``,
    `- After: \`${placement.afterBlock ?? "unloaded"}\``,
    `- Inventory: ${placement.inventoryBefore} → ${placement.inventoryAfter}${unconfirmedCount(placement.confirmed)}`,
  ];
  if (placement.support && placement.face) {
    lines.push(
      `- Support: \`${placement.support.x}, ${placement.support.y}, ${placement.support.z}\`; face \`${placement.face.x}, ${placement.face.y}, ${placement.face.z}\``,
    );
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createPlaceBlockAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: PlaceBlockDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: placeCheckpointSchema,
    name: PLACE_BLOCK,
    description: PLACE_BLOCK_DESCRIPTION,
    inputSchema: placeBlockInputSchema,
    resultSchema: placeBlockResultSchema,
    formatResult: formatPlaceBlockResult,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: placeBlockAnnotations,
    parse: parsePlaceBlockRequest,
    begin: (request, _lifetime, observe) => beginPlaceBlock(bot, request, dependencies, observe),
  });
}
