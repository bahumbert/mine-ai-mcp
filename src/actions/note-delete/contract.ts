import { z } from "zod";

export const NOTE_DELETE = "note_delete" as const;
export const NOTE_DELETE_DESCRIPTION =
  "Delete some of this bot's own saved notes in this world, by note id (from note_read or query_bot_data on " +
  "main.notes). Notes of other bots are never deleted; ids that are not this bot's, or no longer exist, are reported " +
  "as not deleted. Deleting cannot be undone.";

export const noteDeleteInputSchema = z.strictObject({
  note_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(500)
    .describe("Ids of this bot's notes to delete, at most 500 per call."),
});

export const noteDeleteResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  deleted: z.array(z.number().int()),
  notDeleted: z.array(z.number().int()),
});

export type NoteDeleteRequest = z.output<typeof noteDeleteInputSchema>;
export type NoteDeleteResult = z.output<typeof noteDeleteResultSchema>;

export function parseNoteDeleteRequest(input: unknown) {
  return noteDeleteInputSchema.parse(input);
}
