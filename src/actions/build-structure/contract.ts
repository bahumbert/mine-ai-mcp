import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";
import { REFUSAL_CAUSES } from "../../world/placement.js";
import { HORIZONTAL_FACINGS, type HorizontalFacing } from "../../world/facing.js";
import { BLOCK_AXES, BLOCK_HALVES, type BlockAxis, type BlockHalf } from "../../world/block-states.js";

export const BUILD_STRUCTURE = "build_structure" as const;
export const BUILD_STRUCTURE_DESCRIPTION =
  "Build a structure given as cells, each an absolute x, y, z and a carried block name, or air for a cell to dig clear, or as a nether portal frame using 10 obsidian and 4 cobblestone corner supports at an interior corner with its interior kept clear. Places every cell it can reach from where the bot stands, walks within reach of the rest lowest first, never builds itself in, and reports what was placed, dug, and short, and why each cell still wrong was left: holding another block, nothing to place against, its block not carried, would seal the bot in, or refused. Required tool-tier loss stops with partial progress by default; on_tool_loss=continue keeps the same build running. Sending the same structure again resumes or audits it. Works inside protected regions this bot owns; a request with a cell in anyone else's protected region is refused before any block is touched.";

/** How many cells one build may describe; a portal preset is twenty and a small shelter under a hundred. */
export const MAX_STRUCTURE_CELLS = 256;
/** Cells one call may keep intact besides its own: the earlier parts of a structure built in several calls. */
export const MAX_KEEP_CELLS = 2048;

const coordinate = (axis: string) => z.number().int().safe().describe(`Absolute ${axis} coordinate.`);

export const structureCellSchema = z.strictObject({
  x: coordinate("X"),
  y: coordinate("Y"),
  z: coordinate("Z"),
  block_name: registryNameSchema.describe(
    "Block registry name carried as an item, such as cobblestone; air asks for the cell to be dug clear.",
  ),
  facing: z
    .enum(HORIZONTAL_FACINGS)
    .optional()
    .describe(
      "For a block Minecraft orients by the player's facing (a door, stairs): the facing it must have. The bot faces that way while placing it, and the same block facing elsewhere counts as wrong.",
    ),
  half: z
    .enum(BLOCK_HALVES)
    .optional()
    .describe(
      "For stairs, slabs and trapdoors: the upper or lower half it must take (a slab's type). The bot clicks above or below the middle of a side face, or places against the block above or below, as a player would; the other half counts as wrong.",
    ),
  axis: z
    .enum(BLOCK_AXES)
    .optional()
    .describe(
      "For logs and other blocks with an axis: the axis it must lie along. The bot places it against a neighbour on that axis (a horizontal beam needs one beside it); another axis counts as wrong.",
    ),
});

export const portalFrameRequestSchema = z.strictObject({
  x: coordinate("X").describe("X of the interior's lowest corner."),
  y: coordinate("Y").describe("Y of the interior's lowest row, one above the ground the frame stands on."),
  z: coordinate("Z").describe("Z of the interior's lowest corner."),
  axis: z.enum(["x", "z"]).default("x").describe("The horizontal axis the frame's width runs along."),
});

export const buildStructureInputSchema = z.strictObject({
  blocks: z
    .array(structureCellSchema)
    .max(MAX_STRUCTURE_CELLS)
    .optional()
    .describe("The structure's cells. Cells already holding the block are counted correct and left alone."),
  portal_frame: portalFrameRequestSchema
    .optional()
    .describe(
      "A nether portal frame using 10 obsidian and 4 cobblestone corner supports, with its six interior cells kept clear. Supports remain in place. Use explicit blocks for a custom design.",
    ),
  remove_wrong_blocks: z
    .boolean()
    .default(false)
    .describe("Dig a cell holding the wrong block before placing. Off, such cells are reported as wrong."),
  on_tool_loss: z.enum(["stop", "continue"]).default("stop")
    .describe("Stop with a partial structure when the best required digging tool tier drops, or continue with the remaining tool."),
  keep: z
    .array(z.strictObject({ x: coordinate("X"), y: coordinate("Y"), z: coordinate("Z") }))
    .max(MAX_KEEP_CELLS)
    .optional()
    .describe("Cells routes must not dig while this call works: what earlier calls of the same structure already built. The structure's own correct cells are always kept."),
});

