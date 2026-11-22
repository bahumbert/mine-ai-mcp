// Input and output contract for reading loaded signs.
import { z } from "zod";
import { actionResultSchema } from "../action.js";

export const READ_SIGNS = "read_signs" as const;
export const READ_SIGNS_DESCRIPTION = "Read the text on one sign or the nearest loaded signs without moving.";
const coordinate = z.number().int().safe();
export const readSignsInputSchema = z.strictObject({ x: coordinate.describe("Absolute X coordinate.").optional(), y: coordinate.describe("Absolute Y coordinate.").optional(), z: coordinate.describe("Absolute Z coordinate.").optional(), max_distance: z.number().int().min(1).max(64).default(16), limit: z.number().int().min(1).max(32).default(16) });
export type ReadSignsRequest = z.output<typeof readSignsInputSchema>;
export function parseReadSignsRequest(input: unknown): ReadSignsRequest {
  const request = readSignsInputSchema.parse(input);
  const count = [request.x, request.y, request.z].filter((value) => value !== undefined).length;
  if (count !== 0 && count !== 3) throw new Error("Provide all three coordinates or none.");
  return request;
}
const positionSchema = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
export const signReadingSchema = z.strictObject({ position: positionSchema, block: z.string(), known: z.boolean(), front: z.array(z.string()).length(4), back: z.array(z.string()).length(4) });
export type SignReading = z.output<typeof signReadingSchema>;
export const readSignsResultSchema = actionResultSchema({ signs: z.array(signReadingSchema) });
export type ReadSignsResult = z.output<typeof readSignsResultSchema>;
export const readSignsAnnotations = { destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
