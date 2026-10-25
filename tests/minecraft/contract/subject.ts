/**
 * What a contract check acts on: the bot, time, and the two server-side means a check needs (a block edit, the
 * server's record of a rider), on the shared fake (`createFakeBot`) or on a real server through Mine Labs.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { FakeCell, FakeHarness, ShotProjectile, Weather } from "../../../src/test-support/fake-bot/index.ts";
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
  /** Another actor hurts the bot (`/damage`: a mob's attack by `sourceId`, or no source); resolves once the client heard the hurt. */
  hurtBot(amount: number, sourceId: number | null): Promise<void>;
  /** The server kills a mob (`/kill`); resolves once the client heard it die. */
  kill(entityId: number): Promise<void>;
  /** A creeper ignited with no fuse explodes at `position`, breaking no block; resolves once the client heard the explosion. */
  explode(position: Vec3): Promise<void>;
  /** The server summons the mob `name` at `position` (a world position) with the raw SNBT `nbt` (the fake reads none: its mobs have no AI); resolves with it once the client has it. */
  summonMob(name: string, position: Vec3, nbt?: string): Promise<Entity>;
  /** The server removes a mob it summoned (`/kill`); resolves once the client no longer has it. */
  removeMob(mob: Entity): Promise<void>;
  /** A fireball (a ghast's) is summoned at `position` flying with `motion` (blocks a tick) and a small acceleration, with no block broken by its blast (the `mobGriefing` game rule is off until `clearFireballs`: a server-wide rule); resolves with it once the client has it. */
  launchFireball(position: Vec3, motion: Vec3): Promise<Entity>;
  /** The server removes every fireball and gives `mobGriefing` back; resolves once the client has no fireball left (the rule goes back with the next command: a server answers in order). */
  clearFireballs(): Promise<void>;
  /** The shooter `shooterId` (a mob on the client) hits the bot with a `projectile` ("arrow" or "small_fireball") that flew in from its side; resolves once the client heard the hurt. */
  shootBot(projectile: ProjectileName, shooterId: number): Promise<void>;
  /**
   * Resolves true once the world age the client holds moved by `ticks` or more since this call, false at `wallMs` (the
   * wall bound; a server behind by seconds ends here, never on ticks alone). The age comes one packet per 20 ticks
   * (`mineflayer/lib/plugins/time.js`), so the age at the call may be up to 19 ticks stale: `ticks` observed prove at
   * least `ticks - 19` server ticks after the call, and 40 prove at least 21 (the runtime's accepted rule, facts
   * `runtime-pitfalls.md` "The server's answer"). That holds for a client that reads its packets as they come: on a
   * lane client whose event loop is late, time packets the server sent before the call may be read after it and
   * count (open question for the master: an exact start from a `time query gametime` round trip, with T7d1b's method).
   * Before the first packet the first age heard is the start. Use it for an
   * absence ("no arrow", "no packet") and for a gap that stands for server ticks; a value the server will send is read
   * with `holdsWithin`.
   */
  serverTicks(ticks: number, wallMs: number): Promise<boolean>;
  /**
   * The ticks the server has run (`time query gametime`, stored and told back by `tellraw`: Mine Labs mutes command feedback): exact, where `bot.time.age` is up to 19 ticks
   * stale. The command is sent before the call returns, so a call made just before `bot.attack` has the server run both in
   * one tick or in neighbouring ones (it reads its packets in order): the readings of two such calls bound the server ticks
   * between the two acts, which a wall gap cannot (a stalled server catches up in a burst). The promise settles with the
   * answer, in the order asked; it does not move the clock, so on the fake the caller's own waits, or `settleWithin`, run
   * the answer. A real server that does not answer rejects at the wall bound (the command did nothing: is the bot op? or the server stalled).
   */
  serverGameTime(): Promise<number>;
  /** The server sends a time packet now, as it does at each `/time set`: the command with the day time the client holds, harmless server-wide (the same value). Resolves once the command is sent; the packet comes with the next ticks. */
  resendTime(): Promise<void>;
}

/** The projectiles a mob shoots at the bot that the checks name. */
export type ProjectileName = ShotProjectile;
/** What each costs the bot once it lands on easy, as `projectile-hit-bot` measured it on the server (the fake's scene control takes the final amount). */
const SHOT_COST: Readonly<Record<ProjectileName, number>> = { arrow: 3, small_fireball: 3.5 };