export interface StructureCell {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly blockName: string;
  readonly facing?: HorizontalFacing;
  readonly half?: BlockHalf;
  readonly axis?: BlockAxis;
}

/** How a cell reads in messages: its block and every state it asks for. */
export function describeStructureCell(cell: Pick<StructureCell, "blockName" | "facing" | "half" | "axis">): string {
  return [cell.blockName, cell.facing && `facing ${cell.facing}`, cell.half, cell.axis && `along ${cell.axis}`]
    .filter(Boolean)
    .join(" ");
}

export interface BuildStructureRequest {
  readonly cells: readonly StructureCell[];
  readonly removeWrongBlocks: boolean;
  readonly onToolLoss?: "stop" | "continue";
  /** Cells routes must not dig: earlier parts of the structure. */
  readonly keep?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

/**
 * Ten obsidian form the portal edges. Four ordinary corner blocks provide
 * placement support, including for the top row, and can remain after lighting.
 * The six interior cells must be air: a live run left cobblestone scaffold
 * through the opening and produced a frame that could not be lit.
 */
export function portalFrameCells(frame: z.output<typeof portalFrameRequestSchema>): StructureCell[] {
  const cells: StructureCell[] = [];
  const along = (offset: number, y: number, blockName = "obsidian"): StructureCell =>
    frame.axis === "x"
      ? { x: frame.x + offset, y, z: frame.z, blockName }
      : { x: frame.x, y, z: frame.z + offset, blockName };
  const rowBlock = (offset: number) => (offset === -1 || offset === 2 ? "cobblestone" : "obsidian");
  for (let offset = -1; offset <= 2; offset += 1) cells.push(along(offset, frame.y - 1, rowBlock(offset)));
  for (let up = 0; up < 3; up += 1) {
    cells.push(along(-1, frame.y + up));
    cells.push(along(0, frame.y + up, "air"));
    cells.push(along(1, frame.y + up, "air"));
    cells.push(along(2, frame.y + up));
  }
  for (let offset = -1; offset <= 2; offset += 1) cells.push(along(offset, frame.y + 3, rowBlock(offset)));
  return cells;
}

export function parseBuildStructureRequest(input: unknown): BuildStructureRequest {
  const value = buildStructureInputSchema.parse(input ?? {});
  const cells: StructureCell[] = [
    ...(value.blocks ?? []).map((cell) => ({
      x: cell.x,
      y: cell.y,
      z: cell.z,
      blockName: cell.block_name,
      ...(cell.facing !== undefined && { facing: cell.facing }),
      ...(cell.half !== undefined && { half: cell.half }),
      ...(cell.axis !== undefined && { axis: cell.axis }),
    })),
    ...(value.portal_frame ? portalFrameCells(value.portal_frame) : []),
  ];
  if (cells.length === 0) throw new Error("A structure needs blocks or a portal_frame.");
  if (cells.length > MAX_STRUCTURE_CELLS) {
    throw new Error(`A structure may describe at most ${MAX_STRUCTURE_CELLS} cells; this one has ${cells.length}.`);
  }
  const byCell = new Map<string, StructureCell>();
  for (const cell of cells) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    const existing = byCell.get(key);
    if (existing && describeStructureCell(existing) !== describeStructureCell(cell)) {
      throw new Error(`Cell ${key} is asked to be both ${describeStructureCell(existing)} and ${describeStructureCell(cell)}.`);
    }
    byCell.set(key, cell);
  }
  return {
    cells: [...byCell.values()],
    removeWrongBlocks: value.remove_wrong_blocks,
    onToolLoss: value.on_tool_loss,
    ...(value.keep !== undefined && value.keep.length > 0 && { keep: value.keep }),
  };
}

