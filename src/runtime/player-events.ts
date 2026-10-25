import type { Bot, BotEvents } from "mineflayer";
import { createRequire } from "node:module";
import { guardObservedWrite, recordEvent, type SqlBotData } from "../bot-data/index.js";

type PlayerMessageListener = BotEvents["chat"];
type DeathListener = BotEvents["death"];
type ChatMessageLoader = (registry: unknown) => { fromNotch(message: unknown): { toString(): string } };

// prismarine-chat is the CommonJS loader Mineflayer itself renders chat with;
// its typings declare a default export the module does not actually make.
const loadChatMessage = createRequire(import.meta.url)("prismarine-chat") as ChatMessageLoader;

/**
 * The server names what killed the player in the combat-death packet, which
 * arrives a moment before the death itself. Rendered through the client's
 * own language table so it reads as the chat line does: "drowned", "was
 * slain by Zombie", "tried to swim in lava".
 */
export function deathMessage(bot: Bot, message: unknown): string | null {
  try {
    const text = loadChatMessage(bot.registry).fromNotch(message).toString().trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

const LOCAL_CHAT_PATTERN_NAME = "localChat";
/** The Localized Chat mod's wire format for talk heard from `distance` blocks away; matches nothing on vanilla. */
const LOCAL_CHAT_PATTERN = /^\[From ([\d.]+) blocks away\] <([A-Za-z0-9_]{1,16})> (.*)$/u;
/** Mineflayer emits `chat:<pattern name>`; its typings only list the built-in events. */
const LOCAL_CHAT_EVENT = `chat:${LOCAL_CHAT_PATTERN_NAME}` as keyof BotEvents;
type CancelForegroundAction = (reason: string) => unknown;
type GuardedWrite = ReturnType<typeof guardObservedWrite>;

/** Persist queryable player events for the lifetime of one connected runtime. */
export function observePlayerEvents(
  bot: Bot,
  data: SqlBotData,
  cancelForegroundAction: CancelForegroundAction,
): () => void {
  const guarded = guardObservedWrite("player-events");
  const stopObservingChat = observeChat(bot, data, guarded);
  let lastDeathMessage: string | null = null;
  const onCombatDeath = (packet: { playerId?: number; message?: unknown }) => {
    if (packet.playerId !== undefined && packet.playerId !== bot.entity?.id) return;
    lastDeathMessage = deathMessage(bot, packet.message);
  };
  const onDeath: DeathListener = () => {
    const cause = lastDeathMessage;
    lastDeathMessage = null;
    recordPlayerDeath(bot, data, cause, cancelForegroundAction, guarded);
  };

  // Respawn updates the dimension before the destination position packet.
  // Record arrival only when forcedMove observes that new position.
  let dimension = bot.game.dimension;
  let crossing: { from: string; to: string } | null = null;
  const onRespawn = () => {
    if (bot.game.dimension === dimension) return;
    crossing = { from: dimension, to: bot.game.dimension };
    dimension = bot.game.dimension;
  };
  const onForcedMove = () => {
    if (crossing === null) return;
    const { from, to } = crossing;
    crossing = null;
    recordDimensionArrival(bot, data, from, to, guarded);
  };

  bot.on("death", onDeath);
  bot.on("respawn", onRespawn);
  bot.on("forcedMove", onForcedMove);
  bot._client?.on("death_combat_event", onCombatDeath);

  return () => {
    bot._client?.removeListener("death_combat_event", onCombatDeath);
    bot.off("respawn", onRespawn);
    bot.off("forcedMove", onForcedMove);
    bot.off("death", onDeath);
    stopObservingChat();
  };
}

/** Records public talk and whispers, the bot's own included, heard by vanilla chat or Localized Chat; returns the stop. */
function observeChat(bot: Bot, data: SqlBotData, guarded: GuardedWrite): () => void {
  const recordMessage = (channel: "chat" | "whisper", username: string, message: string, distance?: number) => {
    const direction = username.toLowerCase() === bot.username.toLowerCase() ? "outgoing" : "incoming";
    guarded(() =>
      recordEvent(data, bot.username, {
        type: "player_message",
        observedAt: new Date().toISOString(),
        summary: `${username}: ${message}`,
        payload: {
          username,
          channel,
          direction,
          message,
          addressed: direction === "incoming" && addressesUsername(message, bot.username),
          ...(distance === undefined ? {} : { distance }),
        },
      }),
    );
  };
  const observeMessage =
    (channel: "chat" | "whisper"): PlayerMessageListener =>
    (username, message) => recordMessage(channel, username, message);

  const onChat = observeMessage("chat");
  const onWhisper = observeMessage("whisper");
  // Localized Chat delivers talk as a system line, so `chat` never fires for it.
  const onLocalChat = (matches: readonly (readonly string[])[]) => {
    for (const [distance, username, message] of matches) {
      if (distance !== undefined && username !== undefined && message !== undefined) {
        recordMessage("chat", username, message, Number(distance));
      }
    }
  };

  bot.addChatPattern(LOCAL_CHAT_PATTERN_NAME, LOCAL_CHAT_PATTERN, { repeat: true, parse: true });
  bot.on(LOCAL_CHAT_EVENT, onLocalChat as never);
  bot.on("chat", onChat);
  bot.on("whisper", onWhisper);
  return () => {
    bot.off("whisper", onWhisper);
    bot.off("chat", onChat);
    bot.off(LOCAL_CHAT_EVENT, onLocalChat as never);
    bot.removeChatPattern(LOCAL_CHAT_PATTERN_NAME);
  };
}

/** The foreground action is cancelled before the event is written, so a failing write cannot keep the dead bot working. */
function recordPlayerDeath(
  bot: Bot,
  data: SqlBotData,
  cause: string | null,
  cancelForegroundAction: CancelForegroundAction,
  guarded: GuardedWrite,
): void {
  const position = {
    x: bot.entity.position.x,
    y: bot.entity.position.y,
    z: bot.entity.position.z,
  };
  const dimension = bot.game.dimension;
  const observedAt = new Date().toISOString();
  const summary = `${bot.username} died at ${position.x}, ${position.y}, ${position.z} in ${dimension}${cause ? `: ${cause}` : ""}.`;

  cancelForegroundAction(`${bot.username} died${cause ? `: ${cause}` : ""}.`);
  guarded(() =>
    recordEvent(data, bot.username, {
      type: "player_death",
      observedAt,
      summary,
      payload: { dimension, position, cause },
    }),
  );
}

function recordDimensionArrival(bot: Bot, data: SqlBotData, from: string, to: string, guarded: GuardedWrite): void {
  const position = {
    x: bot.entity.position.x,
    y: bot.entity.position.y,
    z: bot.entity.position.z,
  };
  guarded(() =>
    recordEvent(data, bot.username, {
      type: "player_dimension_change",
      observedAt: new Date().toISOString(),
      summary: `${bot.username} arrived in ${to} from ${from}.`,
      payload: { from, to, position },
    }),
  );
}

function addressesUsername(message: string, username: string): boolean {
  const words = message.toLowerCase().split(/[^a-z0-9_]+/u);
  return words.includes(username.toLowerCase());
}
