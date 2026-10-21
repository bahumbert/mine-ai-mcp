/**
 * The one fake Mineflayer bot: a typed `Bot` on the game's data, with its clock, server, world and inventory in the
 * harness so a test reaches the server side there and never casts the bot (spec `2026-10-21-shared-fake-bot`).
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot, Player } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { DEFAULT_MINECRAFT_VERSION } from "../../server/config.js";
import { attachFakeDigging } from "./fake-bot-digging.js";
import { attachFakeItems, createFakeEntities } from "./fake-bot-items.js";
import { attachFakePhysics } from "./fake-bot-physics.js";
import { attachFakeVehicle } from "./fake-bot-vehicle.js";
import { type FakeClock, createFakeClock } from "./fake-clock.js";
import { type FakeInventory, type FakeInventoryOptions, createFakeInventory } from "./fake-inventory.js";
import { type FakeServer, type FakeServerOptions, createFakeServer } from "./fake-server.js";
import { type FakeWorld, type FakeWorldOptions, createFakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);

/** Mineflayer keeps the ridden entity on the bot as well as on its entity; its typings leave it out. */
export type FakeBot = Bot & { vehicle: Entity | null };

type Point = Vec3 | { readonly x: number; readonly y: number; readonly z: number };

/** An entity the bot sees at the start: its kind by the version's entity name, where it is, and any extra fields. */
export interface FakeEntitySpec {
  readonly name: string;
  readonly position: Point;
  readonly [extra: string]: unknown;
}

export interface FakeBotOptions {
  /** Defaults to the runtime's (`DEFAULT_MINECRAFT_VERSION`); the registry, blocks and items follow it. */
  readonly version?: string;
  readonly username?: string;
  /** The feet; defaults to (0.5, 64, 0.5). */
  readonly position?: Point;
  readonly dimension?: string;
  readonly gameMode?: string;
  readonly health?: number;
  readonly food?: number;
  readonly cells?: FakeWorldOptions["cells"];
  /** Stone at and below this level; defaults to the level under the feet, null for open air. */
  readonly groundY?: number | null;
  readonly slots?: FakeInventoryOptions["slots"];
  readonly carried?: FakeInventoryOptions["carried"];
  /** Entities by id (not the bot's own, which is id 1). */
  readonly entities?: Readonly<Record<number, FakeEntitySpec>>;
  /** Other players by username; the bot's own entry is added. */
  readonly players?: Readonly<Record<string, Partial<Player>>>;
  /** A clock to share with other harnesses; a new manual one otherwise. */
  readonly clock?: FakeClock;
  /** How long every server answer takes, in ms of clock. */
  readonly lagMs?: number;
  /** The server's age, time of day, packet phase and tick rate. */
  readonly server?: Omit<FakeServerOptions, "lagMs">;
  /** Move the body by Mineflayer's own physics engine each tick (gravity, water, jumping); off by default. */
  readonly simulatePhysics?: boolean;
  /** Methods a test replaces (a scripted `tossStack` failure). */
  readonly overrides?: Partial<Bot>;
}

export interface FakeHarness {
  readonly bot: FakeBot;
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly world: FakeWorld;
  readonly inventory: FakeInventory;
}

const BOT_ENTITY_ID = 1;
/** Ids handed to entities the bot meets later (drops): above any a test names. */
const FIRST_SPAWNED_ENTITY_ID = 1_000;
const DEFAULT_FEET = { x: 0.5, y: 64, z: 0.5 };

/** The bot's own entity, as Mineflayer fills it at login (`entities.js:105-112`). */
function botEntity(make: (name: string, position: Vec3, id: number) => Entity, username: string, feet: Vec3): Entity {
  return Object.assign(make("player", feet, BOT_ENTITY_ID), {
    username,
    eyeHeight: 1.62,
    onGround: true,
    isInWater: false,
    isInLava: false,
    isInWeb: false,
    isCollidedHorizontally: false,
    isCollidedVertically: true,
    elytraFlying: false,
  });
}

