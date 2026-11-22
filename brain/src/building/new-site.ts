// What a new house's site meets before anything is protected or dug: the protected areas in the way and where the nearest
// clear site is, and what the new house would do to the unfinished one on record.
import { describeWay } from "../gathering/fetch-farther.ts";
import { describeSiteBlocker, earlierProtections, overlapsOf } from "../protected-areas.ts";
import type { Position, ProtectedArea } from "../runtime-client.ts";
import type { SkillContext, SkillResult, UnfinishedHouse } from "../skills.ts";
import { groundedDoor, nearestClearSite, SITE_SEARCH, siteBox } from "./house-site.ts";
import type { HousePlan } from "./plan.ts";
import type { Template } from "./templates.ts";

/** What a new house's site meets: a refusal naming the protected areas in the way and where the nearest clear site is, null when it is clear. */
export async function siteRefusal(context: SkillContext, site: { template: Template; plan: HousePlan; what: string; areas: readonly ProtectedArea[]; unfinished: UnfinishedHouse | null | undefined; untracked: string; toward: Position | null; from: Position }): Promise<SkillResult | null> {
  const { template, plan, what, areas, unfinished, untracked, toward, from } = site;
  const blocked = overlapsOf(areas, siteBox(plan));
  if (blocked.length === 0) return null;
  // The unfinished house's own area among the blockers is described with its step already (`describeSiteBlocker`): no second note.
  const ownArea = unfinished !== null && unfinished !== undefined && earlierProtections(context, unfinished.kind, unfinished.site.door, -1, blocked).length > 0;
  const found = nearestClearSite(areas, template, plan.site, toward);
  const clear = found === null ? null : await groundedDoor(context.runtime, found);
  const where = clear === null
    ? `no site clear of protected areas within ${SITE_SEARCH} blocks: ask whoever asked you, or build somewhere else`
    : `the nearest site clear of them has its door ${describeWay(from, clear)}, at ${clear.x} ${clear.y} ${clear.z}: build there with those coordinates, or ask whoever asked you`;
  const houses = { self: context.self, unfinished, places: context.places?.() ?? [], templates: context.templates };
  const blockers = blocked.map((area) => describeSiteBlocker(houses, area)).join("; ");
  return { status: "failed", detail: `the site of ${what} (door at ${plan.site.door.x} ${plan.site.door.y} ${plan.site.door.z}) overlaps ${blockers}${ownArea ? "" : untracked}; ${where}` };
}

/** A new house replaces the record of an unfinished one: the result says so, and where the old house's area stays protected. */
export function replacedHouseNote(context: SkillContext, unfinished: UnfinishedHouse | null | undefined, areas: readonly ProtectedArea[]): string {
  if (unfinished === null || unfinished === undefined) return "";
  const { door } = unfinished.site;
  const held = earlierProtections(context, unfinished.kind, door, -1, areas).map((id) => `#${id}`);
  return `; your unfinished ${unfinished.kind} at ${door.x} ${door.y} ${door.z} is no longer tracked${held.length === 0 ? "" : `; its area ${held.join(", ")} stays protected until released (release_area)`}`;
}
