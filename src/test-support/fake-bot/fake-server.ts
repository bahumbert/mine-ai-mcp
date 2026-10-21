/**
 * The fake bot's server side: the world age as the game sends it, answers that come late or not at all, and what the
 * server knows that the client is never told (who sits in a vehicle).
 */
import type { Vec3 } from "vec3";
import type { FakeClock } from "./fake-clock.js";

/** One time packet a second (`facts/runtime-pitfalls.md` "The server's answer, not a guess of its delay"). */
const TIME_PACKET_EVERY_MS = 1_000;
const TICKS_PER_DAY = 24_000;

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
  /** Every packet the client wrote (`bot._client.write`), in order. */
  readonly packets: readonly ReceivedPacket[];
  /** Freeze the server: no time packet and no answer until `resume`, while the clock goes on. */
  stop(): void;
  resume(): void;
  /** Run `answer` after `lagMs` of clock, on a later slice than the call (never inside it). */
  answer(answer: () => void): void;
  onTimePacket(listener: () => void): () => void;
  /** The server's record of who sits in `vehicleId` (an entity id), which the client never hears about. */
  riderOf(vehicleId: number): number | null;
  seatRider(vehicleId: number, riderId: number): void;
  freeRider(vehicleId: number): void;
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

export function createFakeServer(clock: FakeClock, options: FakeServerOptions = {}): FakeServer {
  const lagMs = options.lagMs ?? 0;
  const phaseMs = options.phaseMs ?? 0;
  if (phaseMs < 0 || phaseMs >= TIME_PACKET_EVERY_MS) throw new RangeError(`phaseMs ${phaseMs}: 0 to 999`);
  const ticksPerPacket = options.ticksPerSecond ?? 20;
  const startedAtMs = clock.now();
  let age = options.startAge ?? 24_000;
  let dayTime = options.timeOfDay ?? 6_000;
  let running = true;
  let lastSliceMs = startedAtMs;
  let pending: PendingAnswer[] = [];
  const packets: ReceivedPacket[] = [];
  const riders = new Map<number, number>();
  const timeListeners = new Set<() => void>();
  const positionListeners = new Set<(position: Vec3) => void>();
  const packetHandlers = new Map<string, Set<(data: unknown) => void>>();
  const serverPositions = new Map<number, Vec3>();
  const sentPositions: Vec3[] = [];

  clock.onSlice("server", () => {
    const nowMs = clock.now();
    const packetCount = running ? timePacketsBetween(lastSliceMs - startedAtMs, nowMs - startedAtMs, phaseMs) : 0;
    lastSliceMs = nowMs;
    for (let packet = 0; packet < packetCount; packet += 1) {
      age += ticksPerPacket;
      dayTime += ticksPerPacket;
      for (const listener of [...timeListeners]) listener();
    }
    if (running) pending = runDueAnswers(pending, nowMs);
  });

  return {
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
    packets,
    stop: () => void (running = false),
    resume: () => void (running = true),
    answer: (run) => void pending.push({ dueMs: clock.now() + lagMs, run }),
    onTimePacket(listener) {
      timeListeners.add(listener);
      return () => void timeListeners.delete(listener);
    },
    riderOf: (vehicleId) => riders.get(vehicleId) ?? null,
    seatRider: (vehicleId, riderId) => void riders.set(vehicleId, riderId),
    freeRider: (vehicleId) => void riders.delete(vehicleId),
    receive(name, data) {
      packets.push({ name, data, atMs: clock.now() });
      for (const handler of [...(packetHandlers.get(name) ?? [])]) handler(data);
    },
    onPacket(name, handler) {
      const handlers = packetHandlers.get(name) ?? new Set();
      packetHandlers.set(name, handlers.add(handler));
      return () => void handlers.delete(handler);
    },
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
