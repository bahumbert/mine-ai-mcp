/**
 * Where an entity's box meets the world, for the answers the fake server gives about a vehicle: a boat put down or moved
 * into a block is refused by the server (contract checks `boat-placed-by-use`, `boat-follows-vehicle-move`).
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";

/** Boxes that only touch (a boat on the floor, against a wall) do not meet; this is the overlap that counts. */
const TOUCH_EPSILON = 1e-6;

/** An axis-aligned box as `[minX, minY, minZ, maxX, maxY, maxZ]` in world coordinates, as a block's shapes are in its cell. */
type Box = readonly [number, number, number, number, number, number];

/** The box of an entity of this size standing with its feet centre at `base`. */
function boxAt(base: Vec3, width: number, height: number): Box {
  return [base.x - width / 2, base.y, base.z - width / 2, base.x + width / 2, base.y + height, base.z + width / 2];
}

function boxesOverlap(first: Box, second: Box): boolean {
  return [0, 1, 2].every((axis) => first[axis]! < second[axis + 3]! - TOUCH_EPSILON && second[axis]! < first[axis + 3]! - TOUCH_EPSILON);
}

/** Whether a box of `width` x `height` standing at `base` meets a collision shape of any block it reaches (an unloaded cell has none). */
export function boxMeetsBlocks(bot: Bot, base: Vec3, width: number, height: number): boolean {
  const box = boxAt(base, width, height);
  return cellsReachedBy(box).some(([x, y, z]) => {
    const shapes = (bot.blockAt(new Vec3(x, y, z))?.shapes ?? []) as readonly Box[];
    return shapes.some((shape) => boxesOverlap(box, [x + shape[0], y + shape[1], z + shape[2], x + shape[3], y + shape[4], z + shape[5]]));
  });
}

/** The cells a box reaches into, as `[x, y, z]`. */
function cellsReachedBy(box: Box): [number, number, number][] {
  const span = (axis: number) => Array.from({ length: Math.ceil(box[axis + 3]!) - Math.floor(box[axis]!) }, (_, step) => Math.floor(box[axis]!) + step);
  return span(0).flatMap((x) => span(1).flatMap((y) => span(2).map((z): [number, number, number] => [x, y, z])));
}

/** Whether a box of `width` x `height` at `base` meets the box of `other`. */
export function boxMeetsEntity(base: Vec3, width: number, height: number, other: Entity): boolean {
  return boxesOverlap(boxAt(base, width, height), boxAt(other.position, other.width, other.height));
}

/** How far `point` is from the nearest point of the box of `width` x `height` standing at `base` (0 inside it). */
export function distanceToBox(point: Vec3, base: Vec3, width: number, height: number): number {
  const [minX, minY, minZ, maxX, maxY, maxZ] = boxAt(base, width, height);
  const gap = (value: number, min: number, max: number) => Math.max(min - value, 0, value - max);
  return Math.hypot(gap(point.x, minX, maxX), gap(point.y, minY, maxY), gap(point.z, minZ, maxZ));
}
