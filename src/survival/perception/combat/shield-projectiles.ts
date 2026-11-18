import type { EntityBody } from "../../../world/entity-geometry.js";
import type { Bot } from "mineflayer";
import { PROJECTILE_HIT_MARGIN, projectileContact } from "../../positioning/combat/exposure.js";
import { arrowFlight, isArrowEntity } from "./arrow-flight.js";
import { directionalProjectileContact } from "./directional-projectiles.js";
import type { Vec3 } from "vec3";

type Entity = Parameters<Bot["attack"]>[0];

/** Arrows curve under gravity; a straight extension of their launch ray misses future hits. */
export function arrowImpactInTicks(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity): number | null {
  return arrowImpact(bot, arrow, movementAllowance, target)?.ticks ?? null;
}

export function arrowImpact(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity) {
  if (!arrow.isValid || !isArrowEntity(bot, arrow)) return null;
  const keys = bot.registry.entitiesByName[arrow.name]?.metadataKeys ?? [];
  const grounded: unknown = arrow.metadata?.[keys.indexOf("in_ground")];
  const piercing: unknown = arrow.metadata?.[keys.indexOf("pierce_level")];
  if (grounded === true || (typeof piercing === "number" && piercing > 0) || arrow.velocity.norm() === 0) return null;
  const body = {
    position: target.position,
    width: target.width + movementAllowance * 2,
    height: target.height,
  };
  const flight = arrowFlight(bot, arrow);
  let { position, velocity } = flight;
  if (velocity.norm() === 0) return null;
  // The launch overlaps its shooter's body. Candidate cover and a later return still need collision prediction (a11 T1c).
  const launch = flight.ownLaunch;
  if (launch && position.distanceTo(launch.position) <= 1e-6 && velocity.dot(launch.direction) > 0 &&
      target.position.distanceTo(launch.feet) <= 1e-6) return null;
  // Horizontal drag cannot reverse an arrow. Stop once it has passed the
  // body's expanded footprint, fallen below it, or hit terrain, rather than
  // predicting an arbitrary number of ticks into the future.
  const half = body.width / 2 + PROJECTILE_HIT_MARGIN;
  // A reflected arrow can still be inside the expanded hit box. Its zero-
  // distance box intersection is not a new incoming hit. Keep vertical falls.
  const towardX = body.position.x - position.x, towardZ = body.position.z - position.z;
  if (Math.abs(towardX) <= half && Math.abs(towardZ) <= half &&
      position.y >= body.position.y - PROJECTILE_HIT_MARGIN &&
      position.y <= body.position.y + body.height + PROJECTILE_HIT_MARGIN &&
      towardX * velocity.x + towardZ * velocity.z < 0) return null;
  for (let ticks = 0; ; ticks++) {
    const dx = body.position.x - position.x,
      dz = body.position.z - position.z;
    if (
      (Math.abs(dx) > half && dx * velocity.x <= 0) ||
      (Math.abs(dz) > half && dz * velocity.z <= 0) ||
      (position.y < body.position.y - PROJECTILE_HIT_MARGIN && velocity.y <= 0)
    )
      return null;
    const speed = velocity.norm();
    const contact = projectileContact(bot.world, { position, velocity }, body, speed);
    if (contact) return { ticks: ticks + 1, position: contact };
    if (speed > 0 && bot.world.raycast(position, velocity.scaled(1 / speed), speed)) return null;
    position = position.plus(velocity);
    // Same native air drag/gravity as the existing bow trajectory solver.
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
}

export function isIncomingArrow(bot: Bot, arrow: Entity, movementAllowance = 0, target: EntityBody = bot.entity): boolean {
  return arrowImpactInTicks(bot, arrow, movementAllowance, target) !== null;
}

/** Judge a candidate body by the same retained flight or directional contact as the shield. */
export function projectileThreatensBody(bot: Bot, projectile: Entity, movementAllowance: number, body: EntityBody): boolean {
  if (isArrowEntity(bot, projectile)) return isIncomingArrow(bot, projectile, movementAllowance, body);
  return directionalProjectileContact(bot, projectile, { ...body, width: body.width + movementAllowance * 2 }) !== null;
}

/** Shield-facing and retreat admission must consider the same set of blockable shots. */
export function incomingShieldProjectiles(bot: Bot, movementAllowance = 0): Entity[] {
  return assessIncomingShieldProjectiles(bot, movementAllowance).map(({ entity }) => entity);
}

/** Known collision times order each threat class; unknown observations remain in the assessment. */
export function compareImpactTimes(a: { impactInTicks: number | null }, b: { impactInTicks: number | null }): number {
  if (a.impactInTicks === null) return b.impactInTicks === null ? 0 : 1;
  if (b.impactInTicks === null) return -1;
  return a.impactInTicks - b.impactInTicks;
}

/** One contact assessment for shield admission and facing, with ballistic timing only for arrows. */
export function assessIncomingShieldProjectiles(bot: Bot, movementAllowance = 0) {
  const forecasts: { entity: Entity; impactInTicks: number | null; contact: Vec3 }[] = [];
  const body = { ...bot.entity, width: bot.entity.width + movementAllowance * 2 };
  for (const entity of Object.values(bot.entities)) {
    if (!projectileThreatensBody(bot, entity, movementAllowance, bot.entity)) continue;
    if (isArrowEntity(bot, entity)) {
      const impact = arrowImpact(bot, entity, movementAllowance);
      if (impact) forecasts.push({ entity, impactInTicks: impact.ticks, contact: impact.position });
    } else {
      const contact = directionalProjectileContact(bot, entity, body);
      // The observed bearing is where the shield must face; an offset ray's entry
      // into our expanded body can lie on a different side (EyesBot crossfire).
      if (contact) forecasts.push({ entity, impactInTicks: null, contact: entity.position.clone() });
    }
  }
  return forecasts.sort((a, b) => compareImpactTimes(a, b) ||
    (a.impactInTicks === null && b.impactInTicks === null
      // Order unknown shots by observed motion, then proximity, without claiming an arrival time.
      ? b.entity.velocity.norm() - a.entity.velocity.norm() ||
        a.entity.position.distanceTo(bot.entity.position) - b.entity.position.distanceTo(bot.entity.position) : 0));
}
