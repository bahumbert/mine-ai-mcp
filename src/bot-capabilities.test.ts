import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { createFakeBot } from "./test-support/fake-bot/index.js";
import { assertBotPluginsLoaded, loadBotPlugins, requireBotTool } from "./bot-capabilities.js";

function pluginBot(tool?: { equipForBlock: () => Promise<void> }): Bot {
  // `loadPlugin` is Mineflayer's own on the fake: the real tool plugin installs `bot.tool`.
  const { bot } = createFakeBot();
  // The Tool plugin's field: Mineflayer's typings leave plugin fields off the bot.
  return tool ? Object.assign(bot, { tool }) : bot;
}

test("loads the missing Tool plugin, and reports it at the runtime boundary if it goes missing", () => {
  const bot = pluginBot();

  loadBotPlugins(bot);

  assert.doesNotThrow(() => assertBotPluginsLoaded(bot));
  delete (bot as unknown as { tool?: unknown }).tool;
  assert.throws(() => assertBotPluginsLoaded(bot), /requires the mineflayer-tool plugin/);
});

test("keeps an existing Tool capability", () => {
  const equipForBlock = async () => undefined;
  const bot = pluginBot({ equipForBlock });
  let plugins = 0;
  bot.loadPlugin = () => {
    plugins += 1;
  };

  loadBotPlugins(bot);

  assert.equal(plugins, 0);
  assert.equal(requireBotTool(bot).equipForBlock, equipForBlock);
});
