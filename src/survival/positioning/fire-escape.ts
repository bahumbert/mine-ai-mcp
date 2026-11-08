import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isHeadPassable, isPassable, isSafeSupport, type WorldView } from "../../navigation/index.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import { isInFire, isInLava } from "../perception/body.js";

/** A local escape borrows navigation's live world and block geometry. */
export interface FireEscapeDeparture {
  readonly position: Vec3;
  readonly inLava: boolean;
}

export function fireEscapeDeparture(bot: Bot): FireEscapeDeparture {
  return { position: bot.entity.position.clone(), inLava: isInLava(bot) };
}

/** One straight hop from the body's position to `target`, admitted by navigation's block geometry. */
export function clearFireEscape(
  bot: Bot,
  world: WorldView,
  target: Vec3,
  departure: FireEscapeDeparture = fireEscapeDeparture(bot),
): boolean {
  return clearFireHop(bot, world, bot.entity.position, target, departure);
}

/**
 * The body cells at `target` are ones navigation stands in: feet passable (a carpet, a snow layer, an open door) or in
 * water, head and the head cell above `start` for a step up head-passable.
 */
function hasRoomToStand(world: WorldView, start: Vec3, target: Vec3): boolean {
  const x = Math.floor(target.x);
  const z = Math.floor(target.z);
  const y = Math.floor(target.y);
  const feet = world.blockAt(x, y, z);
  const heads = [world.blockAt(x, y + 1, z)];
  if (target.y > start.y + 0.1) heads.push(world.blockAt(Math.floor(start.x), Math.floor(start.y) + 2, Math.floor(start.z)));
  const feetFree = feet.kind === "loaded" && (isPassable(feet) || feet.traits.liquid === "water");
  return feetFree && heads.every((block) => block.kind === "loaded" && isHeadPassable(block));
}

/**
 * A hop from `start` to `target` with the body's `departure`. A route is checked hop by hop (`fireWaterRoute`), so
 * `start` is a parameter and not always the body.
 */
export function clearFireHop(
  bot: Bot,
  world: WorldView,
  start: Vec3,
  target: Vec3,
  departure: FireEscapeDeparture,
): boolean {
  if (!hasRoomToStand(world, start, target)) return false;
  const { inLava } = departure;
  const body = { position: departure.position, width: bot.entity.width ?? 0.6, height: bot.entity.height ?? 1.8 };
  const radius = body.width / 2;
  const distance = start.distanceTo(target);
  const steps = Math.max(1, Math.ceil(distance / 0.25));
  for (let step = 0; step <= steps; step++) {
    const p = start.plus(target.minus(start).scaled(step / steps));
    for (const x of [Math.floor(p.x - radius + 0.001), Math.floor(p.x + radius - 0.001)])
      for (const z of [Math.floor(p.z - radius + 0.001), Math.floor(p.z + radius - 0.001)]) {
        const floor = world.blockAt(x, Math.floor(p.y - 1), z);
        // The start is where the body already is: a shoulder over the lava from the bank's edge is no reason to stay
        // (live 2026-10-19: refused from x 1.28, the bot stood burning on the bank).
        if (
          step > 0 &&
          !isSafeSupport(floor) &&
          !(
            floor.kind === "loaded" &&
            (floor.traits.liquid === "water" || (step < steps && inLava && floor.traits.liquid === "lava"))
          )
        )
          return false;
        // Jump headroom is not the body's path. A raised destination must
        // still reject newly entered fire at foot level along the approach.
        for (let y = Math.floor(p.y); y <= Math.floor(p.y + body.height - 0.001); y++) {
          const block = world.blockAt(x, y, z);
          if (block.kind !== "loaded") return false;
          if (!block.traits.damaging || (step < steps && inLava && block.traits.liquid === "lava")) continue;
          if (
            step < steps &&
            block.collisionShapes.length === 0 &&
            block.traits.liquid === null &&
            cellIntersectsBody({ x, y, z }, body)
          )
            continue;
          return false;
        }
        // The original swimming/jumping response can climb one block. Check
        // its raised corridor; longer routes still belong to navigation.
        // The feet cell is walked in at floor level (a carpet bank is), the head cell must fit the head.
        for (const [y, fits] of [
          [Math.floor(Math.max(start.y, target.y) + 0.1), isPassable],
          [Math.floor(Math.max(start.y, target.y) + 1.7), isHeadPassable],
        ] as const) {
          const block = world.blockAt(x, y, z);
          if (block.kind !== "loaded") return false;
          if (fits(block)) continue;
          if (step < steps && inLava && block.traits.liquid === "lava") continue;
          // Leaving an occupied fire cell necessarily overlaps that cell on
          // the way out. Never admit a new damaging cell or a burning destination.
          if (
            step < steps &&
            block.traits.damaging &&
            block.collisionShapes.length === 0 &&
            block.traits.liquid === null &&
            cellIntersectsBody({ x, y, z }, body)
          )
            continue;
          return false;
        }
      }
  }
  return true;
}