/** Why a wrong cell was left, in the words of what was observed there. */
export const LEFT_REASONS = [
  "holds_another_block",
  "nothing_to_place_against",
  "block_not_carried",
  "would_seal_bot_in",
  "bot_stands_in_it",
  "not_loaded",
  "refused",
  "not_reached",
] as const;
export type LeftReason = (typeof LEFT_REASONS)[number];

/**
 * How many cells are named per reason. A structure may be 256 cells, and a
 * response that lists every one of them buries the count that matters; a few
 * positions are enough to send the next request at the right cells.
 */
export const NAMED_CELLS_PER_REASON = 4;

export const leftCellSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  /** The block observed in the cell, when the reason is about it. */
  holds: z.string().optional(),
  /** What refused the cell, when something did. */
  detail: z.string().optional(),
  /** Present with `detail`: what refused it. Only a policy refusal is for good; an entity, a route or a placement may pass. */
  cause: z.enum(REFUSAL_CAUSES).optional(),
});

export const structureAuditSchema = z.strictObject({
  dimension: z.string(),
  cells: z.number().int().nonnegative(),
  /** Cells matching the structure when the action finished. */
  correct: z.number().int().nonnegative(),
  placed: z.number().int().nonnegative(),
  dug: z.number().int().nonnegative(),
  /** Cells still holding something other than the requested block. */
  wrong: z.number().int().nonnegative(),
  /** The wrong cells grouped by why they were left, with up to a few of each named. */
  left: z.array(
    z.strictObject({
      reason: z.enum(LEFT_REASONS),
      count: z.number().int().positive(),
      named: z.array(leftCellSchema).max(NAMED_CELLS_PER_REASON),
    }),
  ),
  missing: z.array(z.strictObject({ block: z.string(), count: z.number().int().positive() })),
  passes: z.number().int().nonnegative(),
  complete: z.boolean(),
  /** Present when the routes placed scaffold: how many blocks, how many were taken down, and where the rest still stands. */
  scaffold: z
    .strictObject({
      placed: z.number().int().positive(),
      removed: z.number().int().nonnegative(),
      left: z.array(z.strictObject({ x: z.number().int(), y: z.number().int(), z: z.number().int() })).max(NAMED_CELLS_PER_REASON),
      leftCount: z.number().int().nonnegative(),
    })
    .optional(),
});

export const buildStructureResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), structure: structureAuditSchema }),
  z.strictObject({ status: z.literal("partial"), error: z.string(), structure: structureAuditSchema.nullable() }),
  z.strictObject({ status: z.literal("failed"), error: z.string(), structure: structureAuditSchema.nullable() }),
]);

export type StructureAudit = z.output<typeof structureAuditSchema>;
export type BuildStructureResult = z.output<typeof buildStructureResultSchema>;
export type BuildStructureOutput = ActionOutput<typeof BUILD_STRUCTURE, BuildStructureResult>;

export const buildStructureAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;

export const buildStructureOutcomes = {
  unknownBlock: (blockName: string) => `[BUILD_UNKNOWN_BLOCK] Minecraft has no block named ${blockName}.`,
  incomplete: (wrong: number, left: string, missing: string) =>
    `[BUILD_INCOMPLETE] ${wrong} cell${wrong === 1 ? "" : "s"} still wrong: ${left}` +
    (missing ? `; short of ${missing}` : "") +
    ".",
  stopped: (reason: string) => `[BUILD_STOPPED] The build stopped: ${reason}.`,
  protectedRegion: (cells: number, region: string) =>
    `[BUILD_PROTECTED_REGION] ${cells} cell${cells === 1 ? " lies" : "s lie"} inside ${region}, which this bot does not own; unprotect it or build elsewhere.`,
} as const;
