// The protected areas a skill knows and checks: which a box overlaps, the nearest clear spot, and the agent's list of them.
import type { Position, ProtectedArea } from "../runtime-client.ts";
import type { SkillContext } from "../skills.ts";

/** The label of the region a leveling job sets aside while it works (left behind only if the job was killed). */
export const LEVELING_LABEL = "leveling ";

/** How far around a refused house site the nearest clear one is looked for. */
export const SITE_SEARCH = 32;

/** Protected areas a box overlaps, her leveling margins and `except` (the region of the work itself) left out. */
export function overlapsOf(areas: readonly ProtectedArea[], { min, max }: { readonly min: Position; readonly max: Position }, except: readonly number[] = []): ProtectedArea[] {
  return areas.filter((area) =>
    !except.includes(area.regionId) && !area.label.startsWith(LEVELING_LABEL) &&
    area.min.x <= max.x && area.max.x >= min.x && area.min.y <= max.y && area.max.y >= min.y && area.min.z <= max.z && area.max.z >= min.z);
}

/**
 * "overlaps protected area #4 'small medieval house' (yours: leveling would dig it up)": what each area is, so the
 * model weighs it (live 2026-10-02: told only "release it first", she released Tom's area and then her own house to
 * level around Tom, and began digging the house).
 */
export function describeOverlaps(context: SkillContext, overlapping: readonly ProtectedArea[]): string {
  const whose = (area: ProtectedArea) => area.owner === context.self ? "yours: leveling would dig it up" : `owned by ${area.owner}`;
  return `overlaps protected area${overlapping.length === 1 ? "" : "s"} ${overlapping.map((area) => `#${area.regionId} '${area.label}' (${whose(area)})`).join(", ")}`;
}

/**
 * The spot nearest `origin`, at its height, whose box (`boxAt`) overlaps no protected area, within {@link SITE_SEARCH}
 * blocks; null when none. Shared by houses (their door) and farm plots (their middle).
 */
export function nearestClearSpot(areas: readonly ProtectedArea[], origin: Position, boxAt: (spot: Position) => { readonly min: Position; readonly max: Position }): Position | null {
  for (let ring = 1; ring <= SITE_SEARCH; ring += 1) {
    const clear = ringSpots(origin, ring).find((spot) => overlapsOf(areas, boxAt(spot)).length === 0);
    if (clear !== undefined) return clear;
  }
  return null;
}

/** The spots on the square ring `ring` blocks around `origin`, at its height, nearest first. */
function ringSpots(origin: Position, ring: number): Position[] {
  const spots: Position[] = [];
  for (let dx = -ring; dx <= ring; dx += 1) {
    for (let dz = -ring; dz <= ring; dz += 1) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) spots.push({ x: origin.x + dx, y: origin.y, z: origin.z + dz });
    }
  }
  return spots.sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z));
}

export function noteArea(context: SkillContext, area: ProtectedArea): void {
  if (context.areas === undefined) return;
  const index = context.areas.findIndex((known) => known.regionId === area.regionId);
  if (index === -1) context.areas.push(area);
  else context.areas[index] = area;
}
