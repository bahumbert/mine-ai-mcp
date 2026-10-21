/**
 * What a contract check acts on: the bot, time, and the two server-side means a check needs (a block edit, the
 * server's record of a rider), on the shared fake (`createFakeBot`) or on a real server through Mine Labs.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { FakeCell, FakeHarness } from "../../../src/test-support/fake-bot/index.ts";

/** Mineflayer keeps the ridden entity on the bot too; its typings leave it out. */
export type ContractBot = Bot & { vehicle?: Entity | null };

export interface ContractSubject {
  readonly bot: ContractBot;
  /** Let `ms` pass: real time on a server, `clock.advance` on the fake. */
  wait(ms: number): Promise<void>;
  /** Milliseconds on the monotonic clock the bot's own timers run on. */
  now(): number;
  /** Change a cell on the server's side (an op command on a real server); resolves once the client has the update. */
  setBlock(cell: Vec3, block: FakeCell): Promise<void>;
  /** Whether the server still has the bot riding `vehicle`, whatever the client believes. */
  seatedOnServer(vehicle: Entity): Promise<boolean>;
}

/** Longest a server-side edit may take to reach the client (one round trip, a server behind by a second). */
const SERVER_EDIT_WALL_MS = 3_000;
/** Steps of `settleWithin`: fine enough for a 2-tick bound, coarse enough for the real event loop. */
const SETTLE_STEP_MS = 25;

/** How a promise ended, with the subject's clock reading when it did. */
export interface Settled<T> {
  readonly value?: T;
  readonly error?: Error;
  readonly atMs: number;
}

/** Let time pass until `promise` settles or `maxMs` is over; the reading is taken when it settled, not when seen. */
export async function settleWithin<T>(subject: ContractSubject, promise: Promise<T>, maxMs: number): Promise<Settled<T> | null> {
  let settled: Settled<T> | null = null;
  promise.then(
    (value) => void (settled = { value, atMs: subject.now() }),
    (error: Error) => void (settled = { error, atMs: subject.now() }),
  );
  const startedAt = subject.now();
  while (settled === null && subject.now() - startedAt < maxMs) await subject.wait(SETTLE_STEP_MS);
  return settled;
}

/** Let time pass until `condition` holds or `maxMs` is over; whether it held. */
export async function holdsWithin(subject: ContractSubject, condition: () => boolean, maxMs: number): Promise<boolean> {
  const startedAt = subject.now();
  while (!condition()) {
    if (subject.now() - startedAt >= maxMs) return false;
    await subject.wait(SETTLE_STEP_MS);
  }
  return true;
}

/** The fake's subject: time is the harness clock (mocked, so code reading the globals sees it too). */
export function fakeContractSubject(harness: FakeHarness): ContractSubject {
  const { bot, clock, server, world } = harness;
  return {
    bot,
    wait: (ms) => clock.advance(ms),
    now: () => clock.now(),
    async setBlock(cell, block) {
      server.answer(() => world.setCell(cell, block));
      await clock.advance(50);
    },
    seatedOnServer: async (vehicle) => server.riderOf(vehicle.id) === bot.entity.id,
  };
}

/** A block as the `setblock` command writes it: `name[key=value,...]`. */
export function blockArgument(block: FakeCell): string {
  if (typeof block === "number") throw new Error(`a state id (${block}) has no command form: name the block`);
  if (typeof block === "string") return block;
  const properties = Object.entries(block.properties).map(([key, value]) => `${key}=${value}`);
  return `${block.name}[${properties.join(",")}]`;
}

/** Cells a real-server subject writes to answer `seatedOnServer`: a probe the server sets only for a seated rider, then a sentinel. */
export const SEAT_PROBE_CELL = new Vec3(5, -60, 5);
export const SEAT_SENTINEL_CELL = new Vec3(5, -60, 4);
const MARKER_BLOCK = "gold_block";

/** Send a command and wait until `cell` reads `name` on the client; throws past the bound. */
async function commandUntil(bot: Bot, command: string, cell: Vec3, name: string): Promise<void> {
  bot.chat(`/${command}`);
  const startedAt = performance.now();
  while (bot.blockAt(cell)?.name !== name) {
    if (performance.now() - startedAt > SERVER_EDIT_WALL_MS) {
      throw new Error(`/${command}: ${cell} still ${bot.blockAt(cell)?.name ?? "unloaded"} after ${SERVER_EDIT_WALL_MS} ms (is the bot op?)`);
    }
    await delay(SETTLE_STEP_MS);
  }
}

/** A real server's subject: wall time, and op commands sent as chat (the fixture's player is op). */
export function serverContractSubject(bot: Bot): ContractSubject {
  const at = (cell: Vec3) => `${cell.x} ${cell.y} ${cell.z}`;
  return {
    bot,
    wait: (ms) => delay(ms),
    now: () => performance.now(),
    async setBlock(cell, block) {
      const name = typeof block === "string" ? block : typeof block === "number" ? "" : block.name;
      await commandUntil(bot, `setblock ${at(cell)} ${blockArgument(block)}`, cell, name);
    },
    async seatedOnServer() {
      // Commands run in order: once the sentinel is set, the probe holds what the `on vehicle` branch did.
      bot.chat(`/execute as ${bot.username} on vehicle run setblock ${at(SEAT_PROBE_CELL)} ${MARKER_BLOCK}`);
      await commandUntil(bot, `setblock ${at(SEAT_SENTINEL_CELL)} ${MARKER_BLOCK}`, SEAT_SENTINEL_CELL, MARKER_BLOCK);
      const seated = bot.blockAt(SEAT_PROBE_CELL)?.name === MARKER_BLOCK;
      bot.chat(`/setblock ${at(SEAT_PROBE_CELL)} air`);
      await commandUntil(bot, `setblock ${at(SEAT_SENTINEL_CELL)} air`, SEAT_SENTINEL_CELL, "air");
      return seated;
    },
  };
}
