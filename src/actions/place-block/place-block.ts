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
import { recordPlacedContainer, type SqlBotData } from "../../bot-data/index.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { cellIntersectsPlayerBody, cellKey } from "../../utils/index.js";
import {
  awaitOwnPlacement,
  carriedCount,
  forgetPlacement,
  isReplaceableForPlacement,
  placeBlock,
  placeCarriedBlockNearby,
  recordPlacementSent,
  settledNow,
  settleInventoryCount,
  startOwnPlacement,
  type BlockPlacementResult,
  type InventoryItem,
  type OwnPlacement,
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
  /** The count of the block carried when the request was taken: the evidence's baseline, and what the settle expects to fall by one. */
  readonly inventoryBefore: number;
  /** What the placed cell held before this request put anything there, for the evidence of a resumed attempt. */
  beforeBlock: string | null;
  /** The cell this request's placement went to (the progress checkpoint reads it too). */
  chosen: Vec3 | null;
  /** The cells this request's own placement packet went to: the only block a resume may call its own. */
  readonly own: OwnPlacement;
}

function supportBelow(bot: Bot, cell: Vec3): { block: WorldBlock; face: Vec3 } | undefined {
  const block = bot.blockAt(cell.offset(0, -1, 0));
  return block ? { block, face: new Vec3(0, 1, 0) } : undefined;
}

/** Heard right before each placement packet: record the cells, what they held and where the block is going. */
function recordSent(run: PlaceRun): (cells: readonly Vec3[]) => void {
  return (cells) => {
    recordPlacementSent(run.own, cells, run.bot.time?.age);
    run.beforeBlock ??= run.bot.blockAt(cells[0]!)?.name ?? null;
    run.chosen = cells[0]!.clone();
  };
}

/** The carried count settled to one fewer, counting the server's answer from the moment the packet went out. */
function settledAfterSend(run: PlaceRun, context: ActionContext): Promise<SettledInventoryCount> {
  return settleInventoryCount(run.bot, run.request.blockName, run.inventoryBefore - 1, {
    ...(context.signal && { signal: context.signal }),
    ...(run.own.sentAtAge !== undefined && { sentAtAge: run.own.sentAtAge }),
  });
}

/**
 * What an earlier attempt's placement packet became, as the server answered it: the block it put down is a success of
 * this request, a cell out of loaded chunks is a failure that says where to go, and a packet that never landed is
 * forgotten so this attempt places again. Null when nothing is left to credit. A block that is in the world without
 * our packet having gone to its cell (a reflex's, another player's) is never credited.
 */
async function earlierPlacement(run: PlaceRun, context: ActionContext): Promise<PlaceBlockResult | null> {
  const { bot, request, inventoryBefore } = run;
  const seen = await awaitOwnPlacement(bot, run.own, (block) => block.name === request.blockName, context.signal);
  switch (seen.kind) {
    case "none":
      return null;
    case "not_landed":
      forgetPlacement(run.own);
      return null;
    case "unloaded":
      return failedPlacement(run, placeBlockOutcomes.placementNotLoaded(seen.cell), seen.cell, null);
    case "landed":
      run.chosen = seen.cell.clone();
      return {
        status: "succeeded",
        placement: evidence(bot, request, seen.cell, inventoryBefore, run.beforeBlock, supportBelow(bot, seen.cell), true,
          await settledAfterSend(run, context)),
      };
  }
}

/** Put one carried block on a cell chosen around the bot, without moving. */
async function placeNearby(run: PlaceRun, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore, dependencies } = run;
  const earlier = await earlierPlacement(run, context);
  if (earlier !== null) return earlier;
  const feet = bot.entity.position.floored();
  const result = await dependencies.placeNearby(bot, request.blockName, { signal: context.signal, onPlacementSent: recordSent(run) });
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
          run.beforeBlock,
          { block: bot.blockAt(result.position.offset(0, -1, 0)) ?? result.block, face: new Vec3(0, 1, 0) },
          true,
          // The block update resolved the placement; the slot that loses the
          // block is broadcast after it.
          await settledAfterSend(run, context),
        ),
      };
    case "failed":
      return failedPlacement(run, placeBlockOutcomes.failed(result.error), result.position, bot.blockAt(result.position)?.name ?? null);
    case "no_item":
      return failedPlacement(run, placeBlockOutcomes.noItem(request.blockName, 0), feet, null);
    case "no_cell":
      return failedPlacement(run, placeBlockOutcomesNearby.noFreeCell, feet, null);
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

/** The target holds the requested block and no placement of ours put it there: it was already present. */
function targetAlreadyHoldsBlock(run: PlaceRun, target: Vec3): PlaceBlockResult {
  return { status: "succeeded", placement: evidence(run.bot, run.request, target, run.inventoryBefore, run.request.blockName) };
}

