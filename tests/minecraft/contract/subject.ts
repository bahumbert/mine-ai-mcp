/**
 * What a contract check acts on: the bot, time, and the two server-side means a check needs (a block edit, the
 * server's record of a rider), on the shared fake (`createFakeBot`) or on a real server through Mine Labs.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { FakeCell, FakeHarness, Weather } from "../../../src/test-support/fake-bot/index.ts";
import type { ArenaFrame } from "../arena/frame.ts";

/** A cell or a point written in arena-local coordinates, as the fixtures and the checks write them. */
export type LocalPoint = readonly [number, number, number];

/** Mineflayer keeps the ridden entity on the bot too; its typings leave it out. */
export type ContractBot = Bot & { vehicle?: Entity | null };

export interface ContractSubject {
  readonly bot: ContractBot;
  /** Where an arena-local point is in the world this subject runs in: a check names every cell and position through it, so one check runs in any lane. */
  world(local: LocalPoint): Vec3;
  /** Let `ms` pass: real time on a server, `clock.advance` on the fake. */
  wait(ms: number): Promise<void>;
  /** Milliseconds on the monotonic clock the bot's own timers run on. */
  now(): number;
  /** Change a cell on the server's side (an op command on a real server); resolves once the client has the update. */
  setBlock(cell: Vec3, block: FakeCell): Promise<void>;
  /** Whether the server still has the bot riding `vehicle`, whatever the client believes. */
  seatedOnServer(vehicle: Entity): Promise<boolean>;
  /** Set the weather on the server (`/weather`); the levels then ramp, and the client hears each step. */
  setWeather(weather: Weather): Promise<void>;
  /** The server spawns `stack` as an item entity at `position` (a world position: `world` of a local one), pickable after `pickupDelayTicks`; resolves with it once the client has it. */
  summonItem(stack: { readonly name: string; readonly count: number }, position: Vec3, pickupDelayTicks: number): Promise<Entity>;
}

/** Longest a server-side edit may take to reach the client (one round trip, a server behind by a second). */
const SERVER_EDIT_WALL_MS = 3_000;
/** An item entity spawned this close to where `/summon` put it is the summoned one (the server may nudge it a tick later). */
const SUMMON_MATCH_DISTANCE = 0.5;
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
export function fakeContractSubject(harness: FakeHarness, arena: ArenaFrame): ContractSubject {
  const { bot, clock, entities, server, world } = harness;
  return {
    bot,
    world: (local) => new Vec3(...arena.world(local)),
    wait: (ms) => clock.advance(ms),
    now: () => clock.now(),
    async setBlock(cell, block) {
      server.answer(() => world.setCell(cell, block));
      await clock.advance(50);
    },
    seatedOnServer: async (vehicle) => server.ridersOf(vehicle.id).includes(bot.entity.id),
    async setWeather(weather) {
      server.answer(() => server.setWeather(weather));
      await clock.advance(50);
    },
    async summonItem(stack, position, pickupDelayTicks) {
      let summoned: Entity | undefined;
      server.answer(() => void (summoned = entities.spawn({ name: "item", position, item: stack, pickupDelayTicks })));
      await clock.advance(50);
      return summoned!;
    },
  };
}

/** A block as the `setblock` command writes it: `name[key=value,...]`. */
export function blockArgument(block: FakeCell): string {
  if (typeof block === "number") throw new Error(`a state id (${block}) has no command form: name the block`);
  if (typeof block === "string") return block;
  const properties = Object.entries(block.properties).map(([key, value]) => `${key}=${value}`);
  return `${block.name}[${properties.join(",")}]`;
}

/** Arena-local cells a real-server subject writes (in its lane) to answer `seatedOnServer`: a probe the server sets only for a seated rider, then a sentinel. */
const SEAT_PROBE_LOCAL: LocalPoint = [5, -60, 5];
const SEAT_SENTINEL_LOCAL: LocalPoint = [5, -60, 4];
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
export function serverContractSubject(bot: Bot, arena: ArenaFrame): ContractSubject {
  const at = (cell: Vec3) => `${cell.x} ${cell.y} ${cell.z}`;
  const world = (local: LocalPoint) => new Vec3(...arena.world(local));
  const probe = world(SEAT_PROBE_LOCAL);
  const sentinel = world(SEAT_SENTINEL_LOCAL);
  return {
    bot,
    world,
    wait: (ms) => delay(ms),
    now: () => performance.now(),
    async setBlock(cell, block) {
      const name = typeof block === "string" ? block : typeof block === "number" ? "" : block.name;
      await commandUntil(bot, `setblock ${at(cell)} ${blockArgument(block)}`, cell, name);
    },
    async seatedOnServer() {
      // Commands run in order: once the sentinel is set, the probe holds what the `on vehicle` branch did.
      bot.chat(`/execute as ${bot.username} on vehicle run setblock ${at(probe)} ${MARKER_BLOCK}`);
      await commandUntil(bot, `setblock ${at(sentinel)} ${MARKER_BLOCK}`, sentinel, MARKER_BLOCK);
      const seated = bot.blockAt(probe)?.name === MARKER_BLOCK;
      bot.chat(`/setblock ${at(probe)} air`);
      await commandUntil(bot, `setblock ${at(sentinel)} air`, sentinel, "air");
      return seated;
    },
    // The command is sent and not awaited: the weather reaches the client as levels over the next ticks, which the check waits for.
    async setWeather(weather) {
      bot.chat(`/weather ${weather}`);
    },
    async summonItem(stack, position, pickupDelayTicks) {
      const spawned = new Promise<Entity>((resolve, reject) => {
        const onSpawn = (entity: Entity) => {
          if (entity.name !== "item" || entity.position.distanceTo(position) > SUMMON_MATCH_DISTANCE) return;
          clearTimeout(timer);
          bot.off("entitySpawn", onSpawn);
          resolve(entity);
        };
        const timer = setTimeout(() => {
          bot.off("entitySpawn", onSpawn);
          reject(new Error(`/summon item: no item entity near ${position} after ${SERVER_EDIT_WALL_MS} ms`));
        }, SERVER_EDIT_WALL_MS);
        bot.on("entitySpawn", onSpawn);
      });
      bot.chat(`/summon item ${at(position)} {Item:{id:"minecraft:${stack.name}",count:${stack.count}},PickupDelay:${pickupDelayTicks}s}`);
      return spawned;
    },
  };
}
