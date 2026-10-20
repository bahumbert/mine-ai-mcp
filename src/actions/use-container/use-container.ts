import { containerCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import type { SqlBotData } from "../../bot-data/index.js";
import { forgetContainerObservation, recordContainerObservation, type ContainerContent } from "../../bot-data/index.js";
import { createMovements, nearGoal, type Navigate, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { asVec3 } from "../../utils/index.js";
import { chestOpeningObstruction } from "../../world/chest-clearance.js";
import { isLocationOwnedContainer } from "../../world/containers.js";
import type { ObserveRequest } from "../../session/request.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import {
  OpenedContainer,
  UseContainerActionError,
  type ContainerBlock,
  type ContainerLayoutAttempt,
  type ContainerOperationAttempt,
} from "./opened-container.js";
import {
  parseUseContainerRequest,
  USE_CONTAINER,
  USE_CONTAINER_DESCRIPTION,
  useContainerInputSchema,
  useContainerResultSchema,
  useContainerAnnotations,
  useContainerOutcomes,
  type ContainerTarget,
  type ContainerTransferResult,
  type ContainerUseEvidence,
  type RequestedContainerItem,
  type UseContainerRequest,
  type UseContainerResult,
} from "./contract.js";

const CONTAINER_REACH = 4.5;

interface TransferExecution extends RequestedContainerItem {
  readonly available: number;
  readonly attempt: ContainerOperationAttempt | { readonly kind: "not_attempted" };
}

interface TransferBatchExecution {
  readonly items: readonly TransferExecution[];
  readonly compaction: ContainerLayoutAttempt | { readonly kind: "not_attempted" };
}

type InspectRequest = Extract<UseContainerRequest, { readonly operation: "inspect" }>;
type TransferRequest = Extract<UseContainerRequest, { readonly operation: "deposit" | "withdraw" }>;
type OrganizeRequest = Extract<UseContainerRequest, { readonly operation: "organize" }>;
type InspectTarget = Extract<ContainerTarget, { readonly operation: "inspect" }>;
type TransferTarget = Extract<ContainerTarget, { readonly operation: "deposit" | "withdraw" }>;
type OrganizeTarget = Extract<ContainerTarget, { readonly operation: "organize" }>;

export interface UseContainerDependencies {
  readonly navigate: Navigate;
  readonly createMovements: typeof createMovements;
  readonly now: () => Date;
}

function productionDependencies(navigate: Navigate): UseContainerDependencies {
  return { navigate, createMovements, now: () => new Date() };
}

function target(bot: Bot, request: InspectRequest): InspectTarget;
function target(bot: Bot, request: TransferRequest): TransferTarget;
function target(bot: Bot, request: OrganizeRequest): OrganizeTarget;
function target(bot: Bot, request: UseContainerRequest): ContainerTarget;
function target(bot: Bot, request: UseContainerRequest): ContainerTarget {
  const position = {
    dimension: bot.game.dimension,
    x: request.x,
    y: request.y,
    z: request.z,
  };
  if (request.operation === "inspect") return { ...position, operation: "inspect" };
  if (request.operation === "organize") {
    return {
      ...position,
      operation: "organize",
      itemOrder: [...request.itemOrder],
    };
  }
  return {
    ...position,
    operation: request.operation,
    items: request.items.map(({ itemName: item, count: requested }) => ({ item, requested })),
  };
}

function requestedItemNames(request: UseContainerRequest): readonly string[] {
  if (request.operation === "inspect") return [];
  if (request.operation === "organize") return request.itemOrder;
  return request.items.map(({ itemName }) => itemName);
}

function resolveItemTypes(bot: Bot, request: UseContainerRequest): ReadonlyMap<string, number> {
  const itemTypes = new Map<string, number>();
  const unknown: string[] = [];
  for (const itemName of requestedItemNames(request)) {
    const registryItem = bot.registry.itemsByName[itemName];
    if (registryItem) itemTypes.set(itemName, registryItem.id);
    else unknown.push(itemName);
  }
  if (unknown.length > 0) throw new UseContainerActionError(useContainerOutcomes.unknownItems(unknown));
  return itemTypes;
}

function itemCount(contents: readonly ContainerContent[], itemName: string): number {
  return contents.filter(({ item }) => item === itemName).reduce((total, { count }) => total + count, 0);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

/** What one container request keeps across the attempts a reflex splits it into. */
interface ContainerProgress {
  /** Carried counts of the requested items when the request began: what moved since is the difference. */
  readonly carriedBefore: ReadonlyMap<string, number>;
  /** What the container held when the request first opened it (null until then): the chest's own share of the change. */
  contentsAtFirstOpening: readonly ContainerContent[] | null;
}

type ContainerObservation = Pick<ContainerUseEvidence, "blockName" | "slotCount" | "contents" | "observedAt">;

function carriedOf(bot: Bot, itemName: string): number {
  const registryItem = bot.registry.itemsByName[itemName];
  return registryItem ? bot.inventory.count(registryItem.id, null) : 0;
}

/**
 * How much of each requested item earlier attempts already moved: the smaller of what the inventory changed and what
 * the container changed since the request first opened it. Eaten food (inventory down, chest unchanged) and picked-up
 * items (inventory up, chest unchanged) credit nothing; another bot using the chest at the same time is capped by the
 * inventory change (review 2026-10-19). Two entries naming one item share the moved amount in order.
 */
function movedByEarlierAttempts(
  bot: Bot,
  progress: ContainerProgress,
  operation: "deposit" | "withdraw",
  items: readonly RequestedContainerItem[],
  containerNow: readonly ContainerContent[],
): number[] {
  const credited = new Map<string, number>();
  const containerAtFirstOpening = progress.contentsAtFirstOpening ?? containerNow;
  return items.map(({ itemName, count }) => {
    const inventoryChange = carriedOf(bot, itemName) - (progress.carriedBefore.get(itemName) ?? 0);
    const containerChange = itemCount(containerNow, itemName) - itemCount(containerAtFirstOpening, itemName);
    const moved =
      operation === "deposit" ? Math.min(-inventoryChange, containerChange) : Math.min(inventoryChange, -containerChange);
    const mine = Math.min(count, Math.max(0, moved - (credited.get(itemName) ?? 0)));
    credited.set(itemName, (credited.get(itemName) ?? 0) + mine);
    return mine;
  });
}

async function executeTransferBatch(
  bot: Bot,
  container: OpenedContainer,
  operation: "deposit" | "withdraw",
  items: readonly RequestedContainerItem[],
  itemTypes: ReadonlyMap<string, number>,
  before: readonly ContainerContent[],
  alreadyMoved: readonly number[],
  signal?: AbortSignal,
): Promise<TransferBatchExecution> {
  const executions: TransferExecution[] = [];
  for (const [index, item] of items.entries()) {
    if (signal?.aborted) break;
    const itemType = itemTypes.get(item.itemName)!;
    const available = operation === "deposit" ? bot.inventory.count(itemType, null) : itemCount(before, item.itemName);
    const attempted = Math.min(available, item.count - alreadyMoved[index]!);
    const attempt =
      attempted <= 0 ? { kind: "not_attempted" as const } : await container.transfer(operation, itemType, attempted);
    executions.push({ ...item, available, attempt });
  }
  return {
    items: executions,
    compaction: operation === "withdraw" ? await container.compact(signal) : { kind: "not_attempted" },
  };
}

/** What each item moved in all: earlier attempts' share (from the inventory) plus what this attempt's window shows. */
function settleTransfers(
  operation: "deposit" | "withdraw",
  executions: readonly TransferExecution[],
  before: readonly ContainerContent[],
  after: readonly ContainerContent[],
  alreadyMoved: readonly number[],
): ContainerTransferResult[] {
  return executions.map((execution, index) => {
    const beforeCount = itemCount(before, execution.itemName);
    const afterCount = itemCount(after, execution.itemName);
    const thisAttempt = Math.max(0, operation === "deposit" ? afterCount - beforeCount : beforeCount - afterCount);
    const transferred = alreadyMoved[index]! + thisAttempt;
    const item = execution.itemName;
    const requested = execution.count;
    if (transferred === requested) return { status: "succeeded", item, requested, transferred };

    const error =
      execution.attempt.kind === "failed"
        ? useContainerOutcomes.transferFailed(operation, execution.attempt.cause)
        : execution.available < requested
          ? useContainerOutcomes.unavailable(operation, item, execution.available, requested)
          : useContainerOutcomes.transferIncomplete(operation, transferred, requested);
    return transferred > 0
      ? { status: "partial", item, requested, transferred, error }
      : { status: "failed", item, requested, transferred: 0, error };
  });
}

/** Move the container into interaction reach: pathfinder status is not enough, the distance is what counts. */
async function reachContainer(
  bot: Bot,
  position: ReturnType<typeof asVec3>,
  context: ActionContext,
  dependencies: UseContainerDependencies,
): Promise<void> {
  if (bot.entity.position.distanceTo(position) <= CONTAINER_REACH) return;
  const route = await dependencies
    .navigate({
      movements: dependencies.createMovements(bot),
      goal: nearGoal(position, 2),
      signal: context.signal,
    })
    .catch((cause: unknown) => {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new UseContainerActionError(useContainerOutcomes.routeStopped(reason), { cause });
    });
  if (bot.entity.position.distanceTo(position) > CONTAINER_REACH) {
    throw new UseContainerActionError(useContainerOutcomes.routeStopped(describeNavigation(route)));
  }
}

/** Read the open container, memorize it, and return what was seen. */
function observeContainer(
  bot: Bot,
  data: SqlBotData,
  container: OpenedContainer,
  block: ContainerBlock,
  dependencies: UseContainerDependencies,
): ContainerObservation {
  const contents = container.contents();
  const observedAt = dependencies.now().toISOString();
  recordContainerObservation(data, {
    dimension: bot.game.dimension,
    x: block.position.x,
    y: block.position.y,
    z: block.position.z,
    blockName: block.name,
    slotCount: container.slotCount,
    contents,
    observedByBotId: bot.username,
    observedAt,
  });
  return { blockName: block.name, slotCount: container.slotCount, contents, observedAt };
}

/** Deposit or withdraw what earlier attempts have not moved yet, and judge the whole request by what moved in all. */
async function transferResult(
  bot: Bot,
  container: OpenedContainer,
  request: TransferRequest,
  progress: ContainerProgress,
  itemTypes: ReadonlyMap<string, number>,
  before: ContainerObservation,
  observeAgain: () => ContainerObservation,
  context: ActionContext,
): Promise<UseContainerResult> {
  const transferTarget = target(bot, request);
  progress.contentsAtFirstOpening ??= before.contents;
  const alreadyMoved = movedByEarlierAttempts(bot, progress, request.operation, request.items, before.contents);
  const execution = await executeTransferBatch(
    bot,
    container,
    request.operation,
    request.items,
    itemTypes,
    before.contents,
    alreadyMoved,
    context.signal,
  );
  const after = observeAgain();
  context.signal?.throwIfAborted();

  const transfers = settleTransfers(request.operation, execution.items, before.contents, after.contents, alreadyMoved);
  const containerEvidence: ContainerUseEvidence = {
    ...transferTarget,
    ...after,
    transfers,
  };
  if (transfers.every(({ status }) => status === "succeeded") && execution.compaction.kind !== "failed") {
    return { status: "succeeded", container: containerEvidence };
  }
  const error =
    execution.compaction.kind === "failed"
      ? useContainerOutcomes.compactionFailed(execution.compaction.cause)
      : useContainerOutcomes.batchIncomplete(transfers);
  return transfers.some(({ transferred }) => transferred > 0)
    ? { status: "partial", error, container: containerEvidence }
    : { status: "failed", error, target: transferTarget, container: containerEvidence };
}

/** Lay the container out in the requested order; the plan is made again from what the container holds now. */
async function organizeResult(
  bot: Bot,
  container: OpenedContainer,
  request: OrganizeRequest,
  observeAgain: () => ContainerObservation,
  context: ActionContext,
): Promise<UseContainerResult> {
  const organizeTarget = target(bot, request);
  const observedItemNames = container.observedItemNames();
  if (!sameStringSet(observedItemNames, request.itemOrder)) {
    return {
      status: "failed",
      error: useContainerOutcomes.itemOrderMismatch(observedItemNames, request.itemOrder),
      target: organizeTarget,
    };
  }

  const plan = container.planOrganization(request.itemOrder);
  const organization = await container.organize(plan, context.signal);
  const after = observeAgain();
  context.signal?.throwIfAborted();
  const containerEvidence: ContainerUseEvidence = {
    ...organizeTarget,
    ...after,
    plannedContents: [...plan.contents],
    matchedSlots: organization.matchedSlots,
    contentsPreserved: organization.contentsPreserved,
    playerInventoryPreserved: organization.playerInventoryPreserved,
    cursorEmpty: organization.cursorEmpty,
  };
  if (
    organization.execution.kind === "completed" &&
    organization.matchedSlots === plan.stacks.length &&
    after.contents.length === plan.stacks.length &&
    organization.contentsPreserved &&
    organization.playerInventoryPreserved &&
    organization.cursorEmpty
  ) {
    return { status: "succeeded", container: containerEvidence };
  }

  const error =
    organization.execution.kind === "failed"
      ? useContainerOutcomes.organizeFailed(organization.execution.cause)
      : useContainerOutcomes.organizeIncomplete(
          organization.matchedSlots,
          plan.stacks.length,
          organization.contentsPreserved,
          organization.playerInventoryPreserved,
          organization.cursorEmpty,
        );
  return organization.execution.movedStacks > 0
    ? { status: "partial", error, container: containerEvidence }
    : { status: "failed", error, target: organizeTarget, container: containerEvidence };
}

/** One attempt: reach and open the exact container, then do the operation's share of the request still owed. */
async function attemptContainerUse(
  bot: Bot,
  data: SqlBotData,
  request: UseContainerRequest,
  progress: ContainerProgress,
  context: ActionContext,
  dependencies: UseContainerDependencies,
): Promise<UseContainerResult> {
  context.signal?.throwIfAborted();
  const targetValue = target(bot, request);
  try {
    const itemTypes = resolveItemTypes(bot, request);
    const position = asVec3(request);
    await reachContainer(bot, position, context, dependencies);

    const block = bot.blockAt(position);
    if (!block) return { status: "failed", error: useContainerOutcomes.blockUnloaded, target: targetValue };
    if (!isLocationOwnedContainer(block.name)) {
      forgetContainerObservation(data, targetValue);
      return {
        status: "failed",
        error: useContainerOutcomes.unsupportedBlock(block.name),
        target: targetValue,
      };
    }

    const obstruction = chestOpeningObstruction(bot, block.name, position);
    if (obstruction) return { status: "failed", error: obstruction, target: targetValue };
    using container = await OpenedContainer.open(bot, block);
    const observeAgain = () => observeContainer(bot, data, container, block, dependencies);
    const before = observeAgain();
    context.signal?.throwIfAborted();

    if (request.operation === "inspect") {
      return { status: "succeeded", container: { ...target(bot, request), ...before } };
    }
    if (request.operation === "organize") return await organizeResult(bot, container, request, observeAgain, context);
    return await transferResult(bot, container, request, progress, itemTypes, before, observeAgain, context);
  } catch (cause) {
    context.signal?.throwIfAborted();
    if (cause instanceof UseContainerActionError) {
      return { status: "failed", error: cause.message, target: targetValue };
    }
    throw cause;
  }
}

function inventoryCounts(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}

/**
 * One request's executor: the carried counts at `begin` live across attempts, so an attempt after a reflex moves only
 * what is still owed and the result covers the whole request.
 */
export function beginUseContainer(
  bot: Bot,
  data: SqlBotData,
  request: UseContainerRequest,
  observe: ObserveRequest | undefined,
  dependencies: UseContainerDependencies,
): RequestExecution<UseContainerResult> {
  const progress: ContainerProgress = {
    carriedBefore: new Map(requestedItemNames(request).map((itemName) => [itemName, carriedOf(bot, itemName)])),
    contentsAtFirstOpening: null,
  };
  const inventoryBefore = observe ? inventoryCounts(bot) : null;
  observe?.(() => ({ baseline: { inventory: inventoryBefore },
    checkpoint: { phase: request.operation, inventory: inventoryCounts(bot), windowOpen: bot.currentWindow != null,
      requested: request.operation === "deposit" || request.operation === "withdraw" ? request.items.map((item) => ({ ...item })) : [] },
    completion: { kind: "event", observed: false, owes: "Container observation or requested transfer/layout operations confirmed before closing the window." },
  }));
  return (context) => attemptContainerUse(bot, data, request, progress, context, dependencies);
}

/** Open one exact container, execute one requested container transaction, and retain its observed slot layout. */
export function useContainer(
  bot: Bot,
  data: SqlBotData,
  request: UseContainerRequest,
  context: ActionContext,
  dependencies: UseContainerDependencies,
): Promise<UseContainerResult> {
  return beginUseContainer(bot, data, request, context.observeProgress, dependencies)(context);
}

export function formatUseContainerResult(result: UseContainerResult): string {
  switch (result.status) {
    case "succeeded":
      return formatContainerEvidence(result.container);
    case "partial":
      return formatContainerEvidence(result.container, result.error);
    case "failed":
      return result.container
        ? formatContainerEvidence(result.container, result.error)
        : `**Observed stop:** ${result.error}`;
  }
}

function formatContainerEvidence(container: ContainerUseEvidence, error?: string): string {
  const lines = [
    `Opened **${container.blockName}** at \`${container.x}, ${container.y}, ${container.z}\` in \`${container.dimension}\`.`,
    `- Operation: ${container.operation}`,
    `- Storage slots: ${container.slotCount}`,
  ];
  if (container.operation === "deposit" || container.operation === "withdraw") {
    lines.push(
      ...container.transfers.map(
        (transfer) =>
          `- ${transfer.item}: ${transfer.transferred}/${transfer.requested} (${transfer.status})` +
          ("error" in transfer ? ` — ${transfer.error}` : ""),
      ),
    );
  } else if (container.operation === "organize") {
    lines.push(
      `- Planned occupied slots matched: ${container.matchedSlots}/${container.plannedContents.length}`,
      `- Container contents preserved: ${container.contentsPreserved}`,
      `- Player inventory preserved: ${container.playerInventoryPreserved}`,
      `- Cursor empty: ${container.cursorEmpty}`,
    );
  }
  lines.push(
    `- Contents: ${container.contents.length === 0 ? "empty" : container.contents.map(({ slot, item, count }) => `[${slot}] ${item} x${count}`).join(", ")}`,
    `- Memorized at: ${container.observedAt}`,
    "- Queryable storage memory: `observed_container_slots` and `observed_container_items`",
  );
  if (error) lines.push("", `**Observed stop:** ${error}`);
  return lines.join("\n");
}

export function createUseContainerAction(
  bot: Bot,
  navigation: NavigationRuntime,
  data: SqlBotData,
  dependencies: UseContainerDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: containerCheckpointSchema,
    name: USE_CONTAINER,
    description: USE_CONTAINER_DESCRIPTION,
    inputSchema: useContainerInputSchema,
    resultSchema: useContainerResultSchema,
    formatResult: formatUseContainerResult,
    execution: {
      kind: "resumable_task",
      prepare: (signal) => prepareBotForMovement(bot, navigation, signal),
    },
    annotations: useContainerAnnotations,
    parse: parseUseContainerRequest,
    begin: (request, _lifetime, observe) => beginUseContainer(bot, data, request, observe, dependencies),
  });
}
