/**
 * The fake bot's server side: the world age as the game sends it, answers that come late or not at all, and what the
 * server knows that the client is never told (who sits in a vehicle).
 */
import type { Vec3 } from "vec3";
import type { FakeClock } from "./fake-clock.js";
import { type ServerWeather, type Weather, type WeatherPacket, createServerWeather, skyAllowsSleep } from "./fake-weather.js";

export type { Weather, WeatherPacket };

/** One time packet per 20 server ticks at any speed, a second of them on time (`facts/runtime-pitfalls.md` "The server's answer, not a guess of its delay"; "Time packets": measured at 20 ticks a second by T7d1 and at 8 by R16). */
const TICKS_PER_TIME_PACKET = 20;
const ONE_SECOND_MS = 1_000;
const TICKS_PER_DAY = 24_000;
/** The ticks a second of a server on time; a server at this rate catches up after a stall, one below it cannot. */
const ON_TIME_TICKS_PER_SECOND = 20;
/**
 * The stall rule of vanilla `MinecraftServer.runServer` (read in its source, not measured here): a server that stalled
 * runs the ticks it owes back to back; when it owes more than 2000 ms and its last "Can't keep up!" warning is 15 s or
 * more old, it warns and drops them; a second long stall inside those 15 s is caught up in full.
 */
const STALL_DROPPED_OVER_MS = 2_000;
const STALL_WARNING_EVERY_MS = 15_000;

export interface FakeServerOptions {
  readonly startAge?: number;
  readonly timeOfDay?: number;
  /** How long every answer takes, in ms of clock. */
  readonly lagMs?: number;
  /** Where in each second the time packet falls (0-999 ms after the server starts); a server on time only: another `ticksPerSecond` with a phase is refused. */
  readonly phaseMs?: number;
  /**
   * Ticks a second of running clock: 20 on time; fewer for a server behind its schedule (Cleo ~30 % behind,
   * `facts/navigation-and-boats.md`) or set to a lower `tick rate`. The time packets keep to 20 ticks each, so a server below
   * 20 sends them further apart (one per 2.5 s at 8). A server below 20 never catches up after a stop. A whole number.
   */
  readonly ticksPerSecond?: number;
  /** The weather the world starts in, its levels already full; clear when omitted. */
  readonly weather?: Weather;
  /** False: no time packet has come yet, so the client has no age (`time.js` starts all null) until the first one. Default true. */
  readonly timePacketYet?: boolean;
}

export interface ReceivedPacket {
  readonly name: string;
  readonly data: unknown;
  /** The clock's reading when the client wrote it. */
  readonly atMs: number;
}

