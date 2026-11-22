import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellIntersectsPlayerBody, type Position3 } from "../utils/index.js";
import { isLiquid, isReplaceableForPlacement, supportsFlatPlacement } from "./block-classification.js";

const SEARCH_HEIGHTS = [0, -1, 1] as const;

/** Why a footprint origin is refused: the first rule its first failing cell breaks, in this order. */
export type FlatPlacementMiss = "unloaded" | "body" | "wet" | "blocked" | "unsupported";

export interface FlatPlacementSearch {
  readonly candidates: Vec3[];
  /** Footprint origins that failed, by the first rule their first failing cell broke, in the order of the type. */
  readonly misses: Readonly<Record<FlatPlacementMiss, number>>;
  readonly origins: number;
}

/**
 * Find nearby origins where every footprint cell is clear, supported, and
 * outside the player's body. The footprint is expressed relative to its origin.
 */
export function findFlatPlacementCandidates(bot: Bot, footprint: readonly Position3[], maxRadius = 4): Vec3[] {
  return searchFlatPlacements(bot, footprint, maxRadius).candidates;
}

/**
 * The same search as `findFlatPlacementCandidates`, and the count of each refusal: an origin's miss is decided by its
 * first failing footprint cell (footprint order), and within that cell by the first rule it breaks.
 */
export function searchFlatPlacements(bot: Bot, footprint: readonly Position3[], maxRadius = 4): FlatPlacementSearch {
  const center = bot.entity.position.floored();
  const candidates: Vec3[] = [];
  const misses: Record<FlatPlacementMiss, number> = { unloaded: 0, body: 0, wet: 0, blocked: 0, unsupported: 0 };
  let origins = 0;

  for (const origin of searchOrigins(center, maxRadius)) {
    origins += 1;
    const miss = footprintMiss(bot, footprint.map((offset) => origin.offset(offset.x, offset.y, offset.z)));
    if (miss === null) candidates.push(origin);
    else misses[miss] += 1;
  }

  return {
    candidates: candidates.sort((left, right) => bot.entity.position.distanceTo(left) - bot.entity.position.distanceTo(right)),
    misses,
    origins,
  };
}

/** Every origin of the search, ring by ring from the centre: each ring's columns, then its heights. */
function* searchOrigins(center: Vec3, maxRadius: number): Generator<Vec3> {
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (const [dx, dz] of ringColumns(radius)) {
      for (const dy of SEARCH_HEIGHTS) yield center.offset(dx, dy, dz);
    }
  }
}

/** The columns at Chebyshev distance `radius` from the centre, in the order of the search. */
function ringColumns(radius: number): [number, number][] {
  const columns: [number, number][] = [];
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === radius) columns.push([dx, dz]);
    }
  }
  return columns;
}

/** The miss of the first failing cell of a footprint, or null when every cell is placeable. */
function footprintMiss(bot: Bot, cells: readonly Vec3[]): FlatPlacementMiss | null {
  for (const cell of cells) {
    const miss = cellMiss(bot, cell);
    if (miss !== null) return miss;
  }
  return null;
}

/** The first rule a cell breaks, checked in the order of `FlatPlacementMiss`. */
function cellMiss(bot: Bot, cell: Vec3): FlatPlacementMiss | null {
  const block = bot.blockAt(cell);
  const below = bot.blockAt(cell.offset(0, -1, 0));
  if (!block || !below) return "unloaded";
  if (cellIntersectsPlayerBody(cell, bot.entity.position)) return "body";
  if (isLiquid(block)) return "wet";
  if (!isReplaceableForPlacement(block, bot.version)) return "blocked";
  if (!supportsFlatPlacement(below)) return "unsupported";
  return null;
}
