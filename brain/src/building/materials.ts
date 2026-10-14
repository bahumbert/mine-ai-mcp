import type { KnownPlace } from "../mind.ts";
import type { BlockKind } from "../runtime-client.ts";
import { billOfMaterials, BUILD_ROLES, STRUCTURAL_ROLES, type BlockRole, type MaterialCount } from "./blueprint.ts";
import { planHouse, type HousePlan, type Materials } from "./plan.ts";
import type { Style } from "./styles.ts";

/** The tag the game gives every door block (`doors`), read from `view_blocks` kinds. */
const DOOR_TAG = "doors";

/**
 * Why `materials` cannot build a house in `style`, from the game's data about each block (`kinds`, by block id as
 * `view_blocks` reports them): one sentence per bad role, null when all are fine. A block the game has no kind for is
 * no block id; the structural roles need a block that fills its cell; a door needs the `doors` tag; a window may be
 * `air` (open windows) or any block.
 */
export function checkMaterials(materials: Materials, style: Style, kinds: Readonly<Record<string, BlockKind>>): string | null {
  const refusals: string[] = [];
  for (const role of BUILD_ROLES) {
    const block = materials[role];
    if (block === undefined || (role === "window" && block === "air")) continue;
    const kind = kinds[block];
    const preferred = `(your style uses ${style.palette[role]})`;
    if (kind === undefined) refusals.push(`${role}: ${block} is no block id ${preferred}.`);
    else if (STRUCTURAL_ROLES.includes(role) && kind.fullCube !== true) refusals.push(`${role}: ${block} is not a full block ${preferred}.`);
    else if (role === "door" && !(kind.tags ?? []).includes(DOOR_TAG)) refusals.push(`${role}: ${block} is not a door ${preferred}.`);
  }
  return refusals.length === 0 ? null : refusals.join(" ");
}

/** The roles whose block is not the style's: what makes a house temporary. */
export function temporaryRoles(materials: Materials, style: Style): BlockRole[] {
  return BUILD_ROLES.filter((role) => materials[role] !== undefined && materials[role] !== style.palette[role]);
}

/** What improving a temporary house takes: the house as it would be, the roles left temporary, and the blocks to bring. */
export interface Improvement {
  readonly after: HousePlan;
  readonly rest: Materials;
  /** The blocks the swap places, per block, most needed first: only the cells whose block changes. */
  readonly bill: readonly MaterialCount[];
}

/** The house `house` describes, with `roles` swapped back to the style's blocks (variants included). */
export function improvement(style: Style, house: Pick<NonNullable<KnownPlace["house"]>, "size" | "door" | "facing" | "materials">, roles: readonly BlockRole[]): Improvement {
  const site = { door: house.door, facing: house.facing };
  const rest = Object.fromEntries(Object.entries(house.materials).filter(([role]) => !roles.includes(role as BlockRole))) as Materials;
  const before = planHouse(style, house.size, site, house.materials);
  const after = planHouse(style, house.size, site, rest);
  const was = new Map(before.cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell.block]));
  const changed = after.cells.filter((cell) => was.get(`${cell.x},${cell.y},${cell.z}`) !== cell.block);
  return { after, rest, bill: billOfMaterials(changed) };
}
