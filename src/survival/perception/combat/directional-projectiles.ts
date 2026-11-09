// Family-based incoming rays for non-arrow projectiles at any candidate body.
import type { Bot } from "mineflayer";
import type { EntityBody } from "../../../world/entity-geometry.js";
import { familyIndexOf } from "../../../world/item-families.js";
import { projectileReachesBody } from "../../positioning/combat/exposure.js";
import { isArrowEntity } from "./arrow-flight.js";

/** Read observed direction only; arrows keep their gravity-aware trajectory solver (P4 review, 2026-11-09). */
export function isIncomingDirectionalProjectile(bot: Bot, entity: Bot["entity"], body: EntityBody): boolean {
  return entity.isValid && !!entity.name && !isArrowEntity(bot, entity) &&
    familyIndexOf(bot).entityFamilies(entity.name).includes("projectile_entity") &&
    projectileReachesBody(bot.world, entity, body);
}
