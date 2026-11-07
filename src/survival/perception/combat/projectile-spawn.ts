import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { familyIndexOf } from "../../../world/item-families.js";

const spawnSchema = z.object({
  entityId: z.number().int(),
  type: z.number().int(),
  objectData: z.number().int(),
  velocity: z.object({ x: z.number(), y: z.number(), z: z.number() }),
});

/** Native initial velocity is required before the next entity-velocity packet. */
export function readProjectileSpawn(
  bot: Bot,
  packet: unknown,
): { projectileId: number; ownerId: number | null; velocity: Vec3 } | null {
  const parsed = spawnSchema.safeParse(packet);
  if (!parsed.success) return null;
  const { entityId, type, objectData, velocity } = parsed.data;
  const name = bot.registry.entities[type]?.name;
  const families = name === undefined ? [] : familyIndexOf(bot).entityFamilies(name);
  const arrow = families.includes("arrow_entity");
  // The other tracked projectiles (the family's override: a blaze's small fireball) count only when a blaze threw them.
  const blaze = !arrow && families.includes("projectile_entity") && bot.entities[objectData]?.name === "blaze";
  if (!blaze && !arrow) return null;
  return {
    projectileId: entityId,
    // Preserve established blaze attribution. Arrow guarding needs trajectory,
    // not an inferred owner; damage attribution still identifies its attacker.
    ownerId: blaze ? objectData : null,
    velocity: new Vec3(velocity.x, velocity.y, velocity.z).scaled(1 / 8000),
  };
}