/** The line a `tellraw` of the stored game time prints: this text, then the count. */
const GAME_TIME_LINE = "contract-gametime ";
/** The `storage` namespace that holds each bot's last `time query gametime` (one key per bot, so lanes never read each other's). */
const GAME_TIME_STORAGE = "mine_ai:contract";
/** Longest a server-side edit may take to reach the client (one round trip, a server behind by a second). */
const SERVER_EDIT_WALL_MS = 3_000;
/** An item entity spawned this close to where `/summon` put it is the summoned one (the server may nudge it a tick later). */
const SUMMON_MATCH_DISTANCE = 0.5;
/** The server's selector for the one entity the client sees at `entity`'s place (a mob that does not move). */
function selectorOf(entity: Entity): string {
  const { x, y, z } = entity.position;
  return `@e[type=${entity.name},x=${x},y=${y},z=${z},distance=..0.5,limit=1]`;
}

/** Resolve with the first `event` for which `wanted` holds, or throw after the wall bound (the command did nothing: is the bot op?). */
function heardWithin<Args extends unknown[]>(bot: Bot, event: string, wanted: (...args: Args) => boolean, what: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const listener = (...args: unknown[]) => {
      if (!wanted(...(args as Args))) return;
      clearTimeout(timer);
      bot.off(event as never, listener as never);
      resolve();
    };
    const timer = setTimeout(() => {
      bot.off(event as never, listener as never);
      reject(new Error(`${what}: not heard after ${SERVER_EDIT_WALL_MS} ms (is the bot op?)`));
    }, SERVER_EDIT_WALL_MS);
    bot.on(event as never, listener as never);
  });
}

/** Resolve with the entity `name` the client first hears spawn near `position`, or throw after the wall bound (the command did nothing: is the bot op?). */
function spawnedNear(bot: Bot, name: string, position: Vec3, what: string): Promise<Entity> {
  return new Promise<Entity>((resolve, reject) => {
    const onSpawn = (entity: Entity) => {
      if (entity.name !== name || entity.position.distanceTo(position) > SUMMON_MATCH_DISTANCE) return;
      clearTimeout(timer);
      bot.off("entitySpawn", onSpawn);
      resolve(entity);
    };
    const timer = setTimeout(() => {
      bot.off("entitySpawn", onSpawn);
      reject(new Error(`${what}: no ${name} entity near ${position} after ${SERVER_EDIT_WALL_MS} ms (is the bot op?)`));
    }, SERVER_EDIT_WALL_MS);
    bot.on("entitySpawn", onSpawn);
  });
}

/**
 * The `/time query gametime` questions one bot asked and the server has not answered, oldest first. Mine Labs sets `sendCommandFeedback
 * false`, so the query's own reply is never sent (measured 2026-10-24, attack-cooldown-damage: 10 of 10 questions unanswered): the count
 * is stored under the bot's key (`execute store`) and printed by `tellraw`, which is not command feedback. The server runs commands in
 * the order sent, so each printed line belongs to the oldest question. A question nothing
 * answers rejects at the wall bound; a late answer after that goes to the next question, but the check that got the rejection has failed.
 */
function createGameTimeQueries(bot: Bot) {
  const waiting: { resolve(ticks: number): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];
  const key = `gametime_${bot.username}`;
  const onMessage = (text: string) => {
    const ticks = text.startsWith(GAME_TIME_LINE) ? Number(text.slice(GAME_TIME_LINE.length)) : NaN;
    const oldest = Number.isNaN(ticks) ? undefined : waiting.shift();
    if (oldest === undefined) return;
    clearTimeout(oldest.timer);
    oldest.resolve(ticks);
    if (waiting.length === 0) bot.off("messagestr", onMessage as never);
  };
  return {
    ask: () =>
      new Promise<number>((resolve, reject) => {
        const query = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiting.splice(waiting.indexOf(query), 1);
            if (waiting.length === 0) bot.off("messagestr", onMessage as never);
            reject(new Error(`/time query gametime: no answer after ${SERVER_EDIT_WALL_MS} ms (is the bot op? or the server stalled)`));
          }, SERVER_EDIT_WALL_MS),
        };
        if (waiting.length === 0) bot.on("messagestr", onMessage as never);
        waiting.push(query);
        bot.chat(`/execute store result storage ${GAME_TIME_STORAGE} ${key} int 1 run time query gametime`);
        bot.chat(`/tellraw @s {"text":"${GAME_TIME_LINE}","extra":[{"nbt":"${key}","storage":"${GAME_TIME_STORAGE}"}]}`);
      }),
  };
}

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
export function holdsWithin(subject: ContractSubject, condition: () => boolean, maxMs: number): Promise<boolean> {
  return holdsOnClock(subject, condition, maxMs);
}

/** `holdsWithin` on any clock: a subject under construction has the two clock members before it has the rest. */
async function holdsOnClock(clock: Pick<ContractSubject, "now" | "wait">, condition: () => boolean, maxMs: number): Promise<boolean> {
  const startedAt = clock.now();
  while (!condition()) {
    if (clock.now() - startedAt >= maxMs) return false;
    await clock.wait(SETTLE_STEP_MS);
  }
  return true;
}

