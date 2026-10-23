/**
 * The fake bot's server side: the world age as the game sends it, answers that come late or not at all, and what the
 * server knows that the client is never told (who sits in a vehicle).
 */
import type { Vec3 } from "vec3";
import type { FakeClock } from "./fake-clock.js";
import { type ServerWeather, type Weather, type WeatherPacket, createServerWeather, skyAllowsSleep } from "./fake-weather.js";

export type { Weather, WeatherPacket };

/** One time packet a second (`facts/runtime-pitfalls.md` "The server's answer, not a guess of its delay"). */
const TIME_PACKET_EVERY_MS = 1_000;
const TICKS_PER_DAY = 24_000;
const TICK_MS = 50;

export interface FakeServerOptions {
  readonly startAge?: number;
  readonly timeOfDay?: number;
  /** How long every answer takes, in ms of clock. */
  readonly lagMs?: number;
  /** Where in each second the time packet falls (0-999 ms after the server starts). */
  readonly phaseMs?: number;
  /**
   * Ticks one time packet adds: 20 on time; fewer for a server behind its schedule, which still sends one packet a
   * second of wall time (Cleo ~30 % behind, `facts/navigation-and-boats.md`; `tick rate 2`).
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
  readonly timeOfDay: number;
  /** The day time unwrapped (`bot.time.time`): `timeOfDay` is it modulo a day. */
  readonly dayTime: number;
  readonly isRunning: boolean;
  /** Whether a time packet has been sent: until then the client's `bot.time` holds nulls. */
  readonly timePacketSent: boolean;
  /** Every packet the client wrote (`bot._client.write`), in order. */
  readonly packets: readonly ReceivedPacket[];
  /** Freeze the server: no time packet and no answer until `resume`, while the clock goes on. */
  stop(): void;
  resume(): void;
  /** Run `answer` after `lagMs` of clock, on a later slice than the call (never inside it). */
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

/** How many time packets fall in the slice `(fromMs, toMs]` of server time. */
function timePacketsBetween(fromMs: number, toMs: number, phaseMs: number): number {
  // Packets fall at every t > 0 with t ≡ phaseMs (mod 1000): at 1000, 2000... for phase 0, at 999, 1999... for 999.
  const packetsUpTo = (ms: number) => (ms <= 0 ? 0 : Math.floor((ms - phaseMs) / TIME_PACKET_EVERY_MS) + (phaseMs > 0 ? 1 : 0));
  return Math.max(0, packetsUpTo(toMs) - packetsUpTo(fromMs));
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

export function createFakeServer(clock: FakeClock, options: FakeServerOptions = {}): FakeServer {
  const lagMs = options.lagMs ?? 0;
  const phaseMs = options.phaseMs ?? 0;
  if (phaseMs < 0 || phaseMs >= TIME_PACKET_EVERY_MS) throw new RangeError(`phaseMs ${phaseMs}: 0 to 999`);
  const ticksPerPacket = options.ticksPerSecond ?? 20;
  const startedAtMs = clock.now();
  let age = options.startAge ?? 24_000;
  let dayTime = options.timeOfDay ?? 6_000;
  const weather = createServerWeather(options.weather);
  let timePacketSent = options.timePacketYet !== false;
  let tickAccumulatedMs = 0;
  let running = true;
  let lastSliceMs = startedAtMs;
  let pending: PendingAnswer[] = [];
  const timeListeners = new Set<() => void>();

  const sendTimePacket = () => {
    timePacketSent = true;
    for (const listener of [...timeListeners]) listener();
  };
  const answer = (run: () => void) => void pending.push({ dueMs: clock.now() + lagMs, run });
  const weatherChannel = createWeatherChannel(answer);

  clock.onSlice("server", (sliceMs) => {
    const nowMs = clock.now();
    const packetCount = running ? timePacketsBetween(lastSliceMs - startedAtMs, nowMs - startedAtMs, phaseMs) : 0;
    lastSliceMs = nowMs;
    for (let packet = 0; packet < packetCount; packet += 1) {
      age += ticksPerPacket;
      dayTime += ticksPerPacket;
      sendTimePacket();
    }
    // The weather advances a level step each server tick of 50 ms (the air of `fake-bot-breath.ts` counts the same way).
    if (running) {
      for (tickAccumulatedMs += sliceMs; tickAccumulatedMs >= TICK_MS; tickAccumulatedMs -= TICK_MS) weather.tick().forEach(weatherChannel.send);
    }
    if (running) pending = runDueAnswers(pending, nowMs);
  });

  const server: Omit<FakeServer, keyof ReturnType<typeof weatherApi>> = {
    get age() {
      return age;
    },
    get timeOfDay() {
      return dayTime % TICKS_PER_DAY;
    },
    get dayTime() {
      return dayTime;
    },
    get isRunning() {
      return running;
    },
    get timePacketSent() {
      return timePacketSent;
    },
    onWeatherPacket: weatherChannel.onWeatherPacket,
    setDayTime(ticks) {
      dayTime = ticks;
      sendTimePacket();
    },
    ...createClientPackets(clock),
    ...createPositions(),
    stop: () => void (running = false),
    resume: () => void (running = true),
    answer,
    onTimePacket(listener) {
      timeListeners.add(listener);
      return () => void timeListeners.delete(listener);
    },
    ...createRiders(),
  };
  // Getters are copied as getters (a spread would read them once).
  return Object.defineProperties(server, Object.getOwnPropertyDescriptors(weatherApi(weather, () => dayTime))) as FakeServer;
}
