// The memory_forget tool's name, description, input and result.
import { z } from "zod";

export const MEMORY_FORGET = "memory_forget" as const;
export const MEMORY_FORGET_DESCRIPTION =
  "Delete some of this bot's own saved memories in this world, by memory id (memory_id from query_bot_data on " +
  "main.memories). Memories of other bots are never deleted; ids that are not this bot's, or no longer exist, are " +
  "reported as not forgotten. Forgetting cannot be undone. Runs beside the foreground action.";

export const memoryForgetInputSchema = z.strictObject({
  memory_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(500)
    .describe("Ids of this bot's memories to forget, at most 500 per call."),
});

export const memoryForgetResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  forgotten: z.array(z.number().int()),
  notForgotten: z.array(z.number().int()),
});

export type MemoryForgetRequest = z.output<typeof memoryForgetInputSchema>;
export type MemoryForgetResult = z.output<typeof memoryForgetResultSchema>;

export function parseMemoryForgetRequest(input: unknown): MemoryForgetRequest {
  return memoryForgetInputSchema.parse(input);
}
