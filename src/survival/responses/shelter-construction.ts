// The steps of building a shelter: the shaft, the ring, the cap, one pass at a time.
import { Vec3 } from "vec3";
import { selectHarvestTool } from "../../navigation/mineflayer/movement-policy.js";
import { findPlacementSupport } from "../../world/index.js";
import { recoveryAvailable } from "../perception/combat/recovery.js";
import { permitsHide } from "../policy/combat/permissions.js";
import {
  centerShelterCell,
  constructionChanged,
  repelShelterIntruder,
  sealShelterCell,
  type ShelterBuild,
  shelterBlocks,
  shelterHazard,
  shelterLiquidFailure,
  type StepEnd,
  waitForShelterTicks,
} from "./shelter-build.js";
import { diggable, enclosedInPlace, shelterFeet, shelterIntruder, SIDES, sidesByThreat, solid } from "./shelter-cells.js";

/** How far down the bot digs: three cells put its head below anything that walks, and out of a skeleton's line. */
export const HIDE_DEPTH = 3;
/**
 * Blocks for walling in where the bot stands: four sides at feet height, four
 * at head height, an eave, and the cap. With that many carried the ring is
 * built instead of the shaft; with fewer, the shaft is dug and the ring is
 * the fallback for ground that will not take one.
 */
export const WALL_IN_BLOCKS = 10;
/** Existing observed-fall budget: a descent must reach a grounded position before construction continues. */
const DESCENT_TICKS = 20;


/** Dig one cell of the shaft and drop into it: "dug", "blocked" when the ground will not take it. */
async function digShelterShaftCell(build: ShelterBuild): Promise<"dug" | "blocked" | StepEnd> {
  const { bot, options, itemUse } = build;
  const { signal, threatContext } = options;
  const standing = shelterFeet(bot);
  const below = bot.blockAt(standing.offset(0, -1, 0));
  const under = bot.blockAt(standing.offset(0, -2, 0));
  if (!diggable(below) || !solid(under)) return "blocked";
  const centered = await centerShelterCell(build, standing);
  if (shelterIntruder(bot, threatContext)) return "again";
  if (!centered) return { kind: "failed", error: "The bot could not centre over the shelter shaft" };
  const tool = selectHarvestTool(bot, below);
  itemUse.lowerShield();
  if (tool && bot.heldItem?.name !== tool.name) await bot.equip(tool, "hand");
  signal.throwIfAborted();
  if (constructionChanged(build, standing)) return "again";
  try {
    await bot.dig(below, true);
  } catch {
    signal.throwIfAborted();
    return "blocked";
  }
  const landedBelow = () => bot.entity.onGround && bot.entity.position.y <= standing.y - 0.5;
  for (let waited = 0; waited < DESCENT_TICKS && !landedBelow(); waited += 1) {
    await waitForShelterTicks(build, 1);
  }
  build.dug += 1;
  if (!landedBelow()) {
    return { kind: "failed", error: `Dug at ${below.position}, but the bot did not land below the shaft opening` };
  }
  return "dug";
}

/**
 * Dig down up to HIDE_DEPTH cells; the cells dug, or the step end. With blocks
 * enough for the whole box the ring goes up instead of the shaft: ten
 * placements close it in under three seconds and each blocks a direction as it
 * lands, while three digs leave the head exposed for longer than a walking
 * pack needs to cross twelve blocks.
 */
async function digShelterShaft(build: ShelterBuild): Promise<number | StepEnd> {
  const { options } = build;
  const wallFirst = shelterBlocks(build) >= WALL_IN_BLOCKS || build.walled > 0 || build.capped;
  let descended = 0;
  for (let step = 0; step < HIDE_DEPTH && !wallFirst && options.threatContext.policy.terrain.dig; step += 1) {
    options.signal.throwIfAborted();
    const dug = await digShelterShaftCell(build);
    if (dug === "blocked") break;
    if (dug !== "dug") return dug;
    descended += 1;
  }
  return descended;
}

