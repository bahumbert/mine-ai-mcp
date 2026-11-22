// Swapping the temporary parts of her own house for the style's blocks (improve_house).
import type { Step } from "../actions.ts";
import { describeMaterials, FACING_VECTOR, shortfall, type BlockRole, type MaterialCount } from "../building/blueprint.ts";
import { improvement } from "../building/materials.ts";
import { builderStand, styleOrDefault, type HousePlan, type Materials } from "../building/plan.ts";
import { withMaterialsKept } from "../gathering/gather-materials.ts";
import type { KnownPlace } from "../mind.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { houseBox } from "./build-house.ts";
import { buildParts } from "./house-parts.ts";
import { navigateInput } from "./positions.ts";
import { noteArea } from "./protected-areas.ts";

/**
 * Swaps the temporary parts of its own house for the style's blocks, in place: the house's cells are sent again with
 * the style's blocks in those roles, and `build_structure` digs the wrong block of a cell and places the right one
 * (cells already right are skipped), so an interrupted swap is simply asked again.
 */
export async function improveHouse(context: SkillContext, step: Extract<Step, { skill: "improve_house" }>): Promise<SkillResult> {
  const place = context.ownHouse?.() ?? null;
  const house = place?.house;
  if (place === null || house === undefined || Object.keys(house.materials).length === 0) return { status: "failed", detail: "you have no temporary house of your own to improve" };
  const style = styleOrDefault(house.style);
  const temporary = Object.keys(house.materials) as BlockRole[];
  const roles = step.roles ?? temporary;
  const notTemporary = roles.filter((role) => !temporary.includes(role));
  if (notTemporary.length > 0) return { status: "failed", detail: `your house is not temporary in ${notTemporary.join(", ")}: its temporary parts are ${temporary.join(", ")}` };
  const { after, rest, bill } = improvement(style, house, roles);
  const kind = `${house.size} ${style.id} house`;
  const what = `your ${kind}`;
  const snapshot = await context.runtime.status();
  const missing = shortfall(bill, snapshot.inventory);
  if (missing.length > 0) return { status: "failed", detail: `missing ${describeMaterials(missing)} to improve ${what} (the rest is carried): fetch exactly the missing items with get_items, then improve again` };
  const { x, y, z } = house.door;
  context.progress?.(`walking to ${what} at ${x} ${y} ${z}`);
  const there = await context.body.act("navigate", navigateInput(builderStand(after.site), 1), `Walk to ${what}.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (there.status !== "succeeded") return { status: "failed", detail: `could not reach ${what} at ${x} ${y} ${z}: ${there.error ?? there.status}` };
  return withMaterialsKept(context.runtime, bill.map((entry) => entry.item), () => improveOnSite(context, { place, house, style, roles, after, rest, bill, kind, what }));
}

/** What {@link improveHouse} worked out before the house is protected and improved. */
interface ImprovePlan {
  readonly place: KnownPlace;
  readonly house: NonNullable<KnownPlace["house"]>;
  readonly style: ReturnType<typeof styleOrDefault>;
  readonly roles: readonly BlockRole[];
  readonly after: HousePlan;
  readonly rest: Materials;
  readonly bill: readonly MaterialCount[];
  readonly kind: string;
  readonly what: string;
}

/** {@link improveHouse} from the protection of the house to the end. */
async function improveOnSite(context: SkillContext, { place, house, style, roles, after, rest, bill, kind, what }: ImprovePlan): Promise<SkillResult> {
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
  const stopped = await buildParts(context, after, what, { reserved: bill, keepAlways, leave: () => undefined, again: "; improve your house again" });
  if (stopped !== null) return stopped;
  context.remember?.({ ...place, house: { ...house, materials: rest } });
  const swapped = roles.map((role) => style.palette[role]);
  const still = Object.entries(rest).map(([role, block]) => `${role} ${block}`).join(", ");
  return { status: "done", detail: `improved ${what}: ${roles.join(", ")} now ${swapped.join(", ")}${still === "" ? "" : `; still temporary: ${still}`}` };
}
