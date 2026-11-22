// Persist sign observations and conservative placement attribution.
import { guardObservedWrite } from "./observed-write.js";
import type { SqlBotData } from "./sql-bot-data.js";

export interface SignPosition { readonly x: number; readonly y: number; readonly z: number }
export interface SignObservation {
  readonly dimension: string;
  readonly position: SignPosition;
  readonly block: string;
  readonly front: readonly string[];
  readonly back: readonly string[];
}

const guards = new WeakMap<SqlBotData, ReturnType<typeof guardObservedWrite>>();

/** Keep failure suppression independent for each data store. */
function signWriteGuard(data: SqlBotData): ReturnType<typeof guardObservedWrite> {
  let guard = guards.get(data);
  if (!guard) {
    guard = guardObservedWrite("observed-signs");
    guards.set(data, guard);
  }
  return guard;
}

/** Identify a sign's cell in its dimension. */
export function signKey(dimension: string, position: SignPosition): string {
  return `${dimension}|${position.x}|${position.y}|${position.z}`;
}

/** Check and encode the four lines on one side. */
function signLinesJson(lines: readonly string[]): string {
  if (!Array.isArray(lines) || lines.length !== 4 || !Array.from(lines).every((line) => typeof line === "string")) {
    throw new Error("Sign text must contain four strings per side");
  }
  return JSON.stringify(lines);
}

/** Save an observation, retaining attribution only for an identical observation. */
function writeSign(data: SqlBotData, sign: SignObservation, placer: string | null): void {
  const front = signLinesJson(sign.front);
  const back = signLinesJson(sign.back);
  data.transaction((database) => {
    database.prepare(`
      INSERT INTO observed_signs (sign_key, dimension, block_x, block_y, block_z, block_name,
        front_json, back_json, placed_by_bot_id, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sign_key) DO UPDATE SET
        placed_by_bot_id = CASE WHEN excluded.placed_by_bot_id IS NOT NULL THEN excluded.placed_by_bot_id
          WHEN block_name = excluded.block_name AND front_json = excluded.front_json AND back_json = excluded.back_json
          THEN placed_by_bot_id ELSE NULL END,
        block_name = excluded.block_name, front_json = excluded.front_json, back_json = excluded.back_json,
        observed_at = excluded.observed_at
    `).run(signKey(sign.dimension, sign.position), sign.dimension, sign.position.x, sign.position.y, sign.position.z,
      sign.block, front, back, placer, new Date().toISOString());
  }, { name: "writeSign" });
}

/** Record a sign this bot placed. */
export function recordOwnSign(data: SqlBotData, botId: string, sign: SignObservation): void {
  signWriteGuard(data)(() => writeSign(data, sign, botId));
}

/** Record a sign seen in the world, without inferring a placer. */
export function observeSign(data: SqlBotData, sign: SignObservation): void {
  signWriteGuard(data)(() => writeSign(data, sign, null));
}

/** Forget a sign that is no longer present. */
export function forgetSign(data: SqlBotData, dimension: string, position: SignPosition): void {
  signWriteGuard(data)(() => data.transaction((database) => {
    database.prepare("DELETE FROM observed_signs WHERE sign_key = ?").run(signKey(dimension, position));
  }, { name: "forgetSign" }));
}
