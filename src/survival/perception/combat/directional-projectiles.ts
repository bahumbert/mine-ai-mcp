// Family-based incoming rays for non-arrow projectiles at any candidate body.
import type { Bot } from "mineflayer";
import type { EntityBody } from "../../../world/entity-geometry.js";
import { familyIndexOf } from "../../../world/item-families.js";
import { projectileContact } from "../../positioning/combat/exposure.js";
import { isArrowEntity } from "./arrow-flight.js";

/** Read observed direction only; arrows keep their gravity-aware trajectory solver (P4 review, 2026-11-09). */
export function isIncomingDirectionalProjectile(bot: Bot, entity: Bot["entity"], body: EntityBody): boolean {
  return directionalProjectileContact(bot, entity, body) !== null;
}

/** Keep the observed non-arrow contact without inventing its future speed or acceleration. */
export function directionalProjectileContact(bot: Bot, entity: Bot["entity"], body: EntityBody) {
  if (!entity.isValid || !entity.name || isArrowEntity(bot, entity) ||
      !familyIndexOf(bot).entityFamilies(entity.name).includes("projectile_entity") ||
      !Number.isFinite(entity.velocity.norm())) return null;
  const contact = projectileContact(bot.world, entity, body);
  if (!contact) return null;
  const toward = body.position.minus(entity.position);
  if (contact.distanceTo(entity.position) === 0 && toward.x * entity.velocity.x + toward.z * entity.velocity.z < 0)
    return null;
  return contact;
}
