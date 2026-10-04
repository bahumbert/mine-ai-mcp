import { executionCheckpointSchema } from "../checkpoint-schemas.js";
import type { SqlBotData } from "../../bot-data/sql-bot-data.js";
import { defineAction } from "../action.js";
import {
  NOTE_DELETE,
  NOTE_DELETE_DESCRIPTION,
  noteDeleteInputSchema,
  noteDeleteResultSchema,
  parseNoteDeleteRequest,
} from "./contract.js";

/** Deletes this bot's own notes by id; another bot's notes are never touched. */
export function createNoteDeleteAction(data: SqlBotData, botId: string) {
  return defineAction({
    checkpointSchema: executionCheckpointSchema,
    name: NOTE_DELETE,
    description: NOTE_DELETE_DESCRIPTION,
    inputSchema: noteDeleteInputSchema,
    resultSchema: noteDeleteResultSchema,
    parse: parseNoteDeleteRequest,
    execution: { kind: "task" },
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    formatResult: (result) =>
      `Deleted ${result.deleted.length} notes${result.notDeleted.length === 0 ? "" : `; not this bot's or gone: ${result.notDeleted.join(", ")}`}.`,
    execute: async (request, context) => {
      context.signal?.throwIfAborted();
      const ids = [...new Set(request.note_ids)];
      const deleted = data.transaction((database) => {
        const remove = database.prepare("DELETE FROM notes WHERE bot_id = ? AND note_id = ? RETURNING note_id");
        return ids.filter((id) => (remove.get(botId, id) ?? null) !== null);
      }, { name: "createNoteDeleteAction" });
      return { status: "succeeded", deleted, notDeleted: ids.filter((id) => !deleted.includes(id)) };
    },
  });
}
