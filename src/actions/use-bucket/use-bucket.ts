import { bucketCheckpointSchema } from "../checkpoint-schemas.js";
/**
 * `use_bucket`: scoop a source, or pour a full bucket into a cell.
 *
 * The server decides what a bucket hits by casting a ray from the eyes, so
 * the action's work is choosing what to look at. For a fill that is the
 * source block itself: an empty bucket's ray stops only at source liquid. For
 * a pour it is whatever `pourAim` says lands in the named cell, because a full
 * bucket's ray ignores liquid, stops at the first solid face, and pours into
 * the cell in front of it. Everything else is reach, confirmation, and
 * counting what the liquid did once it landed.
 *
 * Making obsidian is not here. Casting water onto lava is how obsidian is
 * obtained, so it belongs to the process that obtains blocks: the mine
 * process pours when it has nothing to mine and lava in range, and
 * `collect_block obsidian` is the one way to ask for it.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  canAccessLiquid,
  createMovements,
  liquidAccessGoal,
  nearGoal,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
  type WorldView,
} from "../../navigation/index.js";
import { exploreForBlocks } from "../../navigation/processes/mining/block-exploration.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import {
  bucketItem,
  carriedCount,
  countFormations,
  isLiquidSource,
  isReplaceableForPlacement,
  observedEyeHeight,
  pourAim,
  settledFormations,
  sourceFeeding,
  useItemAt,
  type ItemUseResult,
  type LiquidFormations,
} from "../../world/index.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import type { ObserveRequest } from "../../session/request.js";
import {
  parseUseBucketRequest,
  USE_BUCKET,
  USE_BUCKET_DESCRIPTION,
  useBucketInputSchema,
  useBucketResultSchema,
  useBucketAnnotations,
  useBucketOutcomes,
  type BucketCell,
  type BucketLiquid,
  type BucketUseEvidence,
  type UseBucketRequest,
  type UseBucketResult,
} from "./contract.js";

/**
 * How close a pour walks to its cell, feet cell to cell.
 *
 * Two, not the four the ray allows, because the ray is cast from the eye at a
 * face on the *far* side of the cell: from four blocks back the aim point is
 * over five away and the server refuses it before anything else is asked.
 */
const POUR_APPROACH_RANGE = 2;
/**
 * The ranges a pour steps to, one after the other, while no face is in reach of where it stands: a rim, a wall or a
 * route that ended short hides the faces from a distance that a step closer sees over. Run 13: a farm's water hole,
 * `[BUCKET_NO_FACE]` four times in a row for one bot.
 */
const POUR_CLOSER_RANGES = [1, 0] as const;
export interface UseBucketDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly useItem: typeof useItemAt;
  /** The loaded scan with the mine process's exploration behind it: where every source is found. */
  readonly explore: typeof exploreForBlocks;
  readonly world: WorldView;
}

function productionDependencies(navigation: NavigationRuntime): UseBucketDependencies {
  return {
    createMovements,
    navigate: navigation.navigate,
    useItem: useItemAt,
    explore: exploreForBlocks,
    world: navigation.world,
  };
}

function coordinates(position: Vec3): BucketCell {
  return { x: position.x, y: position.y, z: position.z };
}

function carried(bot: Bot, name: string) {
  return bot.inventory.items().find((item) => item.name === name) ?? null;
}

interface SourceSearch {
  readonly sources: readonly Vec3[];
  readonly reason: string | null;
  readonly explored: boolean;
}

/**
 * Source blocks of the liquid, nearest first, from the exploration primitive:
 * the loaded scan mining uses, then the walk mining takes when nothing is
 * loaded. A bound, not a promise: when it runs out the result says so and the
 * model decides where to look next.
 */
