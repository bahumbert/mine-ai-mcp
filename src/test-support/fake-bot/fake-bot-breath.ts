/**
 * The fake bot's air: the server counts it down while the eye is under water and refills it out of the water, and
 * the client learns it only from the player's `air_supply` entity metadata, which Mineflayer turns into
 * `oxygenLevel` and a `breath` event (`entities.js:515-518`). Rates as measured on a 1.21.4 server by the contract
 * check `air-supply-under-water`. The air counts the server's ticks (`FakeServer.onTick`), so it follows `ticksPerSecond` and a stop's
 * catch-up. Not modelled: the air below 0 (drowning damage and its reset), Respiration, creative immunity.
 */
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";
import { botEyesInWater } from "../../world/eyes-in-water.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import { eyeHeightOf } from "./fake-bot-physics.js";

/** The full air (`LivingEntity.getMaxAirSupply`): 15 ticks a bubble, 20 bubbles; its client reading is `Math.round(air / 15)`. */
const FULL_AIR = 300;
const TICKS_PER_BUBBLE = 15;
/** Air lost per server tick under water and gained per tick out of it (contract check `air-supply-under-water`). */
const AIR_LOST_PER_TICK = 1;
const AIR_GAINED_PER_TICK = 4;

/** The server's air for the bot. */
export interface FakeBreath {
  /** The server's own count, whether or not the client heard of it. */
  readonly airSupply: number;
  /** The server sets the air and tells the client at once (a test's scene); the next tick goes on from it. */
  setAirSupply(ticks: number): void;
  /**
   * The server sets the air and keeps it there (a test's scene: the water or the roof the real server would count
   * against is not built): no tick changes it, so it neither falls under water nor refills out of it, until `release`.
   */
  hold(ticks: number): void;
  /** The air counts again from where it stands, at the measured rates. Nothing happens when nothing is held. */
  release(): void;
  readonly held: boolean;
  /** Use the placed server body's feet during a fixed-position contract until respawn or disposal. */
  followServerFeet(): Disposable;
}

export interface FakeBreathParts {
  readonly server: FakeServer;
}

/** `entities.js:470-475` for the bot's own entity: the packet's metadata filed at the player's `air_supply` key. */
function fileAirSupply(bot: FakeBot, ticks: number): void {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  if (index < 0) throw new Error("no air_supply metadata for a player");
  Reflect.set(bot.entity.metadata, index, ticks);
  bot.emit("entityUpdate", bot.entity);
}

/** Give `bot` its air: a server tick per `FakeServer.onTick` and `oxygenLevel` as the client reads it. */
export function attachFakeBreath(bot: FakeBot, parts: FakeBreathParts): FakeBreath {
  let air = FULL_AIR;
  let level = bot.oxygenLevel;
  let followed: { readonly body: FakeBot["entity"] } | undefined;
  /** The client hears `ticks`: the metadata, then `oxygenLevel` and `breath` as `entities.js:515-518` do. */
  const hear = (ticks: number) => {
    fileAirSupply(bot, ticks);
    level = Math.round(ticks / TICKS_PER_BUBBLE);
    bot.emit("breath");
  };
  let held = false;
  // The packet of a tick is heard in that tick, whatever the server's answer lag: the game sends the metadata of the tick that changed it (`ServerEntity.sendChanges` after `LivingEntity.baseTick`, vanilla source; contract check `air-supply-under-water`, 3 runs of 2026-10-23 on a server on time: a packet a tick, spans within 3 ms). Not measured under a lag: it follows the time packets and the fireballs' updates, which the fake does not delay either (`lagMs` delays the answers to the client's acts).
  onServerTick(parts.server, () => {
    if (held) return;
    // Other fake scenes still place the body directly, including vehicle scenes that keep a last dismount position.
    const feet = followed?.body === bot.entity ? parts.server.serverPositionOf(bot.entity.id) : null;
    const wet = botEyesInWater(bot, feet ?? bot.entity.position, eyeHeightOf(bot.entity));
    const next = wet ? Math.max(0, air - AIR_LOST_PER_TICK) : Math.min(FULL_AIR, air + AIR_GAINED_PER_TICK);
    if (next === air) return;
    air = next;
    hear(air);
  });
  // Mineflayer's `oxygenLevel` is a plain property the packet writes; this one is too, with the level also kept here
  // so a test replacing the property (`waterFixture`) leaves the packet's write alone.
  Object.defineProperty(bot, "oxygenLevel", { get: () => level, set: (value: number) => void (level = value), configurable: true });
  return {
    get airSupply() {
      return air;
    },
    setAirSupply(ticks) {
      air = ticks;
      hear(air);
    },
    hold(ticks) {
      held = true;
      air = ticks;
      parts.server.answer(() => hear(ticks));
    },
    release() {
      held = false;
    },
    get held() {
      return held;
    },
    followServerFeet() {
      const scope = { body: bot.entity };
      followed = scope;
      const clear = () => {
        bot.off("respawn", clear);
        if (followed === scope) followed = undefined;
      };
      bot.once("respawn", clear);
      return { [Symbol.dispose]: clear };
    },
  };
}
