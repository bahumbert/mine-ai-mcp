// Protecting an area from her own digging and placing, and releasing it (protect_area, release_area).
import type { Step } from "../actions.ts";
import type { Position } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { isSelf, whereIs } from "./positions.ts";
import { noteArea } from "./protected-areas.ts";

/** Keeps the character's own digging and scaffolding out of an area (ADR-012); its own choice, e.g. when asked. */
export async function protectArea(context: SkillContext, step: Extract<Step, { skill: "protect_area" }>): Promise<SkillResult> {
  let centre: Position;
  if (step.player !== undefined) {
    const seen = whereIs(await context.runtime.status(), step.player, context.self);
    if (seen === null) return { status: "failed", detail: `cannot see ${step.player} to protect the area around them` };
    centre = seen;
  } else if (step.x !== undefined && step.y !== undefined && step.z !== undefined) {
    centre = { x: step.x, y: step.y, z: step.z };
  } else {
    // Neither a player nor coordinates: where she stands (live 2026-10-11: "protect the area around you" came as the
    // speaker's name four times).
    centre = (await context.runtime.status()).position;
  }
  const c = { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
  const r = step.radius;
  const outcome = await context.runtime.protectRegion({
    min: { x: c.x - r, y: c.y - r, z: c.z - r },
    max: { x: c.x + r, y: c.y + r, z: c.z + r },
    label: step.label,
    reason: `I chose to protect ${step.label}.`,
    ...(step.player !== undefined && !isSelf(step.player, context.self) && { owner: step.player }),
  });
  if (outcome.status === "failed") return { status: "failed", detail: outcome.error };
  noteArea(context, outcome.area);
  return {
    status: "done",
    detail: `protected area #${outcome.area.regionId} '${outcome.area.label}' (${2 * r + 1} blocks across around ${c.x} ${c.y} ${c.z}): I will not dig or place blocks there`,
  };
}

export async function releaseArea(context: SkillContext, regionId: number): Promise<SkillResult> {
  const outcome = await context.runtime.unprotectRegion(regionId);
  if (outcome.status === "failed") return { status: "failed", detail: outcome.error };
  const index = context.areas?.findIndex((area) => area.regionId === regionId) ?? -1;
  if (index !== -1) context.areas?.splice(index, 1);
  return { status: "done", detail: `released area #${regionId}: I may dig and place blocks there again` };
}