/** `ContractSubject.serverTicks` for a subject made of `bot`, `now` and `wait`: both kinds of subject share it. */
function serverTicksPassed(subject: Pick<ContractSubject, "bot" | "now" | "wait">, ticks: number, wallMs: number): Promise<boolean> {
  // `bot.time.age` is null until the first time packet; the first age heard is then the start.
  let startAge: number | null = subject.bot.time.age;
  const moved = () => {
    const age: number | null = subject.bot.time.age;
    if (age === null) return 0;
    startAge ??= age;
    return age - startAge;
  };
  return holdsOnClock(subject, () => moved() >= ticks, wallMs);
}

/** The fake's subject: time is the harness clock (mocked, so code reading the globals sees it too). */
export function fakeContractSubject(harness: FakeHarness, arena: ArenaFrame): ContractSubject {
  const { bot, clock, combat, entities, server, world } = harness;
  const wait = (ms: number) => clock.advance(ms);
  const now = () => clock.now();
  return {
    bot,
    world: (local) => new Vec3(...arena.world(local)),
    wait,
    now,
    serverTicks: (ticks, wallMs) => serverTicksPassed({ bot, now, wait }, ticks, wallMs),
    // Sent now and not awaited here: the check goes on, and its own waits move the clock that runs the answer.
    serverGameTime: () => new Promise<number>((resolve) => server.answer(() => resolve(server.gameTime))),
    async resendTime() {
      server.answer(() => server.resendTime());
      await clock.advance(50);
    },
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
    async hurtBot(amount, sourceId) {
      server.answer(() => combat.hurtBot(amount, sourceId));
      await clock.advance(50);
    },
    async kill(entityId) {
      server.answer(() => combat.kill(entityId));
      await clock.advance(50);
    },
    async explode(position) {
      server.answer(() => combat.explode(position));
      await clock.advance(50);
    },
    async summonMob(name, position) {
      let summoned: Entity | undefined;
      server.answer(() => void (summoned = entities.spawn({ name, position })));
      await clock.advance(50);
      return summoned!;
    },
    async removeMob(mob) {
      server.answer(() => entities.remove(mob.id));
      await clock.advance(50);
    },
    async shootBot(projectile, shooterId) {
      server.answer(() => combat.shootBot(projectile, shooterId, SHOT_COST[projectile]));
      await clock.advance(50);
    },
    async launchFireball(position, motion) {
      let launched: Entity | undefined;
      server.answer(() => void (launched = combat.launchFireball(position, motion)));
      await clock.advance(50);
      return launched!;
    },
    async clearFireballs() {
      server.answer(() => Object.values(bot.entities).filter(({ name }) => name === "fireball").forEach(({ id }) => entities.remove(id)));
      await clock.advance(50);
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
  const gameTimeQueries = createGameTimeQueries(bot);
  const wait = (ms: number) => delay(ms);
  const now = () => performance.now();
  return {
    bot,
    world,
    wait,
    now,
    serverTicks: (ticks, wallMs) => serverTicksPassed({ bot, now, wait }, ticks, wallMs),
    serverGameTime: gameTimeQueries.ask,
    // Sent and not awaited, like `setWeather`: the packet is what the check listens for.
    async resendTime() {
      // `time` keeps the day count (`/time set` is absolute); the value is up to 19 ticks stale, so the clock goes back that far for one tick.
      bot.chat(`/time set ${bot.time.time}`);
    },
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
      const spawned = spawnedNear(bot, "item", position, "/summon item");
      bot.chat(`/summon item ${at(position)} {Item:{id:"minecraft:${stack.name}",count:${stack.count}},PickupDelay:${pickupDelayTicks}s}`);
      return spawned;
    },
    async hurtBot(amount, sourceId) {
      const heard = heardWithin(bot, "entityHurt", (entity: Entity) => entity === bot.entity, "/damage");
      const source = sourceId === null ? "minecraft:generic" : `minecraft:mob_attack by ${selectorOf(bot.entities[sourceId]!)}`;
      bot.chat(`/damage ${bot.username} ${amount} ${source}`);
      await heard;
    },
    async kill(entityId) {
      const mob = bot.entities[entityId]!;
      const heard = heardWithin(bot, "entityDead", (entity: Entity) => entity === mob, "/kill");
      bot.chat(`/kill ${selectorOf(mob)}`);
      await heard;
    },
    async explode(position) {
      const heard = new Promise<void>((resolve, reject) => {
        const onExplosion = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          bot._client.off("explosion", onExplosion);
          reject(new Error(`/summon creeper: no explosion after ${SERVER_EDIT_WALL_MS} ms (is the bot op?)`));
        }, SERVER_EDIT_WALL_MS);
        bot._client.once("explosion", onExplosion);
      });
      bot.chat("/gamerule mobGriefing false");
      bot.chat(`/summon creeper ${at(position)} {Fuse:0,ignited:1b}`);
      await heard;
      bot.chat("/gamerule mobGriefing true");
    },
    ...serverMobActions(bot, at),
  };
}

