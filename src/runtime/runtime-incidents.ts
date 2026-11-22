// Starts the bot's event observers, picks the incident directory and hands survival receipts to the diagnostic observer.
import type { Bot } from "mineflayer";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ActionRunner } from "../session/action-runner.js";
import type { SqlBotData } from "../bot-data/index.js";
import type { SurvivalReceipt } from "../survival/evidence/contract.js";
import type { NavigationRuntime } from "../navigation/index.js";
import { observeEquipmentEvents } from "./equipment-events.js";
import { observeNavigationEvents } from "./navigation-events.js";
import { observeBotStatus } from "./bot-status.js";
import type { ChatCommandRing } from "./chat-commands.js";
import { observePlayerEvents } from "./player-events.js";
import type { MinecraftRuntimeOptions } from "./minecraft-runtime.js";

/** Starts the observers that write what happens to the bot into its event log; the returned function stops them all. */
export function observeBotEvents(
  bot: Bot,
  botData: SqlBotData,
  runner: ActionRunner,
  navigation: NavigationRuntime,
  commandLines: { readonly prefix: string; readonly ring: ChatCommandRing } | null,
): () => void {
  const stops = [
    observePlayerEvents(bot, botData, (reason) => runner.cancelActive(reason, { kind: "death" }), commandLines ?? undefined),
    observeEquipmentEvents(bot, botData),
    observeNavigationEvents(navigation, bot.username, botData),
    observeBotStatus(bot, botData),
  ];
  return () => {
    for (const stop of stops.toReversed()) stop();
  };
}

/** Select an incident directory and register cleanup when the runtime owns it. */
export function incidentDirectory(options: MinecraftRuntimeOptions, botData: SqlBotData, resources: AsyncDisposableStack): string {
  if (options.incidents?.directory !== undefined) return options.incidents.directory;
  if (botData.location.kind === "persistent") return path.join(path.dirname(botData.location.file), "incidents");
  const directory = path.join(os.tmpdir(), "mine-ai-incidents", randomUUID());
  resources.defer(async () => { try { await rm(directory, { recursive: true, force: true }); } catch { /* Best effort. */ } });
  return directory;
}

/** A diagnostic observer cannot interrupt receipt publication or mutate its evidence. */
export function notifySurvivalReceipt(observer: MinecraftRuntimeOptions["onSurvivalReceipt"], receipt: SurvivalReceipt): void {
  if (observer) { try { observer(structuredClone(receipt)); } catch { /* Diagnostics cannot interrupt survival. */ } }
}
