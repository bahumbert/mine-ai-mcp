// The memory_save action: stores one typed memory of this bot, optionally replacing its older ones.
import type { Bot } from "mineflayer";
import { parseMemoryRow } from "../../bot-data/memories.js";
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineAction } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  MEMORY_SAVE,
  MEMORY_SAVE_DESCRIPTION,
  memorySaveInputSchema,
  memorySaveResultSchema,
  parseMemorySaveRequest,
  type MemorySaveRequest,
  type MemorySaveResult,
} from "./contract.js";

/** Stores one typed memory (and, with replace, removes this bot's older ones of its kind and subject): a disk write that needs no body. */
export function createMemorySaveAction(bot: Bot, data: SqlBotData) {
  return defineAction({
    name: MEMORY_SAVE,
    description: MEMORY_SAVE_DESCRIPTION,
    inputSchema: memorySaveInputSchema,
    resultSchema: memorySaveResultSchema,
    parse: parseMemorySaveRequest,
    execution: { kind: "concurrent" },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false },
    formatResult: (result) =>
      `Saved memory #${result.memory.memoryId} (${result.memory.kind}${result.memory.subject === "" ? "" : ` ${result.memory.subject}`})` +
      `${result.replaced === 0 ? "" : `, replacing ${result.replaced}`}.\n\n${markdownCodeBlock(JSON.stringify(result.memory, null, 2))}`,
    execute: async (request, context): Promise<MemorySaveResult> => {
      context.signal?.throwIfAborted();
      return storeMemory(bot, data, request);
    },
  });
}

function storeMemory(bot: Bot, data: SqlBotData, request: MemorySaveRequest): MemorySaveResult {
  const { x, y, z } = bot.entity.position;
  return data.transaction(
    (database) => {
      // The older rows go before the insert, so the new row is never among them.
      const replaced = request.replace
        ? Number(
            database
              .prepare("DELETE FROM memories WHERE bot_id = ? AND kind = ? AND subject = ?")
              .run(bot.username, request.kind, request.subject).changes,
          )
        : 0;
      const row = database
        .prepare(
          `INSERT INTO memories (bot_id, kind, subject, version, data_json, note, saved_at, dimension, x, y, z, world_age_ticks)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          bot.username,
          request.kind,
          request.subject,
          request.version,
          JSON.stringify(request.data),
          request.note,
          new Date().toISOString(),
          bot.game.dimension,
          x,
          y,
          z,
          bot.time.age ?? null,
        );
      if (!row) throw new Error("Memory insert returned no stored row.");
      return { status: "succeeded", memory: parseMemoryRow(row), replaced };
    },
    { name: "createMemorySaveAction" },
  );
}
