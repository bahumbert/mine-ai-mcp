// The memory_save tool's name, description, input and result.
import { z } from "zod";
import { MEMORY_KIND_PATTERN, memoryRowSchema } from "../../bot-data/memories.js";

export const MEMORY_SAVE = "memory_save" as const;
/** A stored row must fit one `query_bot_data` answer (64 KiB) with room for its neighbours. */
export const MEMORY_DATA_MAX_BYTES = 16 * 1024;

export const MEMORY_SAVE_DESCRIPTION =
  "Save one structured memory for this bot in this world, for an agent's own typed memory: you choose the kind, " +
  "the subject, the version of your data shape and the data; the runtime stores what it is given and knows no kinds. " +
  "Records the sentence for people, UTC time, current dimension and position, and latest server-reported world age. " +
  "With replace true, this bot's older memories of the same kind and subject are deleted in the same write, so " +
  "updating a memory is one call that cannot lose it. Read them back with query_bot_data on main.memories, " +
  "remove some with memory_forget. Memories persist with bot data across restarts. Runs beside the foreground action.";

export const memorySaveInputSchema = z.strictObject({
  kind: z
    .string()
    .regex(MEMORY_KIND_PATTERN, "kind is lowercase letters, digits and underscores, starting with a letter, at most 64 characters.")
    .describe("What sort of memory this is, in your own words (lowercase, underscores), e.g. place or relation."),
  subject: z
    .string()
    .max(200)
    .default("")
    .describe("What it is about within its kind (a name, a partner). Empty for kinds you only append. Replace matches kind and subject."),
  version: z.number().int().min(1).describe("Version of the shape of data for this kind, so a reader can tell old rows from new ones."),
  data: z
    .record(z.string(), z.json())
    .refine((data) => Buffer.byteLength(JSON.stringify(data)) <= MEMORY_DATA_MAX_BYTES, {
      message: `data is at most ${MEMORY_DATA_MAX_BYTES} bytes (16 KiB) when written as JSON: save less, or split it into several memories.`,
    })
    .describe("The memory itself, a JSON object, at most 16 KiB."),
  note: z.string().trim().min(1).max(2000).describe("One sentence about this memory, for people and for you to read later."),
  replace: z.boolean().default(false).describe("True: delete this bot's older memories of the same kind and subject in the same write."),
});

export const memorySaveResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  memory: memoryRowSchema,
  replaced: z.number().int().nonnegative().describe("How many older memories replace removed."),
});

export type MemorySaveRequest = z.output<typeof memorySaveInputSchema>;
export type MemorySaveResult = z.output<typeof memorySaveResultSchema>;

export function parseMemorySaveRequest(input: unknown): MemorySaveRequest {
  return memorySaveInputSchema.parse(input);
}
