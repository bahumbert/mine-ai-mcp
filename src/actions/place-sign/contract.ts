// Input, evidence and outcomes for one placed sign.
import { z } from "zod";
import { actionResultSchema } from "../action.js";

export const PLACE_SIGN = "place_sign" as const;
export const PLACE_SIGN_DESCRIPTION = "Place a carried sign on the ground or a wall, or fill an existing sign known blank on both sides with fill_blank. Write its front text after the server opens the editor and report whether the server confirmed the lines. Signs with text are read and refused.";
// Contract sign-edit kept 45 and 46 characters; Mineflayer sends at most 45 (T1, 2026-11-15).
export const SIGN_LINE_MAX = 45;
export type SignLines = [string, string, string, string];
const coordinate = z.number().int().safe();
const position = z.strictObject({ x: coordinate, y: coordinate, z: coordinate });
const facing = z.enum(["north", "south", "east", "west"]);
const attach = z.enum(["ground", "wall"]);
const line = z.string().max(SIGN_LINE_MAX).regex(/^[^\r\n]*$/u);
export const placeSignInputSchema = z.strictObject({
  x: coordinate.describe("Absolute X cell."),
  y: coordinate.describe("Absolute Y cell."),
  z: coordinate.describe("Absolute Z cell."),
  facing: facing.describe("The direction the front text faces."),
  attach: attach.default("ground").describe("Ground below the sign, or the wall behind its text."),
  lines: z.array(line).min(1).max(4).describe("One to four front lines, each at most 45 characters without line breaks."),
  sign_item: z.string().min(1).optional().describe("Carried registry item in the sign family; otherwise the first carried sign."),
  fill_blank: z.boolean().default(false).describe("Fill an existing sign only when its front and back are both known blank; no sign item is needed."),
});
export type PlaceSignRequest = z.output<typeof placeSignInputSchema>;

/** Pad a validated request's lines to the four lines sent and compared. */
export function normalizeLines(lines: readonly string[]): SignLines {
  return [lines[0] ?? "", lines[1] ?? "", lines[2] ?? "", lines[3] ?? ""];
}

/** Parse before taking the body. */
export function parsePlaceSignRequest(input: unknown): PlaceSignRequest {
  const lines = placeSignInputSchema.shape.lines.safeParse((input as { lines?: unknown } | null)?.lines);
  if (!lines.success) throw new Error(placeSignOutcomes.lines);
  return placeSignInputSchema.parse(input);
}

export const placeSignResultSchema = actionResultSchema({
  sign: z.strictObject({ target: position, block: z.string().nullable(), facing, attach, lines: z.tuple([z.string(), z.string(), z.string(), z.string()]), confirmed: z.boolean(), placed: z.boolean() }),
  members: z.array(z.string()).optional(),
  existing: z.strictObject({ block: z.string(), front: z.array(z.string()).length(4).optional(), back: z.array(z.string()).length(4).optional() }).optional(),
});
export type PlaceSignResult = z.output<typeof placeSignResultSchema>;
export { placeSignCheckpointSchema } from "../checkpoint-schemas.js";
export const placeSignAnnotations = { destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
export const placeSignOutcomes = {
  noItem: "[PLACE_SIGN_NO_SIGN_ITEM] No requested carried sign is available; obtain one of the listed family members.",
  taken: (block: string) => `[PLACE_SIGN_CELL_TAKEN] The cell holds ${block}; choose another cell. Existing signs are never overwritten.`,
  noSupport: "[PLACE_SIGN_NO_SUPPORT] No full supporting face or unique sign block is available; choose a supported cell and sign item.",
  lines: "[PLACE_SIGN_LINES] Provide one to four lines, each at most 45 characters without CR or LF, then try again.",
  unloaded: "[PLACE_SIGN_UNLOADED] The target cell is not loaded; move closer and try again.",
  unknown: "[PLACE_SIGN_TEXT_UNKNOWN] The sign's front or back text is not known; move closer and read the sign before filling it.",
  noEditor: "[PLACE_SIGN_NO_EDITOR] The server did not open the editor after the one click; read the sign before deciding whether to try again.",
  clickNotSent: (cause: string) => `[PLACE_SIGN_NO_EDITOR] The click was not sent: ${cause}. The sign was not touched; read it, then try again.`,
  unconfirmed: (block: string, cause: string, placed = true) => `[PLACE_SIGN_TEXT_UNCONFIRMED] ${block} ${placed ? "was placed" : "was opened"}, but its front text was not confirmed: ${cause}. Read the sign before deciding what to do next.`,
  failed: (cause: string) => `[PLACE_SIGN_FAILED] ${cause}; inspect the cell before trying again.`,
};
