// The typed memory rows of `main.memories`, parsed once at the SQLite boundary (the way notes.ts parses notes).
import { z } from "zod";
import type { SqlBotDataRow } from "./sql-bot-data.js";

/** What a caller may name a kind: the runtime knows no kind, only this shape. */
export const MEMORY_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export const memoryRowSchema = z.strictObject({
  memoryId: z.number().int().positive(),
  botId: z.string().min(1),
  kind: z.string().regex(MEMORY_KIND_PATTERN),
  subject: z.string(),
  version: z.number().int().min(1),
  data: z.record(z.string(), z.json()),
  note: z.string().min(1),
  savedAt: z.iso.datetime(),
  dimension: z.string().min(1),
  position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  worldAgeTicks: z.number().int().nonnegative().nullable().describe("Latest server-reported world age in game ticks; null before the first time update."),
});

export type MemoryRow = z.output<typeof memoryRowSchema>;

/** Parse one stored memory: `data_json` is a JSON object by the table's CHECK. */
export function parseMemoryRow(row: SqlBotDataRow): MemoryRow {
  return memoryRowSchema.parse({
    memoryId: row.memory_id,
    botId: row.bot_id,
    kind: row.kind,
    subject: row.subject,
    version: row.version,
    data: JSON.parse(String(row.data_json)),
    note: row.note,
    savedAt: row.saved_at,
    dimension: row.dimension,
    position: { x: row.x, y: row.y, z: row.z },
    worldAgeTicks: row.world_age_ticks,
  });
}
