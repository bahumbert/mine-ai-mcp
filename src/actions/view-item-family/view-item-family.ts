/** Read registry members of an item family. */
import type { Bot } from "mineflayer";
import { familyMembers } from "../../world/item-families.js";
import { defineAction, type ActionContext } from "../action.js";
import { VIEW_ITEM_FAMILY, VIEW_ITEM_FAMILY_DESCRIPTION, parseViewItemFamilyRequest, viewItemFamilyAnnotations, viewItemFamilyInputSchema, viewItemFamilyResultSchema, type ViewItemFamilyRequest, type ViewItemFamilyResult } from "./contract.js";

export async function viewItemFamily(bot: Bot, request: ViewItemFamilyRequest, context: ActionContext): Promise<ViewItemFamilyResult> {
  context.signal?.throwIfAborted();
  return { status: "succeeded", family: request.family, members: [...familyMembers(bot, request.family)] };
}

export function formatViewItemFamilyResult(result: ViewItemFamilyResult): string {
  return `${result.family}: ${result.members.join(", ") || "none"}`;
}

export function createViewItemFamilyAction(bot: Bot) {
  return defineAction({ name: VIEW_ITEM_FAMILY, description: VIEW_ITEM_FAMILY_DESCRIPTION, inputSchema: viewItemFamilyInputSchema,
    resultSchema: viewItemFamilyResultSchema, formatResult: formatViewItemFamilyResult, execution: { kind: "information" },
    annotations: viewItemFamilyAnnotations, parse: parseViewItemFamilyRequest, execute: (request, context) => viewItemFamily(bot, request, context) });
}