/** Centre the body on the cell the ring is built around, once the shaft could not be dug. */
async function centerForShelterRing(build: ShelterBuild, feet: Vec3): Promise<StepEnd | null> {
  const { bot, options } = build;
  // A body straddling a cell edge occupies the wall's destination. The
  // server refuses that block even though the target itself is air.
  const floor = bot.blockAt(feet.offset(0, -1, 0));
  const supportedCenter = floor?.shapes.some(
    ([minX, , minZ, maxX, maxY, maxZ]) =>
      minX <= 0.5 &&
      maxX >= 0.5 &&
      minZ <= 0.5 &&
      maxZ >= 0.5 &&
      Math.abs(feet.y - 1 + maxY - bot.entity.position.y) < 0.001,
  );
  if (shelterBlocks(build) > 0 && !supportedCenter) {
    return { kind: "failed", error: "The shelter cell has no solid floor to centre on" };
  }
  const centered = shelterBlocks(build) === 0 || (await centerShelterCell(build, feet));
  if (!bot.entity.onGround || !shelterFeet(bot).equals(feet) || shelterIntruder(bot, options.threatContext))
    return "again";
  if (!centered) return { kind: "failed", error: "The bot could not centre inside the shelter walls" };
  return constructionChanged(build, feet) ? "again" : null;
}

/** One side of the ring: feet height before head height, since the head block has nothing to hold it until the one beneath exists. */
async function raiseShelterRingSide(build: ShelterBuild, feet: Vec3, side: Vec3): Promise<StepEnd | null> {
  const { bot, options } = build;
  const lower = feet.plus(side);
  options.signal.throwIfAborted();
  if (constructionChanged(build, feet)) return "again";
  // Over a drop the wall cell has no neighbour to hold it, but the
  // block the bot stands on has a free side face there. Extend the
  // floor by one block first and build the side up from it. On
  // 2026-09-07 a fortress-bridge hide refused its first wall for this
  // reason, stood down, and the bot was knocked off the walkway.
  if (!solid(bot.blockAt(lower)) && !findPlacementSupport(bot, lower)) {
    if (await sealShelterCell(build, lower.offset(0, -1, 0))) build.walled += 1;
  }
  for (const level of [0, 1]) {
    options.signal.throwIfAborted();
    if (constructionChanged(build, feet)) return "again";
    if (await sealShelterCell(build, lower.offset(0, level, 0))) build.walled += 1;
  }
  // Close upward knockback as soon as the first wall can support a cap.
  // Waiting for all four walls left the last eave inside an approaching
  // dragon before the roof existed. This is still the same ten-block box.
  if (!build.capped && solid(bot.blockAt(lower.offset(0, 1, 0)))) {
    if (constructionChanged(build, feet)) return "again";
    if (await sealShelterCell(build, lower.offset(0, 2, 0))) build.walled += 1;
    if (constructionChanged(build, feet)) return "again";
    build.capped = await sealShelterCell(build, feet.offset(0, 2, 0));
  }
  return null;
}

/** The ring where the bot stands, the side facing the nearest threat first. */
async function raiseShelterRing(build: ShelterBuild, feet: Vec3, sides: readonly Vec3[]): Promise<StepEnd | null> {
  const centering = await centerForShelterRing(build, feet);
  if (centering) return centering;
  for (const side of sides) {
    const raised = await raiseShelterRingSide(build, feet, side);
    if (raised) return raised;
  }
  return null;
}

/** Over a drop the floor cannot support the first wall block; the finished roof can: extend its eave, then build each side downward. */
async function hangShelterWallsFromRoof(
  build: ShelterBuild,
  feet: Vec3,
  sides: readonly Vec3[],
): Promise<StepEnd | null> {
  const { bot, options } = build;
  const cap = feet.offset(0, 2, 0);
  for (const side of sides) {
    if (constructionChanged(build, feet)) return "again";
    const lower = feet.plus(side);
    const upper = lower.offset(0, 1, 0);
    if (solid(bot.blockAt(lower)) && solid(bot.blockAt(upper))) continue;
    options.signal.throwIfAborted();
    if (!solid(bot.blockAt(upper)) && !findPlacementSupport(bot, upper)) {
      if (await sealShelterCell(build, cap.plus(side))) build.walled += 1;
    }
    if (constructionChanged(build, feet)) return "again";
    if (!solid(bot.blockAt(upper)) && (await sealShelterCell(build, upper))) build.walled += 1;
    if (constructionChanged(build, feet)) return "again";
    if (!solid(bot.blockAt(lower)) && (await sealShelterCell(build, lower))) build.walled += 1;
  }
  return null;
}