/** A body in lava swims up to a bank this many cells above its feet (the scan's top row). */
export const FIRE_ESCAPE_RISE_IN_LAVA = 2;

/** Immediate swimming/jumping reach; longer journeys belong to navigation. */
export type FireEscapeReason = "contact" | "advancing_lava" | "lethal_burn";
export const FIRE_ESCAPE_RADIUS = 4;
export const FIRE_LETHAL_WATER_RADIUS = 8;
/** Walking speed in blocks per second, derived from prismarine-physics/index.js:569-570, 743-744. */
const WALK_BLOCKS_PER_SECOND = 4.317;
/** Distance safely reachable before a lethal burn consumes the remaining health. */
export function lethalRouteBlocks(bot: Bot): number {
  return Math.min(16, WALK_BLOCKS_PER_SECOND * Math.max(0, bot.health - 2));
}
/** The longest way round to water: walked in under 2 s, while lava burns for 15 s and a fire block for 8 s. */
export const FIRE_WATER_ROUTE_BLOCKS = 8;

/** The cells of the escape volume a body can stand or swim in: every water cell, and every dry cell with safe footing. */
export interface EscapeCells {
  readonly water: Vec3[];
  readonly dry: Vec3[];
}

/**
 * Scan the escape volume around the body; every read stays in the facts volume of `reflexes/fire.ts`. A dry cell is
 * safe footing: not the cell the body stands in, and not one lava can spread into on its next step
 * (`advancingLavaAt`), whatever woke the reflex; `crossSpreading` admits those cells too, the last resort of a body
 * that is in lava or fire. `rise` is the highest row, in cells above the feet, a cell is scanned in (a body in lava
 * passes `FIRE_ESCAPE_RISE_IN_LAVA`: it swims up to a bank two cells over its feet, not one).
 */
export function escapeCells(bot: Bot, world: WorldView, { crossSpreading = false, rise = 1, radius = FIRE_ESCAPE_RADIUS } = {}): EscapeCells {
  const origin = bot.entity.position.floored();
  const water: Vec3[] = [];
  const dry: Vec3[] = [];
  for (let dx = -radius; dx <= radius; dx++)
    for (let dz = -radius; dz <= radius; dz++)
      for (let dy = -1; dy <= rise; dy++) {
        const cell = origin.offset(dx, dy, dz);
        const feet = world.blockAt(cell.x, cell.y, cell.z);
        const head = world.blockAt(cell.x, cell.y + 1, cell.z);
        const floor = world.blockAt(cell.x, cell.y - 1, cell.z);
        if (feet.kind !== "loaded" || !isHeadPassable(head)) continue;
        const point = cell.offset(0.5, 0, 0.5);
        if (!crossSpreading && advancingLavaAt(bot, point)) continue;
        if (feet.traits.liquid === "water") water.push(point);
        else if (isPassable(feet) && isSafeSupport(floor) && !(dx === 0 && dy === 0 && dz === 0)) dry.push(point);
      }
  return { water, dry };
}

