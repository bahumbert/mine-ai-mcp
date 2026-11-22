import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { HORIZONTAL_TICKS_PER_BLOCK, hasSupportedCorridor, knockbackCorridorHazard, type Goal, type KnockbackHazard, type WorldView } from "../../navigation/index.js";
import { isOpenFallCell, navigationFeet } from "../../navigation/world/block-geometry.js";
import { obstaclesOf, worldViewRaycaster } from "../../navigation/world/line-of-sight.js";
import type { Position3 } from "../../utils/index.js";
import { STANDING_EYE_HEIGHT, observedEyeHeight } from "../../world/block-visibility.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { exposedBodyFrom } from "../../world/entity-geometry.js";
import { hasItemFamily } from "../../world/item-families.js";
import { hasExposedBody } from "../../world/entity-visibility.js";
import { canBeBystander, isHostile } from "../perception/combat/threats.js";
import { MELEE_RANGE, readCombatItems } from "./equipment.js";

type Entity = Parameters<Bot["attack"]>[0];

/** Reach is measured from the player's eyes to the target's body, including a jumping body's lower face. */
export function meleeDistance(bot: Bot, entity: Entity): number {
  return distanceToBody(
    bot.entity.position,
    { position: entity.position, ...entityDimensions(bot, entity) },
    observedEyeHeight(bot.entity),
  );
}

/** Nearby bodies separated by terrain cannot attack one another. */
export function canMeleeTarget(bot: Bot, entity: Entity): boolean {
  return meleeDistance(bot, entity) <= MELEE_RANGE && hasExposedBody(bot, entity);
}

/** A jumping cube's temporary height is not a ledge to climb onto. */
function airborneCube(bot: Bot, entity: Entity): boolean {
  if (entity.name !== "magma_cube" && entity.name !== "slime") return false;
  const { width } = entityDimensions(bot, entity);
  for (let x = Math.floor(entity.position.x - width / 2); x <= Math.floor(entity.position.x + width / 2); x++)
    for (let z = Math.floor(entity.position.z - width / 2); z <= Math.floor(entity.position.z + width / 2); z++) {
      const block = bot.blockAt(entity.position.clone().set(x, entity.position.y - 0.01, z));
      if (!block || block.boundingBox !== "empty") return false;
    }
  return true;
}

export function waitingForDescendingCube(bot: Bot, entity: Entity): boolean {
  if (entity.position.y <= bot.entity.position.y || !airborneCube(bot, entity)) return false;
  const { width } = entityDimensions(bot, entity);
  const dx = Math.max(0, Math.abs(entity.position.x - bot.entity.position.x) - width / 2);
  const dz = Math.max(0, Math.abs(entity.position.z - bot.entity.position.z) - width / 2);
  return Math.hypot(dx, dz) <= MELEE_RANGE && meleeDistance(bot, entity) > MELEE_RANGE;
}

/**
 * A body over open cells: every cell under its footprint is one a fall crosses in the planning view, so water, lava and
 * a floor all say "not airborne". Unobserved cells are not open. The body's species does not matter.
 */
export function airborneBody(world: WorldView, entity: Entity, width: number): boolean {
  const y = Math.floor(entity.position.y - 0.01);
  for (let x = Math.floor(entity.position.x - width / 2); x <= Math.floor(entity.position.x + width / 2); x++)
    for (let z = Math.floor(entity.position.z - width / 2); z <= Math.floor(entity.position.z + width / 2); z++)
      if (!isOpenFallCell(world.blockAt(x, y, z))) return false;
  return true;
}

/**
 * A bot with no bow cannot climb to a body hovering over open cells and above its reach, and the body comes down
 * by itself (a mob mid-jump, a blaze changing height); the bot holds under it, shield up, and the quarry clock
 * of the fight bounds the wait. A mob on a fence top or in a cobweb counts as airborne here: held, bounded by the same clock.
 */
export function waitingForDescendingBody(bot: Bot, world: WorldView, entity: Entity): boolean {
  if (entity.position.y <= bot.entity.position.y) return false;
  const { width } = entityDimensions(bot, entity);
  if (!airborneBody(world, entity, width)) return false;
  const dx = Math.max(0, Math.abs(entity.position.x - bot.entity.position.x) - width / 2);
  const dz = Math.max(0, Math.abs(entity.position.z - bot.entity.position.z) - width / 2);
  return Math.hypot(dx, dz) <= MELEE_RANGE && meleeDistance(bot, entity) > MELEE_RANGE;
}

export function distanceToBody(
  feet: Position3,
  body: { position: Position3; width: number; height: number },
  eyeHeight = STANDING_EYE_HEIGHT,
): number {
  const eyeY = feet.y + eyeHeight;
  const dx = Math.max(0, Math.abs(body.position.x - feet.x) - body.width / 2);
  const dz = Math.max(0, Math.abs(body.position.z - feet.z) - body.width / 2);
  const dy = Math.max(0, body.position.y - eyeY, eyeY - body.position.y - body.height);
  return Math.hypot(dx, dy, dz);
}

