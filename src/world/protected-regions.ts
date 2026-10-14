/**
 * Protected regions (ADR-012): boxes of blocks no route of this bot may dig or scaffold in, such as a house it is
 * building or a player's build it was asked to respect. The store lives in bot-data; navigation reads it through this
 * per-bot provider, like the navigation policy, so every route, collect and automatic response obeys the same list.
 */
import type { Bot } from "mineflayer";

export interface BlockCorner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One protected box, inclusive on every side. */
export interface ProtectedRegion {
  readonly regionId: number;
  readonly dimension: string;
  readonly min: BlockCorner;
  readonly max: BlockCorner;
  /** Whose build it is: the bot's own username or a player's name. */
  readonly owner: string;
  readonly label: string;
}

const providers = new WeakMap<Bot, () => readonly ProtectedRegion[]>();

export function setProtectedRegionsProvider(bot: Bot, provider: () => readonly ProtectedRegion[]): void {
  providers.set(bot, provider);
}

/** The regions as they stand now; none for a bot whose runtime set no provider (tests, embedded tools). */
export function readProtectedRegions(bot: Bot): readonly ProtectedRegion[] {
  return providers.get(bot)?.() ?? [];
}

/** Minecraft usernames are case-insensitive, and players type them however they like. */
export function sameOwner(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** The first region of this dimension holding the cell, skipping the regions `exemptOwner` owns. */
export function protectedRegionAt(
  regions: readonly ProtectedRegion[],
  dimension: string,
  x: number,
  y: number,
  z: number,
  exemptOwner?: string,
): ProtectedRegion | null {
  for (const region of regions) {
    if (region.dimension !== dimension) continue;
    if (exemptOwner !== undefined && sameOwner(region.owner, exemptOwner)) continue;
    const { min, max } = region;
    if (x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z) return region;
  }
  return null;
}

export function describeProtectedRegion(region: ProtectedRegion): string {
  return `protected region #${region.regionId} '${region.label}' (owner ${region.owner})`;
}
