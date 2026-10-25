/**
 * The server's weather as the client is told it (contract check `rain-and-thunder-state`, Mine Labs 2026-10-23): `/weather`
 * moves the rain level and the thunder level toward 1 or 0 a hundredth a server tick, each tick's level is one `game_state_change`
 * packet, and `start_raining` / `stop_raining` flip with the raining flag. Not measured: the weather cycle (it never changes on its own).
 */

/** The weather an operator sets (`/weather`). */
export type Weather = "clear" | "rain" | "thunder";

/** A `game_state_change` packet by the reason's name, `gameMode` carrying the level (`rain.js:21-33`). */
export interface WeatherPacket {
  readonly reason: "start_raining" | "stop_raining" | "rain_level_change" | "thunder_level_change";
  readonly gameMode: number;
}

/** Level change a server tick (`ServerLevel.advanceWeatherCycle`; the check measured 0.01 +-1e-5 and a hundred steps). */
const LEVEL_STEP = 0.01;
const TICKS_PER_DAY = 24_000;
/** `Level.isRaining`: the rain level above this is rain (the flag flip is announced then; 102 updates for the 100 steps of the check). */
const RAIN_THRESHOLD = 0.2;
/** `Level.isDay`: the sky is dark enough to sleep from this `skyDarken` on. */
const SLEEP_SKY_DARKEN = 4;

export interface ServerWeather {
  /** The server's own levels, whether or not the client heard of them. */
  readonly rainLevel: number;
  readonly thunderLevel: number;
  /** `Level.isRaining`: the rain level is above 0.2, on the way up or down. */
  readonly raining: boolean;
  /** What a client joining now is told. */
  joinPackets(): WeatherPacket[];
  /** `/weather`: set the flags the levels move toward; the packets follow on the next tick. */
  set(weather: Weather): void;
  /** One server tick: the flag change, then the levels a step, each as the packet the client hears. */
  tick(): WeatherPacket[];
  /** `ServerLevel.updateSkyBrightness`: how dark the sky is at `dayTime` in this weather (0 bright, 11 darkest). */
  skyDarken(dayTime: number): number;
}

/** `DimensionType.timeOfDay`: the sun's angle as a fraction of a turn for a day time. */
function celestialAngle(dayTime: number): number {
  const fraction = (dayTime % TICKS_PER_DAY) / TICKS_PER_DAY - 0.25;
  const wrapped = fraction - Math.floor(fraction);
  const smoothed = 0.5 - Math.cos(wrapped * Math.PI) / 2;
  return (wrapped * 2 + smoothed) / 3;
}

const moveToward = (level: number, target: number): number => (target > level ? Math.min(target, level + LEVEL_STEP) : Math.max(target, level - LEVEL_STEP));

/** The weather of a server that starts as `start`, its levels already at the end of the ramp. */
export function createServerWeather(start: Weather = "clear"): ServerWeather {
  let rainWanted = start !== "clear";
  let thundering = start === "thunder";
  let rainLevel = rainWanted ? 1 : 0;
  let announcedRaining = rainLevel > RAIN_THRESHOLD;
  let thunderLevel = thundering ? 1 : 0;
  return {
    get rainLevel() {
      return rainLevel;
    },
    get thunderLevel() {
      return thunderLevel;
    },
    get raining() {
      return rainLevel > RAIN_THRESHOLD;
    },
    joinPackets: () => [
      ...(rainLevel > RAIN_THRESHOLD ? [{ reason: "start_raining" as const, gameMode: 0 }] : []),
      { reason: "rain_level_change", gameMode: rainLevel },
      { reason: "thunder_level_change", gameMode: thunderLevel },
    ],
    set(weather) {
      rainWanted = weather !== "clear";
      thundering = weather === "thunder";
    },
    tick() {
      const packets: WeatherPacket[] = [];
      const nextRain = moveToward(rainLevel, rainWanted ? 1 : 0);
      const nextThunder = moveToward(thunderLevel, thundering ? 1 : 0);
      if (nextRain !== rainLevel) packets.push({ reason: "rain_level_change", gameMode: nextRain });
      if (nextThunder !== thunderLevel) packets.push({ reason: "thunder_level_change", gameMode: nextThunder });
      rainLevel = nextRain;
      thunderLevel = nextThunder;
      // The flag flips as the level crosses 0.2: the start or stop, then both levels again (`ServerLevel.advanceWeatherCycle`, from the 102 updates measured).
      if ((rainLevel > RAIN_THRESHOLD) !== announcedRaining) {
        announcedRaining = rainLevel > RAIN_THRESHOLD;
        packets.push(
          { reason: announcedRaining ? "start_raining" : "stop_raining", gameMode: 0 },
          { reason: "rain_level_change", gameMode: rainLevel },
          { reason: "thunder_level_change", gameMode: thunderLevel },
        );
      }
      return packets;
    },
    skyDarken(dayTime) {
      const rain = 1 - (rainLevel * 5) / 16;
      // `getThunderLevel` is the thunder level scaled by the rain level.
      const thunder = 1 - (thunderLevel * rainLevel * 5) / 16;
      const sun = 0.5 + 2 * Math.max(-0.25, Math.min(0.25, Math.cos(celestialAngle(dayTime) * 2 * Math.PI)));
      return Math.trunc((1 - sun * rain * thunder) * 11);
    },
  };
}

/** Whether a sky this dark lets a player sleep (`!Level.isDay`). */
export const skyAllowsSleep = (skyDarken: number): boolean => skyDarken >= SLEEP_SKY_DARKEN;
