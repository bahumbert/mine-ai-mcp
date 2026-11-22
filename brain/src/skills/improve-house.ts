// Swapping the temporary parts of her own house for the template's blocks (improve_house).
import type { Step } from "../actions.ts";
import { FACING_VECTOR, type BlockRole, type MaterialCount } from "../building/blueprint.ts";
import { houseBox } from "../building/house-site.ts";
import { improvement } from "../building/materials.ts";
import { builderStand, type HousePlan, type Materials } from "../building/plan.ts";
import { describeShortfall, fetchClause, inPlaceWorks, scaffoldNeed, scaffoldReserve } from "../building/stage-progress.ts";
import { templateOfHouse, type Template } from "../building/templates.ts";
import { remadeClause } from "../building/tool-loss.ts";
import { withMaterialsKept } from "../gathering/gather-materials.ts";
import type { KnownPlace } from "../mind.ts";
import { billShortfall } from "../relations/items.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { walkKeeping } from "../walks.ts";
import { noted } from "./build-house.ts";
import { buildParts } from "./house-parts.ts";
import { noteArea } from "./protected-areas.ts";

/**
 * Swaps the temporary parts of its own house for the template's blocks, in place: the house's cells are sent again with
 * the template's blocks in those roles, and `build_structure` digs the wrong block of a cell and places the right one
 * (cells already right are skipped), so an interrupted swap is simply asked again.
 */
export async function improveHouse(context: SkillContext, step: Extract<Step, { skill: "improve_house" }>): Promise<SkillResult> {
  const place = context.ownHouse?.() ?? null;
  const house = place?.house;
  if (place === null || house === undefined || Object.keys(house.materials).length === 0) return { status: "failed", detail: "you have no temporary house of your own to improve" };
  const template = templateOfHouse(house, context.templates);
  if (template === undefined) return { status: "failed", detail: `${place.name} is no longer a house you know how to build: its temporary parts stay as they are` };
  const temporary = Object.keys(house.materials) as BlockRole[];
  const roles = step.roles ?? temporary;
  const notTemporary = roles.filter((role) => !temporary.includes(role));
  if (notTemporary.length > 0) return { status: "failed", detail: `your house is not temporary in ${notTemporary.join(", ")}: its temporary parts are ${temporary.join(", ")}` };
  const { after, rest, bill, changed } = improvement(template, house, roles);
  const kind = template.kind;
  const what = `your ${kind}`;
  const snapshot = await context.runtime.status();
  const { missing, owedNote } = billShortfall(bill, snapshot.inventory, context.owed?.() ?? []);
  // A roof swapped in place is reached the same way a roof built is: from the ground, by the routes' scaffold.
  const scaffold = scaffoldNeed(inPlaceWorks(after, changed), house.door.y, snapshot.inventory, snapshot.policy?.scaffoldBlocks, bill.map((entry) => entry.item));
  if (missing.length > 0 || scaffold !== null) return { status: "failed", detail: `missing ${describeShortfall({ missing, scaffold })} to improve ${what} (the rest is carried${owedNote === "" ? "" : `; ${owedNote}`}): ${fetchClause({ missing, scaffold })}, then improve again` };
  const { x, y, z } = house.door;
  context.progress?.(`walking to ${what} at ${x} ${y} ${z}`);
  const there = await walkKeeping(context, builderStand(after.site), `Walk to ${what}.`, { items: bill.map((entry) => entry.item), reserve: [], scaffold: scaffoldReserve(inPlaceWorks(after, changed), house.door.y, snapshot.policy?.scaffoldBlocks, bill.map((entry) => entry.item)) }, bill);
  if (context.signal.aborted) return { status: "stopped" };
  if (there.status !== "succeeded") return { status: "failed", detail: `could not reach ${what} at ${x} ${y} ${z}: ${there.error ?? there.status}` };
  return withMaterialsKept(context.runtime, bill.map((entry) => entry.item), () => improveOnSite(context, { place, house, template, roles, after, rest, bill, kind, what }));
}

/** What {@link improveHouse} worked out before the house is protected and improved. */
interface ImprovePlan {
  readonly place: KnownPlace;
  readonly house: NonNullable<KnownPlace["house"]>;
  readonly template: Template;
  readonly roles: readonly BlockRole[];
  readonly after: HousePlan;
  readonly rest: Materials;
  readonly bill: readonly MaterialCount[];
  readonly kind: string;
  readonly what: string;
}

/** {@link improveHouse} from the protection of the house to the end. */
async function improveOnSite(context: SkillContext, { place, house, template, roles, after, rest, bill, kind, what }: ImprovePlan): Promise<SkillResult> {
  // Protected again under the same label (the runtime keeps one region per box), as a build does.
  const protection = await context.runtime.protectRegion({
    ...houseBox(after.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am improving.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  const claim = house.claim;
  const [fx, fz] = FACING_VECTOR[claim?.facing ?? house.facing];
  const keepAlways = claim === undefined ? [] : [claim.position, claim.attach === "wall"
    ? { ...claim.position, x: claim.position.x - fx, z: claim.position.z - fz }
    : { ...claim.position, y: claim.position.y - 1 }];
  const remadeNotes: { readonly item: string; readonly note: string }[] = [];
  const stopped = await buildParts(context, after, what, { reserved: bill, keepAlways, leave: () => undefined, again: "; improve your house again", remadeNotes });
  if (stopped !== null) return noted(stopped, remadeClause(remadeNotes));
  context.remember?.({ ...place, house: { ...house, materials: rest } });
  const swapped = roles.map((role) => template.palette[role] ?? "nothing"); // a role the house has no block for has nothing to swap back
  const still = Object.entries(rest).map(([role, block]) => `${role} ${block}`).join(", ");
  return { status: "done", detail: `improved ${what}: ${roles.join(", ")} now ${swapped.join(", ")}${still === "" ? "" : `; still temporary: ${still}`}${remadeClause(remadeNotes)}` };
}
