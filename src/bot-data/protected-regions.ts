import { z } from "zod";
import { sameOwner, type BlockCorner, type ProtectedRegion } from "../world/protected-regions.js";
import type { SqlBotData, SqlBotDataRow } from "./sql-bot-data.js";

/** The route check walks every region for each break it prices, so the list stays short. */
export const MAX_PROTECTED_REGIONS = 64;
/** A region is one build, not a claim on the map (territories are Phase 5). */
export const MAX_REGION_SIDE = 64;

export interface RegionRequest {
  readonly dimension: string;
  readonly min: BlockCorner;
  readonly max: BlockCorner;
  readonly owner: string;
  readonly label: string;
  readonly reason: string;
  readonly createdBy: string;
}

export type ProtectOutcome =
  | { readonly kind: "created" | "existing"; readonly region: ProtectedRegion }
  | { readonly kind: "too_large"; readonly side: number }
  | { readonly kind: "limit_reached" };

const rowSchema = z.object({
  region_id: z.number().int().positive(),
  dimension: z.string().min(1),
  min_x: z.number().int(),
  min_y: z.number().int(),
  min_z: z.number().int(),
  max_x: z.number().int(),
  max_y: z.number().int(),
  max_z: z.number().int(),
  owner: z.string().min(1),
  label: z.string().min(1),
});

function parseRegion(row: SqlBotDataRow): ProtectedRegion {
  const parsed = rowSchema.parse(row);
  return Object.freeze({
    regionId: parsed.region_id,
    dimension: parsed.dimension,
    min: { x: parsed.min_x, y: parsed.min_y, z: parsed.min_z },
    max: { x: parsed.max_x, y: parsed.max_y, z: parsed.max_z },
    owner: parsed.owner,
    label: parsed.label,
  });
}

const sameCorner = (left: BlockCorner, right: BlockCorner) => left.x === right.x && left.y === right.y && left.z === right.z;

/**
 * The bot's protected regions, kept in memory: navigation asks about them for every break it prices, far too often
 * for a query. With the default per-bot data scope each database has one writer (its host), so reloading after each
 * write keeps the copy exact; hosts sharing one database (`--bot-data-scope shared`) see each other's regions only
 * after a restart (regions shared between bots wait for the Phase 5 store).
 */
export class ProtectedRegionStore {
  readonly #data: SqlBotData;
  #regions: readonly ProtectedRegion[];

  constructor(data: SqlBotData) {
    this.#data = data;
    this.#regions = this.#load();
  }

  list(): readonly ProtectedRegion[] {
    return this.#regions;
  }

  protect(request: RegionRequest, now: Date = new Date()): ProtectOutcome {
    const side = Math.max(request.max.x - request.min.x, request.max.y - request.min.y, request.max.z - request.min.z) + 1;
    if (side > MAX_REGION_SIDE) return { kind: "too_large", side };
    // Protecting a house again on resume, after a restart or twice by mistake changes nothing.
    const existing = this.#regions.find((region) =>
      region.dimension === request.dimension && sameOwner(region.owner, request.owner) &&
      sameCorner(region.min, request.min) && sameCorner(region.max, request.max));
    if (existing !== undefined) return { kind: "existing", region: existing };
    if (this.#regions.length >= MAX_PROTECTED_REGIONS) return { kind: "limit_reached" };
    const regionId = this.#data.transaction((database) => {
      const row = database.prepare(`
        INSERT INTO protected_regions
          (dimension, min_x, min_y, min_z, max_x, max_y, max_z, owner, label, reason, created_by_bot_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        RETURNING region_id
      `).get(
        request.dimension,
        request.min.x, request.min.y, request.min.z,
        request.max.x, request.max.y, request.max.z,
        request.owner, request.label, request.reason, request.createdBy, now.toISOString(),
      );
      if (!row) throw new Error("Protected region insert returned no stored row.");
      return Number(row.region_id);
    }, { name: "protectRegion" });
    this.#regions = this.#load();
    const region = this.#regions.find((stored) => stored.regionId === regionId);
    if (region === undefined) throw new Error(`Protected region ${regionId} was not read back.`);
    return { kind: "created", region };
  }

  /** Removes one region; null when there is no such region. */
  unprotect(regionId: number): ProtectedRegion | null {
    const region = this.#regions.find((stored) => stored.regionId === regionId) ?? null;
    if (region === null) return null;
    this.#data.transaction((database) => {
      database.prepare("DELETE FROM protected_regions WHERE region_id = ?").run(regionId);
    }, { name: "unprotectRegion" });
    this.#regions = this.#load();
    return region;
  }

  #load(): readonly ProtectedRegion[] {
    return Object.freeze(this.#data.read(`
      SELECT region_id, dimension, min_x, min_y, min_z, max_x, max_y, max_z, owner, label
      FROM protected_regions ORDER BY region_id
    `).map(parseRegion));
  }
}
