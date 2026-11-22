// `abandon_house`: giving up the unfinished house for good (plan 2026-11-09-house-templates Task 4c).
import { earlierProtections, ownLevelingOver } from "../protected-areas.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { releaseArea } from "../skills/protect-area.ts";

/**
 * Gives up the unfinished house for good: its record is forgotten and the areas that protect it are released (the
 * region of the house, and any leveling region of hers left over it), so the site is free for a new house. What
 * stands stays. A release that fails (or a body that is down: it throws) keeps the record, so the same step asks again.
 */
export async function abandonHouse(context: SkillContext): Promise<SkillResult> {
  const unfinished = context.building?.unfinished;
  if (context.building === undefined || unfinished === null || unfinished === undefined) return { status: "failed", detail: "you have no unfinished house to give up" };
  const { door } = unfinished.site;
  const regions = await context.runtime.protectedRegions();
  const house = earlierProtections(context, unfinished.kind, door, -1, regions);
  const around = regions.filter((area) => house.includes(area.regionId));
  const leveling = [...new Set(around.flatMap((held) => ownLevelingOver(context, regions, held).map((area) => area.regionId)))];
  // Leveling regions first: they are found through the house region, so a retry after a release that failed still finds them.
  const released: number[] = [];
  for (const regionId of [...leveling, ...house]) {
    const outcome = await releaseArea(context, regionId);
    if (outcome.status === "failed") return { status: "failed", detail: `could not release area #${regionId}: ${outcome.detail}; your unfinished ${unfinished.kind} is still on record: abandon_house again` };
    released.push(regionId);
  }
  context.building.unfinished = null;
  context.saveBuilding?.();
  const areas = released.sort((a, b) => a - b).map((regionId) => `#${regionId}`).join(", ");
  return { status: "done", detail: `gave up your unfinished ${unfinished.kind} at ${door.x} ${door.y} ${door.z}: it is no longer tracked${released.length === 0 ? "" : ` and its area${released.length === 1 ? "" : "s"} ${areas} ${released.length === 1 ? "is" : "are"} released`}; what stands stays` };
}