export interface FakeServer {
  readonly age: number;
  /**
   * The ticks the game has run (`time query gametime`), the one counter every subsystem of the fake counts (`onTick`): `ticksPerSecond` a
   * second of the clock the server ran, none while it is stopped. A stop at 20 ticks a second is caught up at `resume()` (the owed ticks run
   * at once) unless it passed 2000 ms and no stall was dropped in the last 15 s; below 20 nothing is caught up. The client's `age` is this
   * value as of a packet, so never ahead of it.
   */
  readonly gameTime: number;
  /** Call `listener` once per server tick, in order, with `gameTime` already at that tick; a listener added during a tick hears the next one. */
  onTick(listener: () => void): () => void;
  readonly timeOfDay: number;
  /** The day time unwrapped (`bot.time.time`): `timeOfDay` is it modulo a day. */
  readonly dayTime: number;
  readonly isRunning: boolean;
  /** Whether a time packet has been sent: until then the client's `bot.time` holds nulls. */
  readonly timePacketSent: boolean;
  /** Every packet the client wrote (`bot._client.write`), in order. */
  readonly packets: readonly ReceivedPacket[];
  /** Freeze the server: no tick, time packet or answer until `resume`, while the clock goes on. */
  stop(): void;
  /** Run again. A stop the game catches up is caught up here (`gameTime` has moved when this returns), the answers queued during it after its first tick. */
  resume(): void;
  /** Run `answer` after `lagMs` of clock, on a later tick than the call (never inside it): at the start of the next tick, or at the end of the slice when none falls in it. */
  answer(answer: () => void): void;
  onTimePacket(listener: () => void): () => void;
  /** `/weather`: the levels ramp toward it a hundredth a tick and the client hears each step. */
  setWeather(weather: Weather): void;
  /** Whether the server counts the weather as rain (its rain level above 0.2), whatever the client heard. */
  readonly raining: boolean;
  /** The server's levels (0 to 1), ahead of what the client heard by the packets in flight. */
  readonly rainLevel: number;
  readonly thunderLevel: number;
  /** Whether the sky is dark enough to sleep under, at the day time and in the weather now (`!Level.isDay`). */
  readonly skyAllowsSleep: boolean;
  /** What a client joining now is told of the weather. */
  weatherJoinPackets(): WeatherPacket[];
  /** React to the `game_state_change` packets the server sends. */
  onWeatherPacket(listener: (packet: WeatherPacket) => void): () => void;
  /** Set the day time and tell the client at once (`ServerLevel.setDayTime`: the skip of a night). */
  setDayTime(ticks: number): void;
  /**
   * The extra time packet the game sends at each `/time set` (any player's), the day time as it is: its age is the world's
   * now (`gameTime`), so it falls off the regular packets' cadence (same age mod the packet's ticks) unless it lands in
   * the tick of one, then it repeats that packet's age.
   */
  resendTime(): void;
  /** The server's record of who sits in `vehicleId` (an entity id), which the client never hears about: the first rider. */
  riderOf(vehicleId: number): number | null;
  /** Every rider of `vehicleId`, in the order they sat (a boat has two seats). */
  ridersOf(vehicleId: number): readonly number[];
  seatRider(vehicleId: number, riderId: number): void;
  /** `riderId` leaves `vehicleId`; without one, everyone does. */
  freeRider(vehicleId: number, riderId?: number): void;
  /** Record a packet the client wrote and hand it to the handlers of its name. */
  receive(name: string, data: unknown): void;
  /** React to the client's packets of `name` (the server's side of a dig, a placement, a shift). */
  onPacket(name: string, handler: (data: unknown) => void): () => void;
  /** Where the server has an entity, when it differs from the client's belief (a rider let off at the boat's top). */
  serverPositionOf(entityId: number): Vec3 | null;
  setServerPosition(entityId: number, position: Vec3): void;
  /** Every `position` packet sent to the client, in order. */
  readonly sentPositions: readonly Vec3[];
  /** Send the client a `position` packet (mineflayer restarts physics on it). */
  sendPosition(position: Vec3): void;
  onPosition(listener: (position: Vec3) => void): () => void;
}

interface PendingAnswer {
  readonly dueMs: number;
  readonly run: () => void;
}

/**
 * The server's ticks, the one counter of the fake: `serverMs` is the time the server has run (a stop it does not catch up
 * adds none), a tick falls at each `1000 / ticksPerSecond` ms of it, and `gameTime` is `startAge` plus the ticks run.
 * The server has already run `1000 - phaseMs` ms when the clock starts (when `phaseMs` is not 0), so the first time
 * packet falls `phaseMs` ms in and the ticks run at the same rate at any phase.
 */
