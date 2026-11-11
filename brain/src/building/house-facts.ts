// What the agent tells the model about its houses, read from the templates: an unfinished house's bill, its own small house, a temporary house's roles.
import type { KnownPlace } from "../mind.ts";
import type { OpportunityFacts } from "../opportunities.ts";
import type { Position } from "../runtime-client.ts";
import { BUILD_ROLES, shortfall, type MaterialCount } from "./blueprint.ts";
import { improvement, temporaryRoles } from "./materials.ts";
import { chooseSite, planTemplate, type HousePlan, type Materials, type Site } from "./plan.ts";
import { classicTemplate, templateOfHouse } from "./templates.ts";

type Inventory = readonly { readonly name: string; readonly count: number }[];

/** The item kinds an unfinished house is built of; none for a house nobody has a template for any more (never throws: read every step). */
export function houseBillItems(house: { readonly template?: string; readonly kind?: string; readonly site: Site; readonly materials?: Materials } | null): string[] {
  const template = house === null ? undefined : templateOfHouse(house);
  return house === null || template === undefined ? [] : planTemplate(template, house.site, house.materials ?? {}).bill.map((entry) => entry.item);
}

/** The persona's own small house: its classic template at the style it likes (none shipped: no small house to tell about). */
export function ownSmallHouse(style: string | undefined, position: Position): HousePlan | null {
  const template = classicTemplate(style, "small");
  return template === undefined ? null : planTemplate(template, chooseSite(position, null));
}

/** What a house is made of: its cells per role (air excluded), in the order of the roles. */
export function rolesOf(plan: HousePlan | null): OpportunityFacts["smallHouse"] {
  const cells = plan?.cells ?? [];
  return BUILD_ROLES.map((role) => ({ role, count: cells.filter((cell) => cell.role === role && cell.block !== "air").length })).filter((entry) => entry.count > 0);
}

/** A temporary house's door, its temporary roles and what improving them needs beyond `inventory`; null for a house nobody has a template for any more (nothing to swap back). */
export function temporaryHouseLack(house: NonNullable<KnownPlace["house"]>, inventory: Inventory): { door: Position; roles: NonNullable<OpportunityFacts["temporaryHouse"]>["roles"]; missing: MaterialCount[] } | null {
  const template = templateOfHouse(house);
  if (template === undefined) return null;
  const roles = temporaryRoles(house.materials, template);
  return {
    door: house.door,
    // temporaryRoles names only roles the template has a block for and the materials name one for.
    roles: roles.map((role) => ({ role, block: house.materials[role]!, own: template.palette[role]! })),
    missing: shortfall(improvement(template, house, roles).bill, inventory),
  };
}
