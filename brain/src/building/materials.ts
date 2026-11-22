import type { KnownPlace } from "../mind.ts";
import type { BlockKind } from "../runtime-client.ts";
import { billOfMaterials, BUILD_ROLES, STRUCTURAL_ROLES, type BlockRole, type MaterialCount, type Variants, type WorldCell } from "./blueprint.ts";
import { planTemplate, type HousePlan, type Materials } from "./plan.ts";
import { shapeVariantsOf } from "./shape-variants.ts";
import type { Template } from "./templates.ts";

/** The tag the game gives every door block (`doors`), read from `view_blocks` kinds. */
const DOOR_TAG = "doors";

/** The roles a house may leave open: any block, or `air` (open windows, no accent or railing). */
const OPEN_ROLES: readonly BlockRole[] = ["window", "accent", "railing"];

/**
 * Why `materials` cannot build `template`, from the game's data about each block (`kinds`, by block id as
 * `view_blocks` reports them): one sentence per bad role, null when all are fine. A block the game has no kind for is
 * no block id; the structural roles need a block that fills its cell; a door needs the `doors` tag; a window, accent or
 * railing may be `air` (open windows) or any block.
 */
export function checkMaterials(materials: Materials, template: Template, kinds: Readonly<Record<string, BlockKind>>): string | null {
  const refusals: string[] = [];
  for (const role of BUILD_ROLES) {
    const block = materials[role];
    if (block === undefined || (OPEN_ROLES.includes(role) && block === "air")) continue;
    const kind = kinds[block];
    const own = template.palette[role];
    const preferred = own === undefined ? "" : ` (this house uses ${own})`;
    if (kind === undefined) refusals.push(`${role}: ${block} is no block id${preferred}.`);
    else if (STRUCTURAL_ROLES.includes(role) && kind.fullCube !== true) refusals.push(`${role}: ${block} is not a full block${preferred}.`);
    else if (role === "door" && !(kind.tags ?? []).includes(DOOR_TAG)) refusals.push(`${role}: ${block} is not a door${preferred}.`);
  }
  return refusals.length === 0 ? null : refusals.join(" ");
}

/**
 * The roles built with a block other than the template's own: what makes a house temporary. A role the template has
 * no block for (a house with no accent, say) is not temporary whatever the step named for it: there is nothing to swap back.
 */
export function temporaryRoles(materials: Materials, template: Template): BlockRole[] {
  return BUILD_ROLES.filter((role) => template.palette[role] !== undefined && materials[role] !== undefined && materials[role] !== template.palette[role]);
}

/** Derives a new house's substitute shapes once; a resumed house uses its saved shapes instead. */
export function shapesForMaterials(template: Template, materials: Materials): Variants {
  return Object.fromEntries(temporaryRoles(materials, template).flatMap((role) => {
    const like = template.variants[role];
    if (like === undefined) return [];
    const shapes = shapeVariantsOf(materials[role]!, like);
    return Object.keys(shapes).length === 0 ? [] : [[role, shapes]];
  }));
}

/** What improving a temporary house takes: the house as it would be, the roles left temporary, and the blocks to bring. */
export interface Improvement {
  readonly after: HousePlan;
  readonly rest: Materials;
  /** The blocks the swap places, per block, most needed first: only the cells whose block changes. */
  readonly bill: readonly MaterialCount[];
  /** The cells whose block changes: what the swap places (the reach check reads their heights). */
  readonly changed: readonly WorldCell[];
}

/** The house `house` describes, with `roles` swapped back to the template's blocks (variants included). */
export function improvement(template: Template, house: Pick<NonNullable<KnownPlace["house"]>, "door" | "facing" | "materials" | "shapes">, roles: readonly BlockRole[]): Improvement {
  const site = { door: house.door, facing: house.facing };
  const rest = Object.fromEntries(Object.entries(house.materials).filter(([role]) => !roles.includes(role as BlockRole))) as Materials;
  const before = planTemplate(template, site, house.materials, house.shapes ?? {});
  const after = planTemplate(template, site, rest, house.shapes ?? {});
  const was = new Map(before.cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell.block]));
  const changed = after.cells.filter((cell) => was.get(`${cell.x},${cell.y},${cell.z}`) !== cell.block);
  return { after, rest, bill: billOfMaterials(changed), changed };
}
