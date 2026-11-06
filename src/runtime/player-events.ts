import type { Bot, BotEvents } from "mineflayer";
import { guardObservedWrite, recordEvent, type PlayerDeathContext, type SqlBotData } from "../bot-data/index.js";
import { isChatCommandLine, type ChatCommandRing } from "./chat-commands.js";
import { aliveReading, readDeathContext, type LastAliveReading } from "./death-context.js";

type PlayerMessageListener = BotEvents["chat"];
type DeathListener = BotEvents["death"];
type ChatMessageLoader = (registry: unknown) => { fromNotch(message: unknown): { toString(): string } };

// prismarine-chat is the CommonJS loader Mineflayer itself renders chat with;
// its typings declare a default export the module does not actually make.
// A literal `require`: the setup's bundle follows it (see `src/world/crafting.ts`).
const loadChatMessage = require("prismarine-chat") as ChatMessageLoader;

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
type CancelForegroundAction = (reason: string) => unknown;
type GuardedWrite = ReturnType<typeof guardObservedWrite>;

/**
 * Persist queryable player events for the lifetime of one connected runtime. With `commands`, an incoming chat or
 * whisper line that is a command line goes to its ring instead and is never recorded, so no brain reads it as chat.
 */
export function observePlayerEvents(
  bot: Bot,
  data: SqlBotData,
  cancelForegroundAction: CancelForegroundAction,
  commands?: { readonly prefix: string; readonly ring: ChatCommandRing },
): () => void {
  const guarded = guardObservedWrite("player-events");
  const observeMessage =
    (channel: "chat" | "whisper"): PlayerMessageListener =>
    (username, message) => {
      const direction = username.toLowerCase() === bot.username.toLowerCase() ? "outgoing" : "incoming";
      if (direction === "incoming" && commands && isChatCommandLine(message, commands.prefix)) {
        commands.ring.push({ username, channel, message });
        return;
      }
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
          },
        }),
      );
    };

  const onChat = observeMessage("chat");
  const onWhisper = observeMessage("whisper");
  const { onHealth, onCombatDeath, onDeath } = deathListeners(bot, data, cancelForegroundAction, guarded);

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

  bot.on("chat", onChat);
  bot.on("whisper", onWhisper);
  bot.on("death", onDeath);
  bot.on("health", onHealth);
  bot.on("respawn", onRespawn);
  bot.on("forcedMove", onForcedMove);
  bot._client?.on("death_combat_event", onCombatDeath);

  return () => {
    bot._client?.removeListener("death_combat_event", onCombatDeath);
    bot.off("health", onHealth);
    bot.off("respawn", onRespawn);
    bot.off("forcedMove", onForcedMove);
    bot.off("death", onDeath);
    bot.off("whisper", onWhisper);
    bot.off("chat", onChat);
  };
}

/**
 * The three listeners of one death: `health` keeps the last alive reading, the cause packet (which arrives while the gear
 * is still on) names the cause and reads the state, and `death` records both and cancels the foreground action.
 */
function deathListeners(bot: Bot, data: SqlBotData, cancelForegroundAction: CancelForegroundAction, guarded: GuardedWrite) {
  let lastDeathMessage: string | null = null;
  let lastAlive: LastAliveReading | null = null;
  let contextAtCause: PlayerDeathContext | undefined;
  const onHealth = () => {
    const alive = aliveReading(bot);
    if (!alive) return;
    lastAlive = alive;
    // A cause packet that no `death` followed belonged to a life that is over: it must not describe the next death.
    contextAtCause = undefined;
  };
  const onCombatDeath = (packet: { playerId?: number; message?: unknown }) => {
    if (packet.playerId !== undefined && packet.playerId !== bot.entity?.id) return;
    lastDeathMessage = deathMessage(bot, packet.message);
    contextAtCause = readDeathContextSafely(bot, lastAlive);
  };
  const onDeath: DeathListener = () => {
    const cause = lastDeathMessage;
    // No cause packet came: the death handler reads what is left (the server may have cleared the gear).
    const context = contextAtCause ?? readDeathContextSafely(bot, lastAlive);
    lastDeathMessage = null;
    contextAtCause = undefined;
    lastAlive = null;
    recordPlayerDeath(bot, data, cause, context, cancelForegroundAction, guarded);
  };
  return { onHealth, onCombatDeath, onDeath };
}

/** A failing read of the death's state must not stop the death from cancelling the action and being recorded. */
function readDeathContextSafely(bot: Bot, lastAlive: LastAliveReading | null): PlayerDeathContext | undefined {
  try {
    return readDeathContext(bot, lastAlive);
  } catch (error) {
    process.stderr.write(`[player-events] death context not read: ${String(error)}\n`);
    return undefined;
  }
}

/** The context is read by the caller before this cancels; the action is cancelled before the event is written, so a failing write cannot keep the dead bot working. */
function recordPlayerDeath(
  bot: Bot,
  data: SqlBotData,
  cause: string | null,
  context: PlayerDeathContext | undefined,
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
      payload: { dimension, position, cause, ...(context && { context }) },
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