/** The approach and swing must agree on reach, including targets above or below a ledge. */
export function meleeApproachGoal(
  bot: Bot, targetId: number, world: WorldView, attackers?: () => readonly Position3[],
  options: { readonly hovering?: boolean } = {},
): Goal {
  const rays = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z), x, z));
  return {
    resolve(observation) {
      const entity = bot.entities[targetId];
      if (!entity?.isValid) return { kind: "invalid", observation: `Entity ${targetId} is not currently observed.` };
      const body = { position: entity.position.clone(), ...entityDimensions(bot, entity) };
      const contacts = attackers?.() ?? (isHostile(entity) ? [body.position] : []);
      // Approach the horizontal footprint of a hopping cube, or of any airborne body when the bot has no bow
      // (`hovering`). The controller waits behind its shield until the real body descends into swing reach.
      if (body.position.y > observation.position.y &&
        (airborneCube(bot, entity) || (options.hovering === true && airborneBody(world, entity, body.width))))
        body.position.y = observation.position.y;
      const current = navigationFeet(observation.position, observation.stance === "supported");
      const eyeHeight = observedEyeHeight(bot.entity);
      const positionAt = (feet: Position3) =>
        feet.x === current.x && feet.y === current.y && feet.z === current.z
          ? observation.position
          : { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      const distanceAt = (feet: Position3) => {
        const position = positionAt(feet);
        return distanceToBody(position, body, position === observation.position ? eyeHeight : STANDING_EYE_HEIGHT);
      };
      return {
        kind: "active",
        revision: `melee:${targetId}:${body.position}:${body.width}:${body.height}:${current.x},${current.y},${current.z}:${distanceAt(current) <= MELEE_RANGE}:${contacts.map(p => `${p.x},${p.y},${p.z}`).sort().join(";")}:${bot.health}`,
        isSatisfied: (node) => {
          if (distanceAt(node.feet) > MELEE_RANGE) return false;
          const position = positionAt(node.feet);
          const eye = new Vec3(position.x, position.y, position.z).offset(
            0,
            position === observation.position ? eyeHeight : STANDING_EYE_HEIGHT,
            0,
          );
          return (
            exposedBodyFrom(rays, eye, body) &&
            meleeStanceSafe(world, position, contacts, bot.health)
          );
        },
        heuristic: (node) => Math.max(0, distanceAt(node.feet) - MELEE_RANGE) * HORIZONTAL_TICKS_PER_BLOCK,
      };
    },
  };
}

/**
 * A melee stance needs landing room opposite the attacker, not just reach.
 * Three blocks cover the displacement seen in the recorded basalt pack hit;
 * this is a checked buffer for ordinary contact, not an explosion guarantee.
 */
export function hasMeleeKnockbackRoom(world: WorldView, position: Position3, attacker: Position3): boolean {
  const displacement = meleeKnockbackDisplacement(position, attacker);
  return displacement !== null && hasSupportedCorridor(world, position, displacement);
}

/** Every imminent push needs supported landing room and must avoid lethal terrain. */
export function meleeStanceSafe(world: WorldView, position: Position3, attackers: readonly Position3[], health: number): boolean {
  return meleeKnockbackHazard(world, position, attackers, health) === null &&
    attackers.every(attacker => hasMeleeKnockbackRoom(world, position, attacker));
}

/** The same three-block contact buffer for stance admission and lethal-terrain checks. */
function meleeKnockbackDisplacement(position: Position3, attacker: Position3): Position3 | null {
  const dx = position.x - attacker.x;
  const dz = position.z - attacker.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.01) return null;
  return { x: (dx / distance) * 3, y: 0, z: (dz / distance) * 3 };
}

/** A lethal push from any imminent attacker takes priority over holding the current shielded stance. */
export function meleeKnockbackHazard(
  world: WorldView, position: Position3, attackers: readonly Position3[], health: number,
): KnockbackHazard | null {
  for (const attacker of attackers) {
    const displacement = meleeKnockbackDisplacement(position, attacker);
    if (!displacement) continue;
    const hazard = knockbackCorridorHazard(world, position, displacement, health);
    if (hazard) return hazard;
  }
  return null;
}

/** Whether a swing of `item` sweeps the living bodies beside the target: every item of the `sword` family does. */
export function sweepsOnSwing(bot: Bot, item: { readonly name: string } | null | undefined): boolean {
  return item != null && hasItemFamily(bot, item.name, "sword");
}

/** Keep a non-sweeping tool available instead of equipping a sword whose swing must be withheld. */
export function combatItemsForTarget(bot: Bot, target: Entity) {
  const carried = readCombatItems(bot);
  return hasSweepBystander(bot, target) ? carried.filter((item) => !sweepsOnSwing(bot, item)) : carried;
}

/**
 * A grounded sword swing can damage other living entities within three blocks
 * of the player. Exclude a bystander's whole observed body, not only its feet:
 * a moving enderman on a slope was last seen 3.17 blocks away when the server
 * applied the next sword swing to both it and the selected target.
 */
export function hasSweepBystander(bot: Bot, target: Entity): boolean {
  const feet = bot.entity.position;
  return Object.values(bot.entities).some((entity) => {
    if (entity.id === target.id || entity.id === bot.entity.id || !canBeBystander(bot, entity)) return false;
    const halfWidth = entity.width / 2;
    const dx = Math.max(0, Math.abs(entity.position.x - feet.x) - halfWidth);
    const dz = Math.max(0, Math.abs(entity.position.z - feet.z) - halfWidth);
    const dy = Math.max(0, entity.position.y - feet.y, feet.y - entity.position.y - entity.height);
    return Math.hypot(dx, dy, dz) <= MELEE_RANGE;
  });
}