/** The subject's means on mobs, projectiles and fireballs on a real server (op commands), `at` writing a position for a command. */
function serverMobActions(bot: Bot, at: (cell: Vec3) => string): Pick<ContractSubject, "summonMob" | "removeMob" | "launchFireball" | "clearFireballs" | "shootBot"> {
  return {
    async summonMob(name, position, nbt) {
      const spawned = spawnedNear(bot, name, position, `/summon ${name}`);
      bot.chat(`/summon ${name} ${at(position)}${nbt === undefined ? "" : ` ${nbt}`}`);
      return spawned;
    },
    async removeMob(mob) {
      const gone = heardWithin(bot, "entityGone", (entity: Entity) => entity === mob, "/kill");
      bot.chat(`/kill ${selectorOf(mob)}`);
      await gone;
    },
    async launchFireball(position, motion) {
      const spawned = spawnedNear(bot, "fireball", position, "/summon fireball");
      bot.chat("/gamerule mobGriefing false");
      bot.chat(`/summon fireball ${at(position)} {Motion:[${motion.x}d,${motion.y}d,${motion.z}d],acceleration_power:${FIREBALL_LAUNCH_ACCELERATION}d}`);
      return spawned;
    },
    async clearFireballs() {
      bot.chat("/kill @e[type=fireball]");
      const startedAt = performance.now();
      while (Object.values(bot.entities).some(({ name }) => name === "fireball")) {
        if (performance.now() - startedAt > SERVER_EDIT_WALL_MS) throw new Error(`/kill @e[type=fireball]: a fireball is still on the client after ${SERVER_EDIT_WALL_MS} ms (is the bot op?)`);
        await delay(SETTLE_STEP_MS);
      }
      bot.chat("/gamerule mobGriefing true");
    },
    async shootBot(projectile, shooterId) {
      const shooter = bot.entities[shooterId]!;
      const heard = heardWithin(bot, "entityHurt", (entity: Entity) => entity === bot.entity, `/summon ${projectile}`);
      bot.chat(`/summon ${projectile} ${at(projectileStart(bot, shooter))} ${projectileNbt(projectile, bot, shooter)}`);
      await heard;
    },
  };
}

/** How far from the bot the server drops a projectile on the line to its shooter: it hits a tick or two later, after the client has heard it spawn. */
const PROJECTILE_START_DISTANCE = 3;
/** The speed a skeleton's arrow leaves the bow with (power 1.6 for a full draw), in blocks a tick. */
const ARROW_SPEED = 1.6;
const FIREBALL_SPEED = 1;
const FIREBALL_ACCELERATION = 0.1;
/** A launched fireball picks up speed slowly, so a check has several ticks to hit it (the 0.1 of a blaze's shot reaches 0.65 blocks a tick within 8). */
const FIREBALL_LAUNCH_ACCELERATION = 0.02;

/** The point at the bot's chest height on the line from her to `shooter`, `PROJECTILE_START_DISTANCE` out. */
function projectileStart(bot: Bot, shooter: Entity): Vec3 {
  const toShooter = shooter.position.minus(bot.entity.position).plus(new Vec3(0, -shooter.position.y + bot.entity.position.y, 0)).normalize();
  return bot.entity.position.plus(toShooter.scaled(PROJECTILE_START_DISTANCE)).offset(0, bot.entity.height * 0.7, 0);
}

/** The `/summon` data of a projectile owned by `shooter`, flying at the bot's chest. */
function projectileNbt(projectile: ProjectileName, bot: Bot, shooter: Entity): string {
  const start = projectileStart(bot, shooter);
  const toBot = bot.entity.position.offset(0, bot.entity.height * 0.7, 0).minus(start).normalize();
  const speed = projectile === "arrow" ? ARROW_SPEED : FIREBALL_SPEED;
  const motion = toBot.scaled(speed);
  const uuid = (shooter.uuid ?? "").replaceAll("-", "");
  const owner = [0, 8, 16, 24].map((from) => Number(BigInt.asIntN(32, BigInt(`0x${uuid.slice(from, from + 8)}`)))).join(",");
  const acceleration = projectile === "small_fireball" ? `,acceleration_power:${FIREBALL_ACCELERATION}d` : "";
  return `{Owner:[I;${owner}],Motion:[${motion.x}d,${motion.y}d,${motion.z}d]${acceleration}}`;
}
