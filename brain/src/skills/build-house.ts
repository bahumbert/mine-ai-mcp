// Building a house from the persona's style (build): the site, its protection and leveling, then the parts.
import type { Step } from "../actions.ts";
import { describeMaterials, shortfall } from "../building/blueprint.ts";
import { checkMaterials } from "../building/materials.ts";
import { builderStand, chooseSite, planHouse, siteAt, styleOrDefault, type HousePlan, type Site } from "../building/plan.ts";
import type { HouseSize } from "../building/house.ts";
import { levelBox } from "../building/terrain.ts";
import { describeWay } from "../gathering/fetch-farther.ts";
import { withMaterialsKept } from "../gathering/gather-materials.ts";
import { areaKey, type BotRuntime, type Position, type ProtectedArea } from "../runtime-client.ts";
import type { SkillContext, SkillResult, UnfinishedHouse } from "../skills.ts";
import { buildParts } from "./house-parts.ts";
import { levelZone } from "./level-zone.ts";
import { distanceBetween, findPlayer, navigateInput } from "./positions.ts";
import { releaseArea } from "./protect-area.ts";
import { describeOverlaps, nearestClearSpot, noteArea, overlapsOf, SITE_SEARCH } from "./protected-areas.ts";

/** An unfinished house is resumed only by a build step this close to its door; farther away a new one is started. */
export const RESUME_RANGE = 6;

/**
 * Builds a house from the persona's style where the bot stands, facing the requester, with carried blocks only (the
 * model fetches them first with `get_items`); one `build_structure` call per batch. A house left unfinished (a cell
 * refused, the step set aside) is finished at the same site by the next build of the same kind.
 */