const cellKeyOf = (point: Vec3) => `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;

/** One cell of a route search: where the body stands there, how it left the cell before, the length so far. */
interface RouteNode {
  readonly point: Vec3;
  readonly departure: FireEscapeDeparture;
  readonly length: number;
  readonly before: RouteNode | null;
}

/** The cell points from the first hop to the end node. */
function pointsOfRoute(end: RouteNode): Vec3[] {
  const points: Vec3[] = [];
  for (let node: RouteNode | null = end; node?.before; node = node.before) points.unshift(node.point);
  return points;
}

/** The four horizontal neighbours as [dx, dz]. */
export const SIDE_STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Push each hop to a side neighbour (one cell up or down at most) that `clearFireHop` admits and the length bound allows. */
function openHopsFrom(
  bot: Bot,
  world: WorldView,
  node: RouteNode,
  standable: ReadonlyMap<string, Vec3>,
  shortest: Map<string, number>,
  open: RouteNode[],
  limit: number,
): void {
  const cell = node.point.floored();
  for (const [dx, dz] of SIDE_STEPS)
    for (const dy of [0, 1, -1]) {
      const next = standable.get(`${cell.x + dx},${cell.y + dy},${cell.z + dz}`);
      if (!next) continue;
      const length = node.length + node.point.distanceTo(next);
      const key = cellKeyOf(next);
      if (length > limit || length >= (shortest.get(key) ?? Infinity)) continue;
      if (!clearFireHop(bot, world, node.point, next, node.departure)) continue;
      shortest.set(key, length);
      open.push({ point: next, departure: { position: next, inLava: false }, length, before: node });
    }
}

/**
 * Dijkstra on hop length over the scanned cells, to the nearest water cell. A hop is tested only when its start is
 * the cheapest open cell, so the reads are bounded by the scan's size and the length bound.
 */
function shortestWayToWater(bot: Bot, world: WorldView, cells: EscapeCells, limit: number): Vec3[] | null {
  const standable = new Map<string, Vec3>();
  for (const point of [...cells.water, ...cells.dry]) standable.set(cellKeyOf(point), point);
  const waterKeys = new Set(cells.water.map(cellKeyOf));
  const open: RouteNode[] = [{ point: bot.entity.position, departure: fireEscapeDeparture(bot), length: 0, before: null }];
  const shortest = new Map<string, number>();
  const closed = new Set<string>();
  while (open.length > 0) {
    let cheapest = 0;
    for (let index = 1; index < open.length; index++) if (open[index]!.length < open[cheapest]!.length) cheapest = index;
    const node = open.splice(cheapest, 1)[0]!;
    const key = cellKeyOf(node.point);
    if (closed.has(key)) continue;
    closed.add(key);
    if (node.before && waterKeys.has(key)) return pointsOfRoute(node);
    openHopsFrom(bot, world, node, standable, shortest, open, limit);
  }
  return null;
}

/** The cell the body stands in, as a point, when it is already in water. */
function ownWaterCell(bot: Bot, world: WorldView): Vec3 | null {
  const cell = bot.entity.position.floored();
  const block = world.blockAt(cell.x, cell.y, cell.z);
  return block.kind === "loaded" && block.traits.liquid === "water" ? cell.offset(0.5, 0, 0.5) : null;
}

/** The own water cell is a refuge only while no lava can flow into the body's cells there (the head cell above the water). */
function waterRouteOver(bot: Bot, world: WorldView, cells: EscapeCells, limit: number): Vec3[] | null {
  if (cells.water.length === 0) return null;
  const own = ownWaterCell(bot, world);
  return own && !advancingLavaAt(bot, own) ? [own] : shortestWayToWater(bot, world, cells, limit);
}

/** How far up the scan reaches: a body in lava swims up to a bank two cells over its feet, any other body one. */
function riseOf(bot: Bot): number {
  return isInLava(bot) ? FIRE_ESCAPE_RISE_IN_LAVA : 1;
}

/**
 * The way round obstacles to the nearest water, cell by cell, from the first hop to the water cell; null when the
 * scan holds no water or no admitted way reaches it. Only for fire contact: advancing lava has its own dry escape.
 */
export function fireWaterRoute(bot: Bot, world: WorldView, reason: FireEscapeReason): Vec3[] | null {
  if (reason === "advancing_lava") return null;
  const lethal = reason === "lethal_burn";
  return waterRouteOver(bot, world, escapeCells(bot, world, { rise: riseOf(bot), radius: lethal ? FIRE_LETHAL_WATER_RADIUS : FIRE_ESCAPE_RADIUS }), lethal ? lethalRouteBlocks(bot) : FIRE_WATER_ROUTE_BLOCKS);
}

/** Dry cells by distance; cells that tie go to the one nearer a scanned water, the bank a later route can use. */
function dryCellsNearestFirst(bot: Bot, cells: EscapeCells): Vec3[] {
  const here = bot.entity.position;
  const ranked = cells.dry.map((point) => ({
    point,
    away: point.distanceTo(here),
    toWater: Math.min(Infinity, ...cells.water.map((water) => water.distanceTo(point))),
  }));
  return ranked.sort((a, b) => a.away - b.away || a.toWater - b.toWater).map(({ point }) => point);
}

/** The walk over `cells`: the way to water, else the nearest straight-line water, else (when one is needed) the nearest dry bank. */
function routeOverCells(bot: Bot, world: WorldView, reason: FireEscapeReason, cells: EscapeCells): Vec3[] | null {
  const route = reason !== "advancing_lava" ? waterRouteOver(bot, world, cells, reason === "lethal_burn" ? lethalRouteBlocks(bot) : FIRE_WATER_ROUTE_BLOCKS) : null;
  if (route) return route;
  if (reason === "lethal_burn") return null;
  const needsDryEscape = reason === "advancing_lava" || isInLava(bot) || isInFire(bot) || advancingLavaAt(bot);
  const here = bot.entity.position;
  const water = [...cells.water].sort((a, b) => a.distanceTo(here) - b.distanceTo(here));
  const candidates = needsDryEscape ? [...water, ...dryCellsNearestFirst(bot, cells)] : water;
  const target = candidates.find((point) => clearFireEscape(bot, world, point));
  return target ? [target] : null;
}

/**
 * The cells to walk to leave the fire: the way to water (round lava and fire when it is not a straight line), else the
 * nearest straight-line water, else, when the body is in lava or fire or lava advances, the nearest dry bank. Only
 * safe footing counts; a body in lava or fire with none takes a cell lava can still spread into as the last resort,
 * one on dry ground does not shuffle between such cells. Null: none.
 */
export function fireEscapeRoute(bot: Bot, world: WorldView, reason: FireEscapeReason = "contact"): Vec3[] | null {
  const rise = riseOf(bot);
  const safe = routeOverCells(bot, world, reason, escapeCells(bot, world, { rise, radius: reason === "lethal_burn" ? FIRE_LETHAL_WATER_RADIUS : FIRE_ESCAPE_RADIUS }));
  if (safe || !(isInLava(bot) || isInFire(bot))) return safe;
  return routeOverCells(bot, world, reason, escapeCells(bot, world, { crossSpreading: true, rise }));
}

/**
 * The dry cell nearest a body in lava that has no admitted hop to any, in the scan a swim up reads (rise 2, lava's
 * spread allowed as the last resort): the body steers toward it while it rises, until a hop is admitted. Null: none.
 */
export function nearestDryCellToSwimTo(bot: Bot, world: WorldView): Vec3 | null {
  const cells = escapeCells(bot, world, { crossSpreading: true, rise: FIRE_ESCAPE_RISE_IN_LAVA });
  return dryCellsNearestFirst(bot, cells)[0] ?? null;
}

/** The first cell of `fireEscapeRoute`, for callers that only need to know where the body is heading. */
export function nearbyFireEscape(bot: Bot, world: WorldView, reason: FireEscapeReason = "contact"): Vec3 | null {
  return fireEscapeRoute(bot, world, reason)?.[0] ?? null;
}