function createServerTicks(options: FakeServerOptions) {
  const phaseMs = options.phaseMs ?? 0;
  if (phaseMs < 0 || phaseMs >= ONE_SECOND_MS) throw new RangeError(`phaseMs ${phaseMs}: 0 to 999`);
  const ticksPerSecond = options.ticksPerSecond ?? ON_TIME_TICKS_PER_SECOND;
  if (!Number.isInteger(ticksPerSecond) || ticksPerSecond < 1) throw new RangeError(`ticksPerSecond ${ticksPerSecond}: a whole number from 1`);
  if (phaseMs > 0 && ticksPerSecond !== ON_TIME_TICKS_PER_SECOND) throw new RangeError(`phaseMs ${phaseMs} with ticksPerSecond ${ticksPerSecond}: a phase is the packet's place in the second of a server on time (20)`);
  const startAge = options.startAge ?? 24_000;
  let serverMs = phaseMs > 0 ? ONE_SECOND_MS - phaseMs : 0;
  let ticksRun = Math.floor((serverMs * ticksPerSecond) / ONE_SECOND_MS);
  const listeners = new Set<() => void>();
  return {
    ticksPerSecond,
    /** The ticks run so far, the ones of the first `phaseMs` ms included. */
    get ticksRun() {
      return ticksRun;
    },
    /**
     * The server runs `ms` of its own time: each tick that falls in it, in order (the listeners of a tick are those at its
     * start), while `keepGoing` holds; ticks left undone when it stops are run by the next call. `afterFirstTick` runs once,
     * right after the first tick of this call (when none falls in it, never). Returns the ticks run.
     */
    run(ms: number, keepGoing: () => boolean, afterFirstTick?: () => void): number {
      serverMs += ms;
      const ticksDue = Math.floor((serverMs * ticksPerSecond) / ONE_SECOND_MS + 1e-9);
      const ticksBefore = ticksRun;
      for (let first = true; ticksRun < ticksDue && keepGoing(); first = false) {
        ticksRun += 1;
        for (const listener of [...listeners]) if (listeners.has(listener)) listener();
        if (first) afterFirstTick?.();
      }
      // A stop inside a tick leaves the slice's other ticks undone: the server has run only to its last tick, so a later slice does not owe them.
      if (ticksRun < ticksDue) serverMs = (ticksRun * ONE_SECOND_MS) / ticksPerSecond;
      return ticksRun - ticksBefore;
    },
    api: {
      get gameTime() {
        return startAge + ticksRun;
      },
      onTick(listener: () => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    } satisfies Pick<FakeServer, "gameTime" | "onTick">,
  };
}

/** Run, in order, every answer due by `nowMs`, and keep the rest. */
function runDueAnswers(pending: PendingAnswer[], nowMs: number): PendingAnswer[] {
  const due = pending.filter((answer) => answer.dueMs <= nowMs);
  for (const answer of due) answer.run();
  return pending.filter((answer) => !due.includes(answer));
}

/** The packets the client wrote, in order, and the handlers of each name (`receive`, `onPacket`). */
function createClientPackets(clock: FakeClock): Pick<FakeServer, "packets" | "receive" | "onPacket"> {
  const packets: ReceivedPacket[] = [];
  const packetHandlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    packets,
    receive(name, data) {
      packets.push({ name, data, atMs: clock.now() });
      for (const handler of [...(packetHandlers.get(name) ?? [])]) handler(data);
    },
    onPacket(name, handler) {
      const handlers = packetHandlers.get(name) ?? new Set();
      packetHandlers.set(name, handlers.add(handler));
      return () => void handlers.delete(handler);
    },
  };
}

/** Where the server has entities when it differs from the client's, and the `position` packets it sends. */
function createPositions(): Pick<FakeServer, "serverPositionOf" | "setServerPosition" | "sentPositions" | "sendPosition" | "onPosition"> {
  const positionListeners = new Set<(position: Vec3) => void>();
  const serverPositions = new Map<number, Vec3>();
  const sentPositions: Vec3[] = [];
  return {
    serverPositionOf: (entityId) => serverPositions.get(entityId) ?? null,
    setServerPosition: (entityId, position) => void serverPositions.set(entityId, position.clone()),
    sentPositions,
    sendPosition(position) {
      sentPositions.push(position.clone());
      for (const listener of [...positionListeners]) listener(position);
    },
    onPosition(listener) {
      positionListeners.add(listener);
      return () => void positionListeners.delete(listener);
    },
  };
}

/** The server's record of riders: `riderId` sits last in `vehicleId`. */
function seatInRecord(riders: Map<number, number[]>, vehicleId: number, riderId: number): void {
  riders.set(vehicleId, [...(riders.get(vehicleId) ?? []).filter((id) => id !== riderId), riderId]);
}