export async function build(context: SkillContext, step: Extract<Step, { skill: "build" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  const style = styleOrDefault(context.style);
  const kind = `${step.size} ${style.id} house`;
  const what = `a ${kind}`;
  // The unfinished house is resumed where it stands; asked to build somewhere else, she starts a new one (live
  // 2026-10-02: "change of plan, build it right here" resumed the old pond-side site).
  // At given coordinates (its door), wherever she happens to stand (live 2026-10-02: asked for a house at a place,
  // she walked to a crafting table for the materials and built where the table was).
  const at = step.x !== undefined && step.y !== undefined && step.z !== undefined ? { x: step.x, y: step.y, z: step.z } : null;
  const unfinished = context.building?.unfinished;
  const resumed = unfinished?.kind === kind && distanceBetween(at ?? snapshot.position, unfinished.site.door) <= RESUME_RANGE ? unfinished : null;
  // Her own house has no asker to face or to name (an ordered house is the asker's unless the step says `own`).
  const own = step.own === true || context.requester === undefined;
  const toward = own || context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  // A resumed house keeps the materials it was started with; the step's are ignored then.
  const materials = resumed === null ? step.materials ?? {} : resumed.materials ?? {};
  if (resumed === null && Object.keys(materials).length > 0) {
    const refusal = checkMaterials(materials, style, await context.runtime.blockKinds(Object.values(materials).filter((block) => block !== "air")));
    if (refusal !== null) return { status: "failed", detail: `cannot build ${what} with those materials: ${refusal}` };
  }
  const plan = planHouse(style, step.size, resumed?.site ?? (at === null ? chooseSite(snapshot.position, toward) : siteAt(at, toward)), materials);
  if (resumed === null) {
    // A new site clear of every protected area before anything is protected or dug, and if not, where the nearest
    // clear one is (live 2026-10-03: told only "choose another zone clear of it", she stepped one block at a time,
    // and each refused start left its site protected for good: 16 house boxes, most of them never built).
    const areas = await context.runtime.protectedRegions();
    const blocked = overlapsOf(areas, siteBox(plan));
    if (blocked.length > 0) {
      const found = nearestClearSite(areas, style, step.size, plan.site, toward);
      const clear = found === null ? null : await groundedDoor(context.runtime, found);
      const where = clear === null
        ? `no site clear of protected areas within ${SITE_SEARCH} blocks: ask whoever asked you, or build somewhere else`
        : `the nearest site clear of them has its door ${describeWay(snapshot.position, clear)}, at ${clear.x} ${clear.y} ${clear.z}: build there with those coordinates, or ask whoever asked you`;
      return { status: "failed", detail: `the site of ${what} (door at ${plan.site.door.x} ${plan.site.door.y} ${plan.site.door.z}) ${describeOverlaps(context, blocked)}; ${where}` };
    }
    const missing = shortfall(plan.bill, snapshot.inventory);
    // Only what is missing, named as the step that fetches it: get_items adds to what she carries, so asking for the
    // whole bill fetched it twice and filled her inventory (live 2026-10-02).
    if (missing.length > 0) return { status: "failed", detail: `missing ${describeMaterials(missing)} for ${what} (the rest is carried): fetch exactly the missing items with get_items, then build again` };
  }
  if (at !== null) {
    const stand = builderStand(plan.site);
    context.progress?.(`walking to the site of ${what} at ${at.x} ${at.y} ${at.z}`);
    const there = await context.body.act("navigate", navigateInput(stand, 1), `Walk to the site of ${what}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (there.status !== "succeeded") return { status: "failed", detail: `could not reach the site of ${what} at ${at.x} ${at.y} ${at.z}: ${there.error ?? there.status}` };
  }
  // The bill is not scaffolding while the house is built: the walks of the site's leveling used the very blocks it needs
  // (live 2026-10-04: 16 of 36 cobblestone).
  return withMaterialsKept(context.runtime, plan.bill.map((entry) => entry.item), () => buildOnSite(context, { step, kind, what, style, own, resumed, plan }));
}

/** What {@link build} worked out before the house is protected and built. */
interface SitePlan {
  readonly step: Extract<Step, { skill: "build" }>;
  readonly kind: string;
  readonly what: string;
  readonly style: ReturnType<typeof styleOrDefault>;
  readonly own: boolean;
  readonly resumed: UnfinishedHouse | null;
  readonly plan: HousePlan;
}

/** {@link build} from the protection of the site to the end. */
async function buildOnSite(context: SkillContext, { step, kind, what, style, own, resumed, plan }: SitePlan): Promise<SkillResult> {
  // Protected before the first block and again on every resume (the runtime keeps one region per box): its own
  // gathering and goals must not dig into the house (ADR-012). The build itself still works inside it.
  const protection = await context.runtime.protectRegion({
    ...houseBox(plan.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am building.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect the site of ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  const leaveUnfinished = (part: number, prepared = true, refused = resumed?.refused) => {
    if (context.building !== undefined) context.building.unfinished = { kind, site: plan.site, part, prepared, materials: plan.materials, ...(refused !== undefined && refused.length > 0 && { refused }) };
  };
  // The site first, the first time only: everything above the floor in the house's box dug, holes under it filled, so
  // no part meets terrain, water or loose stone (live 2026-10-01/02).
  if (resumed === null || resumed.prepared === false) {
    const unprepared = await prepareHouseSite(context, { plan, kind, what }, protection.area.regionId, leaveUnfinished);
    if (unprepared !== null) return unprepared;
  }
  const stopped = await buildParts(context, plan, what, {
    reserved: plan.bill,
    leave: (part, refused) => leaveUnfinished(part, true, refused),
    refusedBefore: resumed?.refused,
    again: context.building === undefined ? "" : "; building it again resumes it there",
    abandon: () => { if (context.building !== undefined) context.building.unfinished = null; },
  });
  if (stopped !== null) return stopped;
  if (context.building !== undefined) context.building.unfinished = null;
  const { door, facing } = plan.site;
  const roof = plan.roofTop;
  context.remember?.({
    name: `the ${kind} you built${own ? "" : ` for ${context.requester}`}`,
    detail: `door ${door.x} ${door.y} ${door.z} facing ${facing}; stand on its roof at ${roof.x} ${roof.y} ${roof.z}`,
    ...(own && { own: true }),
    house: { size: step.size, style: style.id, door, facing, materials: plan.materials },
  });
  return { status: "done", detail: `built ${what}, door at ${door.x} ${door.y} ${door.z} facing ${facing}` };
}

/** Levels the site of a house about to be built; null when it is ready, else the result that ends the build. */
async function prepareHouseSite(context: SkillContext, { plan, kind, what }: Pick<SitePlan, "plan" | "kind" | "what">, regionId: number, leaveUnfinished: (part: number, prepared: boolean) => void): Promise<SkillResult | null> {
  const box = houseBox(plan.batches.flat());
  // Clearing and levelling the site is reshaping ground, not building (spec 2026-10-04-activity-time-travel-terraforming).
  context.phase?.("terraforming");
  const prepared = await levelZone(context, { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }, plan.site.door.y, `the site of ${what}`, {
    // Blocks do not fall: a house needs its ring level and the water above its floor gone, not a pond filled under
    // it (live 2026-10-02: 258 cobblestone mined for a site over a pond). Its own floor goes in even over water.
    below: 1,
    placedLater: new Set(plan.batches.flat().filter((cell) => cell.block !== "air").map((cell) => `${cell.x},${cell.y},${cell.z}`)),
  }, plan.bill, [regionId, ...earlierProtections(context, kind, plan.site.door, regionId, await context.runtime.protectedRegions())]);
  // Nothing of the house stands yet: its site is not kept protected (a resume protects it again).
  if (prepared.status === "stopped" || context.signal.aborted) {
    leaveUnfinished(0, false);
    await releaseArea(context, regionId);
    return { status: "stopped" };
  }
  if (prepared.status === "failed") {
    await releaseArea(context, regionId);
    // A site another protected area overlaps cannot be prepared later either: the unfinished house is forgotten, not
    // offered again and again (live 2026-10-07: Ayla's unfinished house overlapped her other house #12; she went
    // back to it, protected a "temp_house" over it, and tried again).
    if (/overlaps protected area/u.test(prepared.detail)) {
      if (context.building !== undefined) context.building.unfinished = null;
      return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}; that unfinished house is given up: build a new one somewhere clear` };
    }
    leaveUnfinished(0, false);
    return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}` };
  }
  context.phase?.("building");
  return null;
}

/**
 * Her own earlier protections of this same house: a region of hers, with its label, around its door (live 2026-10-04:
 * resuming her unfinished house, its site was refused for overlapping #12, the same house protected before with a
 * slightly different box). Read from the runtime, not from what this session learnt: after a restart the old box is
 * still there, and it is hers all the same.
 */
function earlierProtections(context: SkillContext, label: string, door: Position, current: number, areas: readonly ProtectedArea[]): number[] {
  return areas.filter((area) =>
    area.regionId !== current && area.owner === context.self && area.label === label &&
    door.x >= area.min.x - 1 && door.x <= area.max.x + 1 && door.z >= area.min.z - 1 && door.z <= area.max.z + 1,
  ).map((area) => area.regionId);
}

/** Everything a new house touches: its protected box and the box its site leveling digs and fills. */
function siteBox(plan: ReturnType<typeof planHouse>): { readonly min: Position; readonly max: Position } {
  const house = houseBox(plan.batches.flat());
  const level = levelBox({ minX: house.min.x, maxX: house.max.x, minZ: house.min.z, maxZ: house.max.z }, plan.site.door.y);
  return {
    min: { x: house.min.x, y: Math.min(house.min.y, level.min.y), z: house.min.z },
    max: { x: house.max.x, y: Math.max(house.max.y, level.max.y), z: house.max.z },
  };
}

/**
 * The door of the nearest house site, at the same height, whose house and leveling overlap no protected area, as
 * `build` at those coordinates would plan it (facing whoever it is for); null when none lies within
 * {@link SITE_SEARCH} blocks. Geometry only: the ground there is leveled by the build as usual.
 */
function nearestClearSite(areas: readonly ProtectedArea[], style: ReturnType<typeof styleOrDefault>, size: HouseSize, refused: Site, toward: Position | null): Position | null {
  // One plan per facing, then moved: the box of a door elsewhere is the same box shifted.
  const boxes = new Map<string, { readonly min: Position; readonly max: Position }>();
  const boxFor = (door: Position) => {
    const facing = siteAt(door, toward).facing;
    let box = boxes.get(facing);
    if (box === undefined) {
      box = siteBox(planHouse(style, size, { door: refused.door, facing }));
      boxes.set(facing, box);
    }
    const [dx, dz] = [door.x - refused.door.x, door.z - refused.door.z];
    return { min: { x: box.min.x + dx, y: box.min.y, z: box.min.z + dz }, max: { x: box.max.x + dx, y: box.max.y, z: box.max.z + dz } };
  };
  return nearestClearSpot(areas, refused.door, boxFor);
}

/** How far above and below a suggested site the ground of its column is looked for. */
const GROUND_SEARCH = 16;

/**
 * `door` moved to the walking level of its column: the feet cell over the highest solid block (leaves are not ground)
 * within {@link GROUND_SEARCH} of its height, as the walk to the site needs a cell to stand on (live 2026-10-11: a
 * door suggested at 70 over ground at 66, and the `go to` there failed NAVIGATION_TARGET_UNSUPPORTED). Unchanged when
 * the column shows no ground in that range.
 */
async function groundedDoor(runtime: BotRuntime, door: Position): Promise<Position> {
  const area = await runtime.blocksIn({ x: door.x, y: door.y - GROUND_SEARCH, z: door.z }, { x: door.x, y: door.y + GROUND_SEARCH, z: door.z });
  const solid = (y: number) => {
    const block = area.blocks.get(areaKey(door.x, y, door.z));
    return block !== undefined && !block.endsWith("_leaves") && area.kinds[block]?.solid === true;
  };
  for (let y = door.y + GROUND_SEARCH; y >= door.y - GROUND_SEARCH; y -= 1) {
    if (solid(y)) return { ...door, y: y + 1 };
  }
  return door;
}

/**
 * A house's protected box: its cells, a one-block ring around them and the layer under them, so gathering beside it
 * cannot undermine a wall or take the doorstep (live 2026-10-01: dirt dug under Tom's doorway).
 */
export function houseBox(cells: readonly Position[]): { readonly min: Position; readonly max: Position } {
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const zs = cells.map((cell) => cell.z);
  return {
    min: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, z: Math.min(...zs) - 1 },
    max: { x: Math.max(...xs) + 1, y: Math.max(...ys), z: Math.max(...zs) + 1 },
  };
}
