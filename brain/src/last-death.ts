// The one shape of the bot's last death the brain reads from `view_status` (spec P4-02c D1 = P4-03 D2).
import { z } from "zod";
import type { Position } from "./runtime-client.ts";

export interface LastDeath {
  readonly dimension: string;
  readonly position: Position;
  /** The death's ISO time as the runtime recorded it (the death watch compares it as a string). */
  readonly observedAt: string;
  /** `floor((situation observedAt - observedAt) / 60000)`, clamped at 0 (the runtime's wall clock steps in WSL). */
  readonly minutesAgo: number;
  /** Null: no combat death message. */
  readonly cause: string | null;
}

/** `view_status`'s `lastDeath` (`src/actions/view-status/view-status.ts:75-80`). */
const rawDeathSchema = z.object({
  dimension: z.string(),
  position: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  observedAt: z.string(),
  cause: z.string().nullable(),
});

/**
 * The death `view_status` reports, with its age at the moment of the status read; null for a missing or malformed death
 * and for a date that does not parse. A situation with no date gives age 0.
 */
export function parseLastDeath(raw: unknown, situationObservedAt: string | undefined): LastDeath | null {
  const parsed = rawDeathSchema.safeParse(raw);
  if (!parsed.success) return null;
  const diedAt = Date.parse(parsed.data.observedAt);
  const seenAt = situationObservedAt === undefined ? diedAt : Date.parse(situationObservedAt);
  if (Number.isNaN(diedAt) || Number.isNaN(seenAt)) return null;
  const { dimension, position, observedAt, cause } = parsed.data;
  return { dimension, position, observedAt, minutesAgo: Math.max(0, Math.floor((seenAt - diedAt) / 60_000)), cause };
}
