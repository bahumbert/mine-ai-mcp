/**
 * The fake bot's air: the server counts it down while the eye is under water and refills it out of the water, and
 * the client learns it only from the player's `air_supply` entity metadata, which Mineflayer turns into
 * `oxygenLevel` and a `breath` event (`entities.js:515-518`). Rates as measured on a 1.21.4 server by the contract
 * check `air-supply-under-water`. Not modelled: the server's ticks a second (`ticksPerSecond` moves the world age, the air always
 * ticks 20 a second), the air below 0 (drowning damage and its reset), Respiration, creative immunity.
 */
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeServer } from "./fake-server.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import { onServerTick } from "./fake-bot-server-ticks.js";

/** The full air (`LivingEntity.getMaxAirSupply`): 15 ticks a bubble, 20 bubbles; its client reading is `Math.round(air / 15)`. */
const FULL_AIR = 300;
const TICKS_PER_BUBBLE = 15;
/** Air lost per server tick under water and gained per tick out of it (contract check `air-supply-under-water`). */
const AIR_LOST_PER_TICK = 1;
const AIR_GAINED_PER_TICK = 4;
/** `Entity.updateFluidOnEyes`: the point a ninth of a block under the eye is tested against the fluid of its cell. */
const EYE_FLUID_MARGIN = 1 / 9;
/** Blocks whose fluid is water in the game (a waterlogged block is read from its property). */
const WATER_BLOCKS = ["water", "kelp", "kelp_plant", "seagrass", "tall_seagrass", "bubble_column"];

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
}

export interface FakeBreathParts {
  readonly clock: FakeClock;
  readonly server: FakeServer;
}

/** Whether the cell holds water: a water-like block, or a block with `waterlogged` set. */
function holdsWater(cell: { readonly name: string; getProperties?(): unknown } | null): boolean {
  if (cell === null) return false;
  if (WATER_BLOCKS.includes(cell.name)) return true;
  // A test's own block may carry no properties.
  const properties = (cell.getProperties?.() ?? {}) as Readonly<Record<string, unknown>>;
  return String(properties.waterlogged) === "true";
}

/**
 * Whether the eye is in water as the game decides it (`Entity.updateFluidOnEyes`; the rule is the game's own, not
 * measured except for the source cell and air by the contract check): the point a ninth under the eye lies in a cell
 * holding water and under its top, which is the whole cell when water lies above and else 8/9 for a source, a
 * waterlogged block or a plant, (8 - level) / 9 for a flowing cell. An unloaded cell is not water.
 */
function eyeInWater(bot: FakeBot): boolean {
  const point = bot.entity.position.offset(0, eyeHeightOf(bot.entity) - EYE_FLUID_MARGIN, 0);
  const cell = bot.blockAt(point);
  if (!holdsWater(cell)) return false;
  const cellY = Math.floor(point.y);
  if (holdsWater(bot.blockAt(point.offset(0, 1, 0)))) return point.y < cellY + 1;
  const level = Number(((cell!.getProperties?.() ?? {}) as Readonly<Record<string, unknown>>).level ?? 0);
  const fluidHeight = level === 0 || level >= 8 ? 8 / 9 : (8 - level) / 9;
  return point.y < cellY + fluidHeight;
}

/** `entities.js:470-475` for the bot's own entity: the packet's metadata filed at the player's `air_supply` key. */
function fileAirSupply(bot: FakeBot, ticks: number): void {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  if (index < 0) throw new Error("no air_supply metadata for a player");
  Reflect.set(bot.entity.metadata, index, ticks);
  bot.emit("entityUpdate", bot.entity);
}

/** Give `bot` its air: a server tick each 50 ms of `parts.clock` and `oxygenLevel` as the client reads it. */
export function attachFakeBreath(bot: FakeBot, parts: FakeBreathParts): FakeBreath {
  let air = FULL_AIR;
  let level = bot.oxygenLevel;
  /** The client hears `ticks`: the metadata, then `oxygenLevel` and `breath` as `entities.js:515-518` do. */
  const hear = (ticks: number) => {
    fileAirSupply(bot, ticks);
    level = Math.round(ticks / TICKS_PER_BUBBLE);
    bot.emit("breath");
  };
  const send = (ticks: number) => parts.server.answer(() => hear(ticks));
  let held = false;
  onServerTick(parts.clock, parts.server, () => {
    if (held) return;
    const next = eyeInWater(bot) ? Math.max(0, air - AIR_LOST_PER_TICK) : Math.min(FULL_AIR, air + AIR_GAINED_PER_TICK);
    if (next === air) return;
    air = next;
    send(air);
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
      send(air);
    },
    release() {
      held = false;
    },
    get held() {
      return held;
    },
  };
}
