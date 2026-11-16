/** Contract for registry item family inspection. */
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ITEM_FAMILIES } from "../../world/item-families.js";
import { actionResultSchema } from "../action.js";

export const VIEW_ITEM_FAMILY = "view_item_family" as const;
export const VIEW_ITEM_FAMILY_DESCRIPTION = "List the registry items belonging to an item family, in registry order.";
export const viewItemFamilyInputSchema = z.strictObject({ family: z.enum(ITEM_FAMILIES).describe("Item family to inspect.") });
export type ViewItemFamilyRequest = z.output<typeof viewItemFamilyInputSchema>;
export const parseViewItemFamilyRequest = (input: unknown): ViewItemFamilyRequest => viewItemFamilyInputSchema.parse(input);
export const viewItemFamilyResultSchema = actionResultSchema({ family: z.enum(ITEM_FAMILIES), members: z.array(z.string()) });
export type ViewItemFamilyResult = z.output<typeof viewItemFamilyResultSchema>;
export const viewItemFamilyAnnotations = { destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations;
