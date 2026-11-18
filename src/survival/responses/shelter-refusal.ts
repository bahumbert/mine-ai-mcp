// Snapshot the observations behind an emergency shelter refusal.
import type { Bot } from "mineflayer";
import { cellIntersectsBody, type Position3 } from "../../utils/geometry.js";
import { familyIndexOf } from "../../world/item-families.js";
import { protectionShell } from "../positioning/combat/planner.js";
import type { ShelterBuild } from "./shelter-build.js";
import { shelterFeet, shelterIntruders } from "./shelter-cells.js";

type Cause = "no_floor" | "not_centred" | "hazard" | "constrained" | "liquid" | "deadline" | "occupied" | "open" | "exposed";
type Point = { readonly x: number; readonly y: number; readonly z: number };
type Box = { readonly min: Point; readonly max: Point };
type Intruder = { readonly id: number; readonly name: string; readonly box: Box };
export type ShelterOccupied = { readonly cell: Point; readonly intruderId: number; readonly intruderName: string; readonly box: Box };

export type ShelterRefusal = {
  readonly cause: Cause;
  readonly feet: Point;
  readonly position: Point;
  readonly onGround: boolean;
  readonly floor: { readonly name: string; readonly shapes: readonly (readonly number[])[] } | null;
  readonly shell: readonly { readonly cell: Point; readonly block: string | null }[];
  readonly occupied: readonly ShelterOccupied[];
  readonly intruders: readonly Intruder[];
  readonly hazard: string | null;
  readonly projectiles: readonly { readonly id: number; readonly name: string; readonly position: Point; readonly velocity: Point }[];
  readonly worldAge: number | null;
};

const point = ({ x, y, z }: Position3): Point => ({ x, y, z });

export function shelterEntityBox(entity: Bot["entity"]): Box {
  const { position, width, height } = entity;
  return { min: { x: position.x - width / 2, y: position.y, z: position.z - width / 2 },
    max: { x: position.x + width / 2, y: position.y + height, z: position.z + width / 2 } };
}

/** Snapshot the inputs at the refusal, before the world or its entities move on. */
export function describeShelterRefusal(build: ShelterBuild, cause: Cause, extra: { hazard?: string | null } = {}): ShelterRefusal {
  const { bot } = build;
  const feet = shelterFeet(bot), floor = bot.blockAt(feet.offset(0, -1, 0));
  const cells = protectionShell(feet, [feet]);
  const entities = [...shelterIntruders(bot, build.options.threatContext)];
  const intruders = entities.map((entity) => ({ id: entity.id, name: entity.name ?? "unknown", box: shelterEntityBox(entity) }));
  const occupied = cells.filter((cell) => (build.blockedCells.get(`${cell.x},${cell.y},${cell.z}`)?.count ?? 0) > 0)
    .flatMap((cell) => entities.filter((entity) => cellIntersectsBody(cell, entity)).map((entity) =>
      ({ cell: point(cell), intruderId: entity.id, intruderName: entity.name ?? "unknown", box: shelterEntityBox(entity) })));
  const projectiles = Object.values(bot.entities).filter((entity) => entity?.isValid && entity.name &&
    familyIndexOf(bot).entityFamilies(entity.name).some((family) => family === "projectile_entity" || family === "arrow_entity"))
    .map((entity) => ({ id: entity.id, name: entity.name ?? "unknown", position: point(entity.position), velocity: point(entity.velocity) }));
  return { cause, feet: point(feet), position: point(bot.entity.position), onGround: bot.entity.onGround,
    floor: floor ? { name: floor.name, shapes: floor.shapes.map((shape) => [...shape]) } : null,
    shell: cells.map((cell) => ({ cell: point(cell), block: bot.blockAt(cell)?.name ?? null })),
    occupied, intruders, hazard: "hazard" in extra ? extra.hazard ?? null : build.options.unsafe?.() ?? null,
    projectiles, worldAge: bot.time?.age ?? null };
}
