import type { Bot } from "mineflayer";
import { SqlBotData } from "../../src/bot-data/index.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

const stores = new WeakMap<Bot, SqlBotData>();

/**
 * The throw-away bot-data store of a scenario's bot, for the actions the scenario builds itself: one per bot, closed
 * when the bot's connection ends.
 */
export function scenarioBotData({ bot }: Pick<MineAiScenarioContext, "bot">): SqlBotData {
  const existing = stores.get(bot);
  if (existing) return existing;
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "scenario", scope: { kind: "bot", botId: bot.username } },
  });
  stores.set(bot, data);
  bot.once("end", () => data.close());
  return data;
}