async function findSources(
  bot: Bot,
  liquid: BucketLiquid,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<SourceSearch> {
  const definition = bot.registry.blocksByName[liquid];
  if (!definition) return { sources: [], reason: `Minecraft has no block named ${liquid}.`, explored: false };
  const result = await dependencies.explore(bot, {
    stateIds: new Set([definition.minStateId]),
    movements: dependencies.createMovements(bot),
    route: dependencies.navigate,
    signal: context.signal,
  });
  if (result.kind !== "found") return { sources: [], reason: result.reason, explored: true };
  return { sources: result.positions, reason: null, explored: result.explored };
}

async function approach(
  bot: Bot,
  target: Vec3,
  context: ActionContext,
  dependencies: UseBucketDependencies,
  range: number,
): Promise<NavigationResult | null> {
  // Measured feet cell to cell, as `nearGoal` measures arrival, so the two agree.
  if (bot.entity.position.floored().distanceTo(target) <= range) return null;
  return dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: nearGoal(coordinates(target), range),
    signal: context.signal,
  });
}

/** Navigation owns the stance, route excavation, and sightline to any discovered source. */
async function approachVisibleSource(
  bot: Bot,
  sources: readonly Vec3[],
  liquid: BucketLiquid,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<{ readonly source: Vec3 } | { readonly error: string }> {
  const usableSource = () =>
    bot.entity.onGround && Reflect.get(bot.entity, "isInWater") !== true && Reflect.get(bot.entity, "isInLava") !== true
      ? sources.find((source) =>
          canAccessLiquid(dependencies.world, bot.entity.position, source, liquid, observedEyeHeight(bot.entity)),
        )
      : undefined;
  const current = usableSource();
  if (current) return { source: current };
  const route = await dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: liquidAccessGoal(sources, liquid),
    signal: context.signal,
  });
  if (route.status === "stopped") return { error: useBucketOutcomes.routeStopped(route.reason) };
  const source = usableSource();
  return source ? { source } : { error: useBucketOutcomes.noLineOfSight };
}

/** What one bucket request keeps across the attempts a reflex splits it into. */
interface BucketProgress {
  readonly request: UseBucketRequest;
  target: Vec3 | null;
  targetBefore: string | null;
  readonly heldBefore: string | null;
  /** The formations around a pour's cell before the water or lava landed. */
  formationsBefore: LiquidFormations | null;
  aimedAt?: Vec3;
  obsidian: number;
  cobblestone: number;
  used: boolean;
  explored?: boolean;
}

function evidence(bot: Bot, progress: BucketProgress): BucketUseEvidence {
  return {
    dimension: bot.game.dimension,
    action: progress.request.action,
    liquid: progress.request.liquid,
    target: progress.target ? coordinates(progress.target) : null,
    targetBefore: progress.targetBefore,
    targetAfter: progress.target ? (bot.blockAt(progress.target)?.name ?? null) : null,
    ...(progress.aimedAt && { aimedAt: coordinates(progress.aimedAt.floored()) }),
    heldBefore: progress.heldBefore,
    heldAfter: bot.heldItem?.name ?? null,
    obsidianFormed: progress.obsidian,
    cobblestoneFormed: progress.cobblestone,
    used: progress.used,
    ...(progress.explored !== undefined && { explored: progress.explored }),
  };
}

function failure(bot: Bot, progress: BucketProgress, error: string): UseBucketResult {
  return { status: "failed", error, bucket: evidence(bot, progress) };
}

/**
 * Why a named cell cannot be what it was named for, asked before the walk.
 *
 * Run 10 named a flowing cell for a fill and the action walked five seconds to
 * it, digging with the pickaxe on the way, before reading the block and
 * refusing it. A cell that is already wrong is wrong now — and flowing liquid
 * is fed by a source, which a model naming a cell it saw the liquid in is
 * usually a few cells downstream of.
 */
function namedCell(
  bot: Bot,
  request: Extract<UseBucketRequest, { action: "fill" | "pour" }>,
  target: Vec3,
): { readonly target: Vec3 } | { readonly error: string } {
  const block = bot.blockAt(target);
  // Not loaded yet: the walk itself is what makes the cell readable.
  if (!block) return { target };
  if (request.action === "pour") {
    return isReplaceableForPlacement(block) ? { target } : { error: useBucketOutcomes.targetOccupied(block.name) };
  }
  if (isLiquidSource(bot, block, request.liquid)) return { target };
  const feeding = block.name === request.liquid ? sourceFeeding(bot, target, request.liquid) : null;
  return feeding ? { target: feeding } : { error: useBucketOutcomes.notASource(request.liquid, block.name) };
}

