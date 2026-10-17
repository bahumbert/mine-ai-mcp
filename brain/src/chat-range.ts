import type { LocalizedChat } from "./llm-mind.ts";

const DEFAULT_CHAT_RANGE = 64;

function positive(value: string | undefined): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * What the brain is told about the server's Localized Chat mod (`MC_LOCALIZED_CHAT=true`, `MC_CHAT_RANGE`,
 * `MC_SHOUT_FOOD_COST`), or undefined when talk carries as in vanilla (the default).
 */
export function readLocalizedChat(read: (name: string) => string | undefined): LocalizedChat | undefined {
  if (read("MC_LOCALIZED_CHAT")?.toLowerCase() !== "true") return undefined;
  const foodCost = positive(read("MC_SHOUT_FOOD_COST"));
  return { range: positive(read("MC_CHAT_RANGE")) ?? DEFAULT_CHAT_RANGE, ...(foodCost !== null && { foodCost }) };
}
