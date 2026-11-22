import type { Bot } from "mineflayer";
import { deathMessage } from "../../../src/runtime/player-events.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";

export interface ObservedDeaths {
  /** Each death of the bot, in order; `cause` is the server's death message, `null` when no combat-death packet came before. */
  readonly deaths: readonly { atMs: number; cause: string | null }[];
  /** Each respawn: the first `spawn` after a `death`. */
  readonly respawns: readonly { atMs: number }[];
  dispose(): void;
}

/**
 * Reads the bot's deaths and respawns for a scenario driver, on the monotonic clock. A respawn is the first `spawn` after
 * a `death`, never Mineflayer's `respawn` event, which also fires on a dimension change. The cause is the message of the
 * `death_combat_event` packet about this bot (it arrives just before the death), rendered as the runtime renders it.
 */
export function observeDeaths(bot: Bot): ObservedDeaths {
  const deaths: { atMs: number; cause: string | null }[] = [];
  const respawns: { atMs: number }[] = [];
  let cause: string | null = null;
  let awaitingRespawn = false;

  const onCombatDeath = (packet: { playerId?: number; message?: unknown }) => {
    if (packet.playerId !== undefined && packet.playerId !== bot.entity?.id) return;
    cause = deathMessage(bot, packet.message);
  };
  const onDeath = () => {
    deaths.push({ atMs: monotonicNow(), cause });
    cause = null;
    awaitingRespawn = true;
  };
  const onSpawn = () => {
    if (!awaitingRespawn) return;
    awaitingRespawn = false;
    respawns.push({ atMs: monotonicNow() });
  };

  bot._client.on("death_combat_event", onCombatDeath);
  bot.on("death", onDeath);
  bot.on("spawn", onSpawn);

  let disposed = false;
  return {
    deaths,
    respawns,
    dispose() {
      if (disposed) return;
      disposed = true;
      bot._client.removeListener("death_combat_event", onCombatDeath);
      bot.off("death", onDeath);
      bot.off("spawn", onSpawn);
    },
  };
}
