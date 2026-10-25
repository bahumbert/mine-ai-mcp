import type { Bot } from "mineflayer";
import { blockDropsData, sourcesOf } from "../../world/block-drops.js";
import { isHostileSpecies } from "../../survival/perception/combat/threats.js";
import { rankedMobSources, unknownItemAnswer } from "../../world/mob-drops.js";
import { defineAction, type ActionContext } from "../action.js";
import {
  parseViewBlockDropsRequest,
  VIEW_BLOCK_DROPS,
  VIEW_BLOCK_DROPS_DESCRIPTION,
  viewBlockDropsAnnotations,
  viewBlockDropsInputSchema,
  viewBlockDropsOutcomes,
  viewBlockDropsResultSchema,
  type ViewBlockDropsRequest,
  type ViewBlockDropsResult,
} from "./contract.js";

/** Where each requested item drops from and what each requested block drops, from the data shipped for the bot's version. */
export async function viewBlockDrops(
  bot: Pick<Bot, "registry" | "version" | "game" | "entities">,
  request: ViewBlockDropsRequest,
  context: ActionContext,
): Promise<ViewBlockDropsResult> {
  context.signal?.throwIfAborted();
  const data = blockDropsData(bot.version);
  const unknown = [
    ...request.items.filter((item) => bot.registry.itemsByName[item] === undefined),
    ...request.blocks.filter((block) => bot.registry.blocksByName[block] === undefined),
  ];
  const loaded = (mob: string) => Object.values(bot.entities).filter((entity) => entity.name === mob).length;
  const drops = {
    version: bot.version,
    dataVersion: data?.version ?? null,
    items: request.items
      .filter((item) => !unknown.includes(item))
      .map((item) => ({
        item,
        sources: data === null ? [] : sourcesOf(item, data.version).map((source) => ({ ...source })),
        mobs: rankedMobSources(item, bot.version, bot.game.dimension, loaded).map((source) => ({ ...source, hostile: isHostileSpecies(bot, source.mob) })),
      })),
    blocks: request.blocks
      .filter((block) => !unknown.includes(block))
      .map((block) => ({ block, drops: (data?.blocks[block] ?? []).map((drop) => ({ ...drop, ...(drop.state && { state: { ...drop.state } }) })) })),
  };
  if (unknown.length > 0) {
    const names = [...new Set([...Object.keys(bot.registry.itemsByName), ...Object.keys(bot.registry.blocksByName)])];
    return { status: "failed", error: viewBlockDropsOutcomes.unknownNames(unknown.map((name) => unknownItemAnswer(name, names, bot.registry.entitiesByName, bot.version))), drops };
  }
  if (data === null) return { status: "failed", error: viewBlockDropsOutcomes.dataUnavailable(bot.version), drops };
  return { status: "succeeded", drops };
}

function describeChance(chance: number): string {
  return chance === 1 ? "" : ` (${Math.round(chance * 1000) / 10}%)`;
}

/** Where a mob source can be found now: how many are loaded, else whether it spawns in the bot's dimension. */
function describeWhere(source: { readonly loaded: number; readonly spawnsInDimension: boolean }): string {
  if (source.loaded > 0) return ` (${source.loaded} loaded nearby)`;
  return source.spawnsInDimension ? "" : " (does not spawn in this dimension)";
}

export function formatViewBlockDropsResult(result: ViewBlockDropsResult): string {
  const { drops } = result;
  const lines = result.status === "succeeded" ? [] : [`**Observed stop:** ${result.error}`];
  for (const { item, sources, mobs } of drops.items) {
    const hunted = mobs.length === 0 ? "" : `; hunted from ${mobs.map((source) => `${source.mob}${source.hostile ? " (hostile)" : ""}${describeChance(source.chance)}${describeWhere(source)}`).join(", ")}`;
    lines.push(sources.length === 0
      ? `- ${item}: no block drops it by an ordinary break${hunted}`
      : `- ${item}: from ${sources.map((source) => `${source.block}${source.planted ? ` (planted crop${source.seed === undefined ? "" : `, from ${source.seed}`})` : ""}${describeChance(source.chance)}`).join(", ")}${hunted}`);
  }
  for (const { block, drops: list } of drops.blocks) {
    lines.push(list.length === 0
      ? `- ${block}: drops nothing`
      : `- ${block}: ${list.map((drop) => `${drop.item}${describeChance(drop.chance)}${drop.tool === undefined ? "" : ` with ${drop.tool}`}${drop.state === undefined ? "" : ` when ${Object.entries(drop.state).map(([key, value]) => `${key}=${value}`).join(",")}`}`).join("; ")}`);
  }
  return lines.join("\n");
}

export function createViewBlockDropsAction(bot: Bot) {
  return defineAction({
    name: VIEW_BLOCK_DROPS,
    description: VIEW_BLOCK_DROPS_DESCRIPTION,
    inputSchema: viewBlockDropsInputSchema,
    resultSchema: viewBlockDropsResultSchema,
    formatResult: formatViewBlockDropsResult,
    execution: { kind: "information" },
    annotations: viewBlockDropsAnnotations,
    parse: parseViewBlockDropsRequest,
    execute: (request, context) => viewBlockDrops(bot, request, context),
  });
}
