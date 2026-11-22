// Read loaded sign text and persist complete observations.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { forgetSign, observeSign, type SqlBotData } from "../../bot-data/index.js";
import { blockFamilyMembers } from "../../world/item-families.js";
import { findLoadedBlockPositions } from "../../world/index.js";
import { defineAction } from "../action.js";
import { READ_SIGNS, READ_SIGNS_DESCRIPTION, parseReadSignsRequest, readSignsAnnotations, readSignsInputSchema, readSignsResultSchema, type ReadSignsRequest, type ReadSignsResult, type SignReading } from "./contract.js";

/** Read a loaded sign; missing entity fields are unknown rather than blank. */
export function readSignAt(bot: Bot, position: Vec3): SignReading | null {
  const block = bot.blockAt(position);
  if (!block || !blockFamilyMembers(bot, "sign").includes(block.name)) return null;
  const entity = block.entity?.value as { front_text?: { value?: { messages?: unknown } }; back_text?: { value?: { messages?: unknown } } } | undefined;
  const known = Boolean(entity?.front_text?.value?.messages && entity?.back_text?.value?.messages);
  const sides = block.getSignText();
  const lines = (side: string) => [...side.split("\n"), "", "", "", ""].slice(0, 4);
  return { position: { x: position.x, y: position.y, z: position.z }, block: block.name, known, front: lines(sides[0] ?? ""), back: lines(sides[1] ?? "") };
}

/** Scan the registry states belonging to the sign family. */
function signStates(bot: Bot): Set<number> {
  const states = new Set<number>();
  for (const name of blockFamilyMembers(bot, "sign")) {
    const block = bot.registry.blocksByName[name];
    if (block) for (let id = block.minStateId; id <= block.maxStateId; id++) states.add(id);
  }
  return states;
}

/** Read a cell or nearby signs, updating stored observations only when known. */
export function readSigns(bot: Bot, data: SqlBotData, request: ReadSignsRequest): ReadSignsResult {
  const cell = request.x !== undefined && request.y !== undefined && request.z !== undefined ? new Vec3(request.x, request.y, request.z) : null;
  if (cell && !bot.blockAt(cell)) return { status: "failed", error: "[READ_SIGNS_UNLOADED] The cell is not loaded; move closer and read again.", signs: [] };
  const positions = cell ? [cell] : findLoadedBlockPositions(bot, { center: bot.entity.position, radius: request.max_distance, stateIds: signStates(bot), limit: request.limit });
  const signs: SignReading[] = [];
  for (const position of positions) {
    const sign = readSignAt(bot, position);
    if (!sign) { if (cell) forgetSign(data, bot.game.dimension, position); continue; }
    signs.push(sign);
    if (sign.known) observeSign(data, { ...sign, dimension: bot.game.dimension });
  }
  return { status: "succeeded", signs };
}

export function createReadSignsAction(bot: Bot, data: SqlBotData) {
  return defineAction({ name: READ_SIGNS, description: READ_SIGNS_DESCRIPTION, inputSchema: readSignsInputSchema, resultSchema: readSignsResultSchema,
    formatResult: (result) => JSON.stringify(result), execution: { kind: "information" }, annotations: readSignsAnnotations,
    parse: parseReadSignsRequest, execute: async (request, context) => { context.signal?.throwIfAborted(); return readSigns(bot, data, request); } });
}