/**
 * The cap over the head. In a shaft it rests against the shaft's walls; above
 * ground the cell over the head touches nothing solid, so one eave goes on top
 * of a head-height wall first and the cap is placed against its side.
 */
async function capShelter(
  build: ShelterBuild,
  feet: Vec3,
  sides: readonly Vec3[],
  descended: number,
): Promise<StepEnd | null> {
  const { bot, options } = build;
  const cap = feet.offset(0, 2, 0);
  if (descended < 2) {
    for (const side of sides) {
      options.signal.throwIfAborted();
      if (constructionChanged(build, feet)) return "again";
      const eave = cap.plus(side);
      if (solid(bot.blockAt(eave))) break;
      if (await sealShelterCell(build, eave)) {
        build.walled += 1;
        break;
      }
    }
  }
  if (constructionChanged(build, feet)) return "again";
  build.capped = (await sealShelterCell(build, cap)) || build.capped;
  if (descended === 0 && solid(bot.blockAt(cap))) return hangShelterWallsFromRoof(build, feet, sides);
  return null;
}

/** Why the hide must stop before another construction pass (a hazard, a ban, a liquid, the deadline), or null. */
function constructionStopped(build: ShelterBuild): StepEnd | null {
  const { bot, options } = build;
  const hazard = shelterHazard(build);
  if (hazard) return { kind: "failed", error: hazard };
  if (!permitsHide(options.threatContext.policy, recoveryAvailable(bot, options.threatContext.food)))
    return { kind: "failed", error: "[COMBAT_CONSTRAINED] Hiding is no longer permitted." };
  const liquid = shelterLiquidFailure(bot);
  if (liquid) return liquid;
  if (Date.now() >= build.constructionDeadline) {
    return { kind: "failed", error: `The shelter was not finished within ${Math.ceil(options.maximumMs / 1000)} s` };
  }
  return null;
}

/**
 * One pass of construction: repel, land, dig the shaft or raise the ring, cap.
 * "built" when the pass ends with nothing more to place; "again" when the body
 * moved and the pass starts over from the cell it landed in.
 */
export async function constructShelterPass(build: ShelterBuild): Promise<StepEnd | "built"> {
  const { bot, options } = build;
  options.signal.throwIfAborted();
  const stopped = constructionStopped(build);
  if (stopped) return stopped;
  const intruder = shelterIntruder(bot, options.threatContext);
  if (intruder) {
    await repelShelterIntruder(build, intruder);
    return "again";
  }
  // Knockback can change both the occupied cell and its floor. Pick the
  // construction origin only after the body has landed, then recheck it.
  if (!bot.entity.onGround) {
    await waitForShelterTicks(build, 1);
    return "again";
  }
  const sides = options.firstWallDirection
    ? [...SIDES].sort((a, b) => b.dot(options.firstWallDirection!) - a.dot(options.firstWallDirection!))
    : sidesByThreat(bot, options.threatContext);
  const descended = await digShelterShaft(build);
  if (typeof descended !== "number") return descended;
  const feet = shelterFeet(bot);
  const ringed = descended === 0 ? await raiseShelterRing(build, feet, sides) : null;
  if (ringed) return ringed;
  const capped = descended >= 2 || build.walled > 0 ? await capShelter(build, feet, sides, descended) : null;
  if (capped) return capped;
  if (descended === 0 && build.walled === 0 && !build.capped) {
    return {
      kind: "failed",
      error: build.refusal
        ? `Nothing below the bot could be dug, and the first placement was refused at ${build.refusal}`
        : "Nothing below the bot could be dug and no block could be placed around it",
    };
  }
  // A flying body can temporarily occupy the last wall cell. Keep the
  // observed partial shell and retry after a tick within the same attempt,
  // instead of opening it to escape or digging a new shaft underneath it.
  if (
    options.holdWhile &&
    (build.walled > 0 || build.capped) &&
    !enclosedInPlace(bot, options.blockNames) &&
    shelterHazard(build) === null &&
    Date.now() < build.constructionDeadline
  ) {
    await waitForShelterTicks(build, 1);
    return "again";
  }
  return "built";
}
