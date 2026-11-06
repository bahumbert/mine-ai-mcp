// Leveling a zone on request (level_area): between marker blocks, around a player, or between corners.
import type { Step } from "../actions.ts";
import { LEVEL_BLOCK_BUDGET, LEVEL_LIMITS, type Zone } from "../building/terrain.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { levelZone } from "./level-zone.ts";
import { distanceBetween, whereIs } from "./positions.ts";

/** How far away marker blocks are looked for. */
const MARKER_RANGE = 48;
/** The most marker blocks a zone has: its corners. */
const MAX_MARKERS = 4;

/**
 * Levels a zone on request (owner, 2026-10-02): between the players' marker blocks, around a player, or between
 * corners. Her own region while she works, so fetching fill dirt never digs into it (ADR-012).
 */
export async function levelArea(context: SkillContext, step: Extract<Step, { skill: "level_area" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  let zone: Zone;
  let level = step.y;
  const keep = new Set<string>();
  if (step.markers !== undefined) {
    const here = snapshot.position;
    const nearest = await context.runtime.findBlocks(step.markers, MAX_MARKERS);
    const found = nearest.filter((at) => distanceBetween(at, here) <= MARKER_RANGE);
    if (found.length < 2) {
      // Where the farther ones are, so the next step can walk there (live 2026-10-02: 66 blocks away after her own
      // goal, she went to her own position six times).
      const farther = nearest.filter((at) => distanceBetween(at, here) > MARKER_RANGE).slice(0, 2);
      const hint = farther.length === 0 ? "" : `; the nearest farther ones are at ${farther.map((at) => `${at.x} ${at.y} ${at.z}`).join(" and ")}: go near them first`;
      return { status: "failed", detail: `found ${found.length === 0 ? "no" : "only one"} ${step.markers} within ${MARKER_RANGE} blocks: the zone needs two corners${hint}` };
    }
    zone = { minX: Math.min(...found.map((at) => at.x)), maxX: Math.max(...found.map((at) => at.x)), minZ: Math.min(...found.map((at) => at.z)), maxZ: Math.max(...found.map((at) => at.z)) };
    for (const at of found) keep.add(`${at.x},${at.y},${at.z}`);
    level ??= Math.min(...found.map((at) => at.y));
  } else if (step.around !== undefined) {
    // The first look fixes the place for the whole objective (the player may walk or fly away between two steps).
    const fixed = context.levelSites?.get(step.around.toLowerCase());
    const seen = fixed ?? whereIs(snapshot, step.around, context.self);
    if (seen === null) return { status: "failed", detail: `cannot see ${step.around} to level the ground around them` };
    const site = { x: Math.floor(seen.x), y: Math.floor(seen.y), z: Math.floor(seen.z) };
    if (fixed === undefined) context.levelSites?.set(step.around.toLowerCase(), site);
    zone = { minX: site.x - step.radius, maxX: site.x + step.radius, minZ: site.z - step.radius, maxZ: site.z + step.radius };
    level ??= site.y;
  } else if (step.x1 !== undefined && step.z1 !== undefined && step.x2 !== undefined && step.z2 !== undefined) {
    zone = { minX: Math.min(step.x1, step.x2), maxX: Math.max(step.x1, step.x2), minZ: Math.min(step.z1, step.z2), maxZ: Math.max(step.z1, step.z2) };
  } else {
    return { status: "failed", detail: "level_area needs markers, a player to level around, or x1, z1, x2, z2 corners" };
  }
  if (level === undefined) return { status: "failed", detail: "level_area with corners needs the walking level y" };
  const [width, depth] = [zone.maxX - zone.minX + 1, zone.maxZ - zone.minZ + 1];
  if (width > LEVEL_LIMITS.side || depth > LEVEL_LIMITS.side) return { status: "failed", detail: `the zone is ${width} by ${depth}: at most ${LEVEL_LIMITS.side} by ${LEVEL_LIMITS.side} at a time` };
  // One layer under the level: a flat floor, bridged over a pond or a ravine, not columns hanging into it (owner,
  // 2026-10-02: "a flat platform of 1 level").
  return levelZone(context, zone, level, `${width}x${depth} at y ${level}`, { keep, below: 1, budget: LEVEL_BLOCK_BUDGET, ...(step.fill !== undefined && { fillWith: step.fill }) });
}