/** The parts of a bot that are plain state: names, health, game, time, controls. */
function stateOf(options: FakeBotOptions, username: string, server: FakeServer) {
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  return {
    username,
    health: options.health ?? 20,
    food: options.food ?? 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    usingHeldItem: false,
    currentWindow: null,
    game: { dimension: options.dimension ?? "overworld", gameMode: options.gameMode ?? "survival", difficulty: "normal" },
    controlState: controls,
    swingArm: () => undefined,
    get time() {
      // `time.js`: `time` is the day time unwrapped, `timeOfDay` and `day` are read from it.
      const day = Math.floor(server.dayTime / 24_000);
      return { age: server.age, time: server.dayTime, timeOfDay: server.timeOfDay, day, isDay: server.timeOfDay < 13_000, moonPhase: day % 8 };
    },
  };
}

/** A bot, its clock, server, world and inventory, all on one version's data and one clock. */
export function createFakeBot(options: FakeBotOptions = {}): FakeHarness {
  const version = options.version ?? DEFAULT_MINECRAFT_VERSION;
  const username = options.username ?? "TestBot";
  const point = options.position ?? DEFAULT_FEET;
  const feet = new Vec3(point.x, point.y, point.z);
  const clock = options.clock ?? createFakeClock({ mode: "manual" });
  const groundY = options.groundY === undefined ? Math.floor(feet.y) - 1 : options.groundY;
  const world = createFakeWorld(version, { cells: options.cells, groundY });
  const registry = world.registry;
  const server = createFakeServer(clock, { ...options.server, lagMs: options.lagMs });
  const inventory = createFakeInventory(registry, { slots: options.slots, carried: options.carried });
  const EntityClass = (require("prismarine-entity") as (registry: Bot["registry"]) => new (id: number) => Entity)(registry);
  const entities = createFakeEntities(registry, EntityClass, FIRST_SPAWNED_ENTITY_ID);
  const self = botEntity(entities.make, username, feet);

  // The one cast of the shared fake: everything Mineflayer's plugins put on the bot is assigned below.
  const bot = new EventEmitter() as unknown as FakeBot;
  Object.defineProperties(bot, Object.getOwnPropertyDescriptors(stateOf(options, username, server)));
  const client = Object.assign(new EventEmitter(), { state: "play", write: (name: string, data: unknown) => server.receive(name, data) });
  Object.assign(bot, {
    version,
    registry,
    _client: client,
    entity: self,
    entities: { [BOT_ENTITY_ID]: self, ...spawnedEntities(entities.make, options.entities ?? {}) },
    players: { ...options.players, [username]: { username, uuid: "", ping: 0, gamemode: 0, displayName: undefined, entity: self } },
    inventory,
    blockAt: (point: Vec3) => world.blockAt(point),
    world: { getBlockStateId: world.getBlockStateId, getBlock: world.blockAt, raycast: world.raycast },
    supportFeature: registry.supportFeature,
  });
  world.forwardTo(bot);
  server.onTimePacket(() => bot.emit("time"));
  // The server's position packet, as the protocol hands it to Mineflayer's handler (`physics.js`).
  server.onPosition(({ x, y, z }) => client.emit("position", { x, y, z, yaw: 0, pitch: 0, flags: {}, teleportId: 0 }));
  attachFakePhysics(bot, clock, options.simulatePhysics);
  attachFakeDigging(bot, clock, world);
  attachFakeVehicle(bot, server);
  attachFakeItems(bot, { clock, server, world, inventory, entities });
  Object.defineProperties(bot, Object.getOwnPropertyDescriptors(options.overrides ?? {}));
  return { bot, clock, server, world, inventory };
}

/** The test's entities as Prismarine entities, sized from the version's data, keyed by id. */
function spawnedEntities(
  make: (name: string, position: Vec3, id: number) => Entity,
  specs: Readonly<Record<number, FakeEntitySpec>>,
): Record<number, Entity> {
  return Object.fromEntries(
    Object.entries(specs).map(([id, { name, position, ...extra }]) => {
      const entity = make(name, new Vec3(position.x, position.y, position.z), Number(id));
      return [id, Object.assign(entity, extra)];
    }),
  );
}