type BucketTarget =
  | { readonly kind: "ready"; readonly target: Vec3; readonly explored: boolean }
  | { readonly kind: "failed"; readonly target: Vec3 | null; readonly explored: boolean; readonly error: string };

/** Resolve coordinates or a discovery into the same visible, dry fill approach. */
async function resolveBucketTarget(
  bot: Bot,
  request: UseBucketRequest,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<BucketTarget> {
  const namedTarget = request.cell ? new Vec3(request.cell.x, request.cell.y, request.cell.z) : null;
  const search: SourceSearch = namedTarget
    ? { sources: [namedTarget], reason: null, explored: false }
    : await findSources(bot, request.liquid, context, dependencies);
  const failed = (error: string): BucketTarget => ({
    kind: "failed",
    target: namedTarget,
    explored: search.explored,
    error,
  });
  if (search.sources.length === 0) return failed(useBucketOutcomes.noSource(request.liquid, search.reason));
  let sources = search.sources;
  if (namedTarget) {
    const named = namedCell(bot, request, namedTarget);
    if ("error" in named) return failed(named.error);
    sources = [named.target];
  }
  try {
    if (request.action === "fill") {
      const reached = await approachVisibleSource(bot, sources, request.liquid, context, dependencies);
      return "error" in reached
        ? failed(reached.error)
        : { kind: "ready", target: reached.source, explored: search.explored };
    }
    const target = sources[0]!;
    const route = await approach(bot, target, context, dependencies, POUR_APPROACH_RANGE);
    return route?.status === "stopped"
      ? failed(useBucketOutcomes.routeStopped(route.reason))
      : { kind: "ready", target, explored: search.explored };
  } catch (cause) {
    context.signal?.throwIfAborted();
    return failed(useBucketOutcomes.routeStopped(cause instanceof Error ? cause.message : String(cause)));
  }
}

/**
 * Where a pour from here lands in the named cell, stepping closer (the POUR_CLOSER_RANGES, one after the other) and
 * looking again while no face is in reach. The error is the refusal: the route stopped, or no face lands there.
 */
async function aimWithCloserSteps(
  bot: Bot,
  target: Vec3,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<{ readonly aim: NonNullable<ReturnType<typeof pourAim>> } | { readonly error: string }> {
  // The same question the cast asks: where would a pour from here land? The
  // named cell is the only answer this action accepts.
  const aimAtTarget = () => pourAim(bot, (landing) => (landing.equals(target) ? 1 : null));
  let aim = aimAtTarget();
  for (const range of POUR_CLOSER_RANGES) {
    if (aim) break;
    let route: NavigationResult | null;
    try {
      route = await approach(bot, target, context, dependencies, range);
    } catch (cause) {
      context.signal?.throwIfAborted();
      return { error: useBucketOutcomes.routeStopped(cause instanceof Error ? cause.message : String(cause)) };
    }
    if (route?.status === "stopped") break;
    aim = aimAtTarget();
  }
  return aim ? { aim } : { error: useBucketOutcomes.noFace };
}

interface BucketCounts {
  readonly empty: number;
  readonly full: number;
}

function bucketCounts(bot: Bot, liquid: BucketLiquid): BucketCounts {
  return { empty: carriedCount(bot, bucketItem(liquid, false)), full: carriedCount(bot, bucketItem(liquid, true)) };
}

/**
 * Whether a pour's cell shows the pour: its liquid in source state, or a block with a collision box that is not what
 * the cell held before (the liquid met the lava there and made a block). A cell is replaceable before any cast, so a
 * solid block now came from the pour. The footing reflex's water landing elsewhere moves the bucket counts without
 * touching this cell, and flowing liquid has no collision box: neither shows this pour.
 */
function pourShownByCell(bot: Bot, progress: BucketProgress, target: Vec3): boolean {
  const block = bot.blockAt(target);
  if (!block) return false;
  const formed = block.boundingBox === "block" && block.name !== progress.targetBefore;
  return isLiquidSource(bot, block, progress.request.liquid) || formed;
}

/**
 * Whether an attempt a reflex cut short already made this request's scoop or pour: the bucket counts changed and the
 * cell the cast was aimed at shows it (a loaded cell no longer the liquid's source for a fill). The counts alone are
 * not proof, since another bucket use moves them too (review 2026-10-19); with no cast begun there is no cell to read.
 */
function bucketUseAlreadyMade(bot: Bot, progress: BucketProgress, before: BucketCounts): boolean {
  const { request, target, targetBefore } = progress;
  if (!target || targetBefore === null) return false;
  const now = bucketCounts(bot, request.liquid);
  if (request.action === "pour") {
    return now.full < before.full && now.empty > before.empty && pourShownByCell(bot, progress, target);
  }
  const block = bot.blockAt(target);
  return now.full > before.full && now.empty < before.empty && block !== null && !isLiquidSource(bot, block, request.liquid);
}

/** The use is made and seen in the inventory: count what a pour formed, then report it. */
async function confirmBucketUsed(bot: Bot, progress: BucketProgress, context: ActionContext): Promise<UseBucketResult> {
  if (progress.target && progress.formationsBefore) {
    const after = await settledFormations(bot, progress.target, context.signal);
    progress.obsidian = Math.max(0, after.obsidian - progress.formationsBefore.obsidian);
    progress.cobblestone = Math.max(0, after.cobblestone - progress.formationsBefore.cobblestone);
  }
  progress.used = true;
  return { status: "succeeded", bucket: evidence(bot, progress) };
}

/** A cast the action declined to make: the cell is not a source, is occupied, is unloaded, or has no face to pour at. */
interface BucketRefusal {
  readonly kind: "refused";
  readonly error: string;
}

function refused(error: string): BucketRefusal {
  return { kind: "refused", error };
}

/** Cast the bucket at the cell this attempt resolved; the use itself, not yet confirmed. */
async function castBucket(
  bot: Bot,
  progress: BucketProgress,
  item: NonNullable<ReturnType<typeof carried>>,
  target: Vec3,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<ItemUseResult | BucketRefusal> {
  const { request } = progress;
  const targetBlock = bot.blockAt(target);
  if (!targetBlock) return refused(useBucketOutcomes.targetUnloaded);
  if (request.action === "fill") {
    if (!isLiquidSource(bot, targetBlock, request.liquid)) {
      return refused(useBucketOutcomes.notASource(request.liquid, targetBlock.name));
    }
    // Aim at the source's surface, not its centre: from four blocks back a
    // ray to the centre dips into the shore block just before the water.
    return dependencies.useItem(bot, {
      item,
      lookAt: target.offset(0.5, 0.9, 0.5),
      expectedInventoryGain: { item: bucketItem(request.liquid, true), count: 1 },
      signal: context.signal,
    });
  }
  if (!isReplaceableForPlacement(targetBlock)) return refused(useBucketOutcomes.targetOccupied(targetBlock.name));
  const stepped = await aimWithCloserSteps(bot, target, context, dependencies);
  if ("error" in stepped) return refused(stepped.error);
  progress.aimedAt = stepped.aim.surface;
  progress.formationsBefore = countFormations(bot, target);
  return dependencies.useItem(bot, {
    item,
    lookAt: stepped.aim.lookAt,
    expectedCells: [{ position: target, matches: (block) => block.name === request.liquid }],
    expectedHeldItem: bucketItem(request.liquid, false),
    signal: context.signal,
  });
}

/**
 * One request's executor. Its progress (the cell, what the formations were, the counts at `begin`) lives across
 * attempts, so one the inventory already shows used goes straight to its evidence instead of using a bucket twice.
 */
export function beginUseBucket(
  bot: Bot,
  request: UseBucketRequest,
  observe: ObserveRequest,
  dependencies: UseBucketDependencies,
): RequestExecution<UseBucketResult> {
  const filling = request.action === "fill";
  const bucketName = bucketItem(request.liquid, !filling);
  const before = bucketCounts(bot, request.liquid);
  const progress: BucketProgress = {
    request,
    target: request.cell ? new Vec3(request.cell.x, request.cell.y, request.cell.z) : null,
    targetBefore: null,
    heldBefore: bot.heldItem?.name ?? null,
    formationsBefore: null,
    obsidian: 0,
    cobblestone: 0,
    used: false,
  };
  observe(() => ({ baseline: { held: progress.heldBefore },
    checkpoint: { phase: progress.used ? "confirmed" : filling ? "finding_and_filling" : "approaching_and_pouring", held: bot.heldItem?.name ?? null,
      target: progress.target ? { x: progress.target.x, y: progress.target.y, z: progress.target.z } : null,
      targetBlock: progress.target ? bot.blockAt(progress.target)?.name ?? null : null, used: progress.used,
      obsidianFormed: progress.obsidian, cobblestoneFormed: progress.cobblestone },
    completion: { kind: "event", observed: progress.used, owes: "Both the bucket inventory and the selected world cell must confirm the use." },
  }));
  return async (context) => {
    context.signal?.throwIfAborted();
    if (progress.used) return { status: "succeeded", bucket: evidence(bot, progress) };
    if (bucketUseAlreadyMade(bot, progress, before)) return confirmBucketUsed(bot, progress, context);
    const item = carried(bot, bucketName);
    if (!item) return failure(bot, progress, useBucketOutcomes.noBucket(bucketName));

    const resolved = await resolveBucketTarget(bot, request, context, dependencies);
    progress.explored = resolved.explored;
    progress.target = resolved.target;
    if (resolved.kind === "failed") return failure(bot, progress, resolved.error);
    progress.targetBefore = bot.blockAt(resolved.target)?.name ?? null;
    const use = await castBucket(bot, progress, item, resolved.target, context, dependencies);
    if (use.kind === "refused") return failure(bot, progress, use.error);
    if (use.kind === "failed") return failure(bot, progress, useBucketOutcomes.failed(use.error));
    return confirmBucketUsed(bot, progress, context);
  };
}

/** Scoop a source or pour a full bucket, and report only what was observed. */
export function useBucket(
  bot: Bot,
  request: UseBucketRequest,
  context: ActionContext,
  dependencies: UseBucketDependencies,
): Promise<UseBucketResult> {
  return beginUseBucket(bot, request, context.observeProgress ?? (() => {}), dependencies)(context);
}

export function formatUseBucketResult(result: UseBucketResult): string {
  const { bucket } = result;
  const target = bucket.target ? `\`${bucket.target.x}, ${bucket.target.y}, ${bucket.target.z}\`` : "no cell";
  const summary = !bucket.used
    ? `Did not ${bucket.action} the bucket.`
    : bucket.action === "fill"
      ? `Filled the bucket with **${bucket.liquid}** from ${target}.`
      : `Poured **${bucket.liquid}** into ${target}.`;
  const lines = [
    summary,
    `- Hand: \`${bucket.heldBefore ?? "empty"}\` → \`${bucket.heldAfter ?? "empty"}\` in \`${bucket.dimension}\``,
    `- Target: \`${bucket.targetBefore ?? "unloaded"}\` → \`${bucket.targetAfter ?? "unloaded"}\``,
  ];
  if (bucket.aimedAt) lines.push(`- Aimed at: \`${bucket.aimedAt.x}, ${bucket.aimedAt.y}, ${bucket.aimedAt.z}\``);
  if (bucket.action === "pour" && bucket.used) {
    lines.push(`- Formed: ${bucket.obsidianFormed} obsidian, ${bucket.cobblestoneFormed} cobblestone`);
  }
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createUseBucketAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: UseBucketDependencies = productionDependencies(navigation),
) {
  return defineAction({
    checkpointSchema: bucketCheckpointSchema,
    name: USE_BUCKET,
    description: USE_BUCKET_DESCRIPTION,
    inputSchema: useBucketInputSchema,
    resultSchema: useBucketResultSchema,
    formatResult: formatUseBucketResult,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: useBucketAnnotations,
    parse: parseUseBucketRequest,
    begin: (request, _lifetime, observe) => beginUseBucket(bot, request, observe, dependencies),
  });
}