/** A failed attempt: the text the model reads and the evidence of the cell it was about. */
function failedPlacement(
  run: PlaceRun,
  error: string,
  cell: Vec3,
  beforeBlock: string | null,
  support?: { block: WorldBlock; face: Vec3 },
): PlaceBlockResult {
  return { status: "failed", error, placement: evidence(run.bot, run.request, cell, run.inventoryBefore, beforeBlock, support) };
}

/** What placing at the target needs once the bot is in reach: the cell, a face to place against, and the carried item. */
interface TargetPlan {
  readonly targetBlock: WorldBlock;
  readonly support: { block: WorldBlock; face: Vec3 };
  readonly item: InventoryItem;
}

/** The target's plan, or the failure that says what is missing; a target already holding the block is answered here. */
function planTarget(run: PlaceRun, target: Vec3): TargetPlan | PlaceBlockResult {
  const { bot, request } = run;
  const targetBlock = bot.blockAt(target);
  if (!targetBlock) return failedPlacement(run, placeBlockOutcomes.targetUnloaded, target, null);
  if (targetBlock.name === request.blockName) return targetAlreadyHoldsBlock(run, target);
  run.beforeBlock ??= targetBlock.name;
  if (!isReplaceableForPlacement(targetBlock, bot.version)) {
    return failedPlacement(run, placeBlockOutcomes.targetOccupied(targetBlock.name), target, targetBlock.name);
  }
  const support = findSupport(bot, target);
  if (!support) return failedPlacement(run, placeBlockOutcomes.noSupport, target, targetBlock.name);
  const item = bot.inventory.items().find((candidate) => candidate.name === request.blockName);
  if (!item) return failedPlacement(run, placeBlockOutcomes.noItem(request.blockName, 0), target, targetBlock.name, support);
  return { targetBlock, support, item };
}

/** Place one carried block at the exact cell asked for. */
async function placeAtTarget(run: PlaceRun, target: Vec3, context: ActionContext): Promise<PlaceBlockResult> {
  const { bot, request, inventoryBefore, dependencies } = run;
  if (inventoryBefore < 1) {
    return failedPlacement(run, placeBlockOutcomes.noItem(request.blockName, inventoryBefore), target, bot.blockAt(target)?.name ?? null);
  }
  const unreached = await reachTarget(run, target, context);
  if (unreached !== null) return unreached;
  const earlier = await earlierPlacement(run, context);
  if (earlier !== null) return earlier;
  const plan = planTarget(run, target);
  if (!("targetBlock" in plan)) return plan;
  const { targetBlock, support, item } = plan;

  const result = await dependencies.placeBlock(bot, {
    item,
    support: support.block,
    face: support.face,
    expectedCells: [target],
    matches: (block) => block.name === request.blockName,
    signal: context.signal,
    onSent: () => recordSent(run)([target]),
  });
  if (result.kind === "failed") {
    return failedPlacement(run, placeBlockOutcomes.failed(result.error), target, targetBlock.name, support);
  }
  return {
    status: "succeeded",
    placement: evidence(bot, request, target, inventoryBefore, targetBlock.name, support, true, await settledAfterSend(run, context)),
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

/** A container this request's own packet put down is remembered as the bot's; one already there, or a refusal, is not. */
function recordPlacedContainerOf(botData: SqlBotData, bot: Bot, result: PlaceBlockResult): void {
  if (result.status !== "succeeded" || !result.placement.placed || result.placement.afterBlock === null) return;
  recordPlacedContainer(botData, bot, { name: result.placement.afterBlock, position: result.placement.target });
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
  botData?: SqlBotData,
): RequestExecution<PlaceBlockResult> {
  const run: PlaceRun = {
    bot, request, dependencies, beforeBlock: null, chosen: null, own: startOwnPlacement(),
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
  return async (context) => {
    const result = await placeAttempt(run, context);
    if (botData) recordPlacedContainerOf(botData, bot, result);
    return result;
  };
}

/** Place one carried block, at the exact cell asked for or on a cell chosen nearby, and report only what was observed. */
export function executePlaceBlock(
  bot: Bot,
  request: PlaceBlockRequest,
  context: ActionContext,
  dependencies: PlaceBlockDependencies,
  botData?: SqlBotData,
): Promise<PlaceBlockResult> {
  return beginPlaceBlock(bot, request, dependencies, context.observeProgress, botData)(context);
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
  botData: SqlBotData,
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
    begin: (request, _lifetime, observe) => beginPlaceBlock(bot, request, dependencies, observe, botData),
  });
}
