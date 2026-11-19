// The memory_forget action: deletes this bot's own typed memories by id.
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineAction } from "../action.js";
import {
  MEMORY_FORGET,
  MEMORY_FORGET_DESCRIPTION,
  memoryForgetInputSchema,
  memoryForgetResultSchema,
  parseMemoryForgetRequest,
} from "./contract.js";

/** Deletes this bot's own memories by id; another bot's memories are never touched. Needs no body. */
export function createMemoryForgetAction(data: SqlBotData, botId: string) {
  return defineAction({
    name: MEMORY_FORGET,
    description: MEMORY_FORGET_DESCRIPTION,
    inputSchema: memoryForgetInputSchema,
    resultSchema: memoryForgetResultSchema,
    parse: parseMemoryForgetRequest,
    execution: { kind: "concurrent" },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    formatResult: (result) =>
      `Forgot ${result.forgotten.length} ${result.forgotten.length === 1 ? "memory" : "memories"}${result.notForgotten.length === 0 ? "" : `; not this bot's or gone: ${result.notForgotten.join(", ")}`}.`,
    execute: async (request, context) => {
      context.signal?.throwIfAborted();
      const ids = [...new Set(request.memory_ids)];
      const forgotten = data.transaction(
        (database) => {
          const remove = database.prepare("DELETE FROM memories WHERE bot_id = ? AND memory_id = ? RETURNING memory_id");
          return ids.filter((id) => (remove.get(botId, id) ?? null) !== null);
        },
        { name: "createMemoryForgetAction" },
      );
      return { status: "succeeded", forgotten, notForgotten: ids.filter((id) => !forgotten.includes(id)) };
    },
  });
}