/** `riderId` leaves `vehicleId` in the record; without one, everyone does. */
function freeFromRecord(riders: Map<number, number[]>, vehicleId: number, riderId?: number): void {
  const left = riderId === undefined ? [] : (riders.get(vehicleId) ?? []).filter((id) => id !== riderId);
  if (left.length === 0) riders.delete(vehicleId);
  else riders.set(vehicleId, left);
}

/** The server's record of who sits in which vehicle, which the client never hears about. */
function createRiders(): Pick<FakeServer, "riderOf" | "ridersOf" | "seatRider" | "freeRider"> {
  const riders = new Map<number, number[]>();
  return {
    riderOf: (vehicleId) => riders.get(vehicleId)?.[0] ?? null,
    ridersOf: (vehicleId) => riders.get(vehicleId) ?? [],
    seatRider: (vehicleId, riderId) => seatInRecord(riders, vehicleId, riderId),
    freeRider: (vehicleId, riderId) => freeFromRecord(riders, vehicleId, riderId),
  };
}

/** The `game_state_change` packets of the weather: `send` queues one as a server answer, `onWeatherPacket` hears them. */
function createWeatherChannel(answer: (run: () => void) => void) {
  const listeners = new Set<(packet: WeatherPacket) => void>();
  return {
    send: (packet: WeatherPacket) => answer(() => void [...listeners].forEach((listener) => listener(packet))),
    onWeatherPacket(listener: (packet: WeatherPacket) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** The weather as the server states it: its levels, what a joining client is told, `/weather`, and the sky that lets a player sleep. */
function weatherApi(
  weather: ServerWeather,
  dayTime: () => number,
): Pick<FakeServer, "raining" | "rainLevel" | "thunderLevel" | "skyAllowsSleep" | "setWeather" | "weatherJoinPackets"> {
  return {
    get raining() {
      return weather.raining;
    },
    get rainLevel() {
      return weather.rainLevel;
    },
    get thunderLevel() {
      return weather.thunderLevel;
    },
    get skyAllowsSleep() {
      return skyAllowsSleep(weather.skyDarken(dayTime()));
    },
    setWeather: (next) => weather.set(next),
    weatherJoinPackets: () => weather.joinPackets(),
  };
}

/**
 * The world age and day time the client is told, and the time packets that tell it: a regular one every 20 ticks at any
 * speed (a second of the server's running time on time, so a stop that was dropped or not caught up delays the next one), and the
 * extras (`setDayTime`, `resendTime`). The age of a regular packet is the game time of its tick.
 */
function createWorldTime(options: FakeServerOptions, ticks: ReturnType<typeof createServerTicks>) {
  let age = options.startAge ?? 24_000;
  let dayTime = options.timeOfDay ?? 6_000;
  let timePacketSent = options.timePacketYet !== false;
  const timeListeners = new Set<() => void>();
  const sendTimePacket = () => {
    timePacketSent = true;
    for (const listener of [...timeListeners]) listener();
  };
  // Vanilla sends the time every 20 ticks (`MinecraftServer.tickChildren`) whatever the rate: measured at 8 ticks a second by the
  // contract check `world-age-at-slow-tick` (ages step 20, 2.5 s apart); a server lagging behind 20 is the same by the source, unmeasured.
  ticks.api.onTick(() => {
    if (ticks.ticksRun % TICKS_PER_TIME_PACKET !== 0) return;
    age = ticks.api.gameTime;
    dayTime += TICKS_PER_TIME_PACKET;
    sendTimePacket();
  });
  return {
    api: {
      get age() {
        return age;
      },
      get timeOfDay() {
        return dayTime % TICKS_PER_DAY;
      },
      get dayTime() {
        return dayTime;
      },
      get timePacketSent() {
        return timePacketSent;
      },
      setDayTime(next: number) {
        dayTime = next;
        sendTimePacket();
      },
      resendTime() {
        age = ticks.api.gameTime;
        sendTimePacket();
      },
      onTimePacket(listener: () => void) {
        timeListeners.add(listener);
        return () => void timeListeners.delete(listener);
      },
    } satisfies Pick<FakeServer, "age" | "timeOfDay" | "dayTime" | "timePacketSent" | "setDayTime" | "resendTime" | "onTimePacket">,
  };
}

/** What the game does with a stall of `owedMs` that ends at `nowMs`: run its ticks at once, drop them, or (a server below 20 ticks a second) leave them. */
function stallOutcome(owedMs: number, nowMs: number, lastDropMs: number | null, ticksPerSecond: number): "catch up" | "drop" | "leave" {
  if (ticksPerSecond < ON_TIME_TICKS_PER_SECOND || owedMs <= 0) return "leave";
  const warnedRecently = lastDropMs !== null && nowMs - lastDropMs < STALL_WARNING_EVERY_MS;
  return owedMs > STALL_DROPPED_OVER_MS && !warnedRecently ? "drop" : "catch up";
}

export function createFakeServer(clock: FakeClock, options: FakeServerOptions = {}): FakeServer {
  const lagMs = options.lagMs ?? 0;
  const ticks = createServerTicks(options);
  const time = createWorldTime(options, ticks);
  const weather = createServerWeather(options.weather);
  let running = true;
  let lastSliceMs = clock.now();
  /** Where the clock stood when the server stopped, and when a stall was last dropped. */
  let stoppedAtMs = lastSliceMs;
  let lastDropMs: number | null = null;
  let pending: PendingAnswer[] = [];

  const answer = (run: () => void) => void pending.push({ dueMs: clock.now() + lagMs, run });
  const weatherChannel = createWeatherChannel(answer);
  // The weather advances a level step each server tick.
  ticks.api.onTick(() => weather.tick().forEach(weatherChannel.send));
  const answerDue = () => void (pending = runDueAnswers(pending, clock.now()));
  /** Whether the ticks running are a stall's owed ones, whose answers wait for the first of them to end. */
  let catchingUp = false;
  // The answers due are handled at the start of a tick's work, after the time packet and the weather and before every other listener's.
  ticks.api.onTick(() => catchingUp || answerDue());

  clock.onSlice("server", () => {
    const sliceMs = clock.now() - lastSliceMs;
    lastSliceMs = clock.now();
    if (!running) return;
    // A slice shorter than a tick (a clock stepped by 1 ms) still answers what is due.
    if (ticks.run(sliceMs, () => running) === 0 && running) answerDue();
  });

  /** Run the ticks a stall owes at once; the packets that came in during it are handled in the first tick after it. */
  const catchUp = (owedMs: number) => {
    catchingUp = true;
    try {
      ticks.run(owedMs, () => running, () => ((catchingUp = false), answerDue()));
    } finally {
      catchingUp = false;
    }
  };
  const stop = () => {
    if (!running) return;
    running = false;
    stoppedAtMs = lastSliceMs;
  };
  const resume = () => {
    if (running) return;
    running = true;
    const nowMs = clock.now();
    lastSliceMs = nowMs;
    const outcome = stallOutcome(nowMs - stoppedAtMs, nowMs, lastDropMs, ticks.ticksPerSecond);
    if (outcome === "drop") lastDropMs = nowMs;
    if (outcome === "catch up") catchUp(nowMs - stoppedAtMs);
  };

  const server = {
    get isRunning() {
      return running;
    },
    onWeatherPacket: weatherChannel.onWeatherPacket,
    ...createClientPackets(clock),
    ...createPositions(),
    stop,
    resume,
    answer,
    ...createRiders(),
  };
  // Getters are copied as getters (a spread would read them once).
  return Object.defineProperties(server, {
    ...Object.getOwnPropertyDescriptors(time.api),
    ...Object.getOwnPropertyDescriptors(ticks.api),
    ...Object.getOwnPropertyDescriptors(weatherApi(weather, () => time.api.dayTime)),
  }) as FakeServer;
}
