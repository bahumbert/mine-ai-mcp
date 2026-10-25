/** The boat entities around a bot and the boats in its inventory: what the crossing, the take-back and the seat watch all read. */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import type { Vec3 } from "vec3";

/** How far from where she stands a boat is still hers to break: the one she got off. */
export const BOAT_REACH = 6;

/** Whether this item name is a boat or a raft of any wood: the one test the crossing, the take-back and the inventory count share. */
export const isBoatItemName = (name: string | null | undefined): boolean => name !== null && name !== undefined && (name.endsWith("_boat") || name.endsWith("_raft"));

/** Boats and rafts carried, of any wood. */
export function boatsCarried(bot: Bot): number {
  return bot.inventory.items().filter((item) => isBoatItemName(item.name)).reduce((sum, item) => sum + item.count, 0);
}

/** Whether this entity is a boat or a raft of any wood (or the old plain `boat`). */
export const isBoatEntity = (entity: Entity | null | undefined): boolean =>
  entity?.name !== undefined && (isBoatItemName(entity.name) || entity.name === "boat");

export function nearestBoat(bot: Bot, around: Vec3, within: number, accept: (entity: Entity) => boolean = () => true): Entity | null {
  const boats = Object.values(bot.entities).filter((entity) =>
    entity !== bot.entity && isBoatEntity(entity) && entity.position.distanceTo(around) <= within && accept(entity));
  boats.sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around));
  return boats[0] ?? null;
}
