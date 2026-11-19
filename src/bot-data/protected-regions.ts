import { z } from "zod";
import { sameOwner, type BlockCorner, type ProtectedRegion } from "../world/protected-regions.js";
import type { SqlBotData } from "./sql-bot-data.js";

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

export type UnprotectOutcome =
  | { readonly kind: "removed"; readonly region: ProtectedRegion }
  | { readonly kind: "not_found" }
  /** Another bot stored it (a shared file written by several hosts): only that bot may remove it. */
  | { readonly kind: "not_held"; readonly region: ProtectedRegion };

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
  created_by_bot_id: z.string().min(1),
});

/** The columns `parseRegion` reads, for the store's own file and for the read-only reads of the other bots' files. */
export const PROTECTED_REGION_COLUMNS =
  "region_id, dimension, min_x, min_y, min_z, max_x, max_y, max_z, owner, label, created_by_bot_id";

/** A stored row as a region: `peer` when `ownBotId` did not store it. */
export function parseRegion(row: Record<string, unknown>, ownBotId: string | null): ProtectedRegion {
  const parsed = rowSchema.parse(row);
  return Object.freeze({
    regionId: parsed.region_id,
    dimension: parsed.dimension,
    min: { x: parsed.min_x, y: parsed.min_y, z: parsed.min_z },
    max: { x: parsed.max_x, y: parsed.max_y, z: parsed.max_z },
    owner: parsed.owner,
    label: parsed.label,
    heldBy: parsed.created_by_bot_id,
    peer: ownBotId === null || parsed.created_by_bot_id !== ownBotId,
  });
}

const sameCorner = (left: BlockCorner, right: BlockCorner) => left.x === right.x && left.y === right.y && left.z === right.z;

/**
 * The bot's protected regions, kept in memory: navigation asks about them for every break it prices, far too often
 * for a query. With the default per-bot data scope each database has one writer (its host), so reloading after each
 * write keeps the copy exact; hosts sharing one database (`--bot-data-scope shared`) see each other's regions at the
 * next `refresh()`, and the ones they stored are `peer` regions here (the other bots' own files: `peer-regions.ts`).
 */
export class ProtectedRegionStore {
  readonly #data: SqlBotData;
  readonly #botId: string;
  #regions: readonly ProtectedRegion[];
  /** `PRAGMA data_version` when the list was loaded: it moves only when another connection commits. */
  #dataVersion: number;

  /** `botId`: the id this bot's regions carry in `created_by_bot_id`; any other row is a peer's. */
  constructor(data: SqlBotData, botId: string) {
    this.#data = data;
    this.#botId = botId;
    this.#dataVersion = this.#readDataVersion();
    this.#regions = this.#load();
  }

  /** Reloads when another connection wrote since the last load (hosts sharing a file); true when it did. */
  refresh(): boolean {
    const version = this.#readDataVersion();
    if (version === this.#dataVersion) return false;
    this.#dataVersion = version;
    this.#regions = this.#load();
    return true;
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

  /** Removes one region of this bot; a region another bot stored stays (`not_held`). */
  unprotect(regionId: number): UnprotectOutcome {
    const region = this.#regions.find((stored) => stored.regionId === regionId);
    if (region === undefined) return { kind: "not_found" };
    if (region.peer) return { kind: "not_held", region };
    this.#data.transaction((database) => {
      database.prepare("DELETE FROM protected_regions WHERE region_id = ?").run(regionId);
    }, { name: "unprotectRegion" });
    this.#regions = this.#load();
    return { kind: "removed", region };
  }

  /** Read before each load, so a write landing between the two is seen at the next `refresh()`. */
  #readDataVersion(): number {
    return Number(this.#data.read("PRAGMA data_version")[0]?.data_version);
  }

  #load(): readonly ProtectedRegion[] {
    return Object.freeze(this.#data.read(`
      SELECT ${PROTECTED_REGION_COLUMNS} FROM protected_regions ORDER BY region_id
    `).map((row) => parseRegion(row, this.#botId)));
  }
}
