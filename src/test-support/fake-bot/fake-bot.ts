/**
 * The one fake Mineflayer bot: a typed `Bot` on the game's data, with its clock, server, world and inventory in the
 * harness so a test reaches the server side there and never casts the bot (spec `2026-10-21-shared-fake-bot`).
 */
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { DEFAULT_MINECRAFT_VERSION } from "../../server/config.js";
import { type FakeBreath, attachFakeBreath } from "./fake-bot-breath.js";
import { attachFakeDigging } from "./fake-bot-digging.js";
import { type ServerEntities, attachFakeEntities } from "./fake-bot-entities.js";
import { attachFakeFindBlocks } from "./fake-bot-find-blocks.js";
import { type FakeEntities, attachFakeItems, createFakeEntities } from "./fake-bot-items.js";
import { attachFakeLavaFlow } from "./fake-bot-lava-flow.js";
import { attachFakePhysics } from "./fake-bot-physics.js";
import { type PlaceBlockWithOptions, attachFakePlacement } from "./fake-bot-placement.js";
import { attachFakePlugins, offlineUuidOf } from "./fake-bot-plugins.js";
import { type FakePlayerSpec, attachFakeSleep, playersOf } from "./fake-bot-sleep.js";
import { attachFakeUse } from "./fake-bot-use.js";
import { type FakeCombat, attachFakeCombat } from "./fake-bot-combat.js";
import { attachFakeBoatDamage } from "./fake-bot-boat-damage.js";
import { attachFakeSwing } from "./fake-bot-swing.js";
import { attachFakeVehicle, seatStartingPassengers } from "./fake-bot-vehicle.js";
import { attachFakeWindows } from "./fake-bot-windows.js";
import type { FakeWindows } from "./fake-window-server.js";
import { type FakeClock, createFakeClock } from "./fake-clock.js";
import { type FakeInventory, type FakeInventoryOptions, createFakeInventory } from "./fake-inventory.js";
import { type FakeServer, type FakeServerOptions, createFakeServer } from "./fake-server.js";
import { type FakeWorld, type FakeWorldOptions, createFakeWorld } from "./fake-world.js";

const require = createRequire(import.meta.url);

/** The dimension's floor and height Mineflayer puts on `bot.game` at login (`game.js:70-82`); its typings leave them out. */
export interface DimensionHeights {
  readonly minY: number;
  readonly height: number;
}

/** Mineflayer keeps the ridden entity on the bot as well as on its entity, and the dimension's heights on `game`; its typings leave both out. */
export type FakeBot = Bot & { vehicle: Entity | null; game: Bot["game"] & DimensionHeights; _placeBlockWithOptions: PlaceBlockWithOptions };

type Point = Vec3 | { readonly x: number; readonly y: number; readonly z: number };

/** An entity the bot sees at the start: its kind by the version's entity name, where it is, and any extra fields. */
export interface FakeEntitySpec {
  readonly name: string;
  readonly position: Point;
  /** Entities (by name) riding it from the start, seated on the server and on the client. */
  readonly passengers?: readonly string[];
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
  /** The chunks the server sent, exactly; omitted: the square around the feet and the chunks of named cells (`FakeWorldOptions`). */
  readonly loadedColumns?: FakeWorldOptions["loadedColumns"];
  readonly slots?: FakeInventoryOptions["slots"];
  readonly carried?: FakeInventoryOptions["carried"];
  /** The stacks the server keeps in the container blocks (a chest, a barrel) of `cells`, by `"x,y,z"`: item name to the number held, filling the slots from 0. */
  readonly containers?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Entities by id (not the bot's own, which is id 1). */
  readonly entities?: Readonly<Record<number, FakeEntitySpec>>;
  /** Other players by username; the bot's own entry is added. */
  readonly players?: Readonly<Record<string, FakePlayerSpec>>;
  /** A clock to share with other harnesses; a new manual one otherwise. */
  readonly clock?: FakeClock;
  /** How long every server answer takes, in ms of clock. */
  readonly lagMs?: number;
  /** The server's age, time of day, packet phase and tick rate. */
  readonly server?: Omit<FakeServerOptions, "lagMs">;
  /** Move the body by Mineflayer's own physics engine each tick (gravity, water, jumping); off by default. */
  readonly simulatePhysics?: boolean;
  /** Methods a test replaces (a scripted `tossStack` failure). */
  readonly overrides?: Partial<FakeBot>;
}

export interface FakeHarness {
  readonly bot: FakeBot;
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly world: FakeWorld;
  readonly inventory: FakeInventory;
  /** The server's own entities after the start: spawn, remove, and the pickup of item entities. */
  readonly entities: ServerEntities;
  readonly breath: FakeBreath;
  /** The server's side of the windows: the containers' stacks and the window it has open. */
  readonly windows: FakeWindows;
  /** What other actors do to the bot and the creatures around her: hurt, swing, kill, health, a blast. */
  readonly combat: FakeCombat;
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

/** What `loginPacket` minecraft-data records of a vanilla server's login: its registries, one `registry_data` packet each. */
interface RecordedLogin {
  readonly loginPacket?: { readonly dimensionCodec?: Readonly<Record<string, unknown>> };
}

/** The Java registry's side of the login data (`prismarine-registry` pc): Mineflayer's `Bot["registry"]` type joins it with Bedrock's. */
interface LoginRegistry {
  loadDimensionCodec(codec: unknown): void;
  readonly dimensionsByName?: Readonly<Record<string, Partial<DimensionHeights>>>;
}

/** The registries a vanilla server sends at login, loaded into `registry` as Mineflayer loads each `registry_data` (`game.js:96-98`). */
function loadLoginRegistries(registry: LoginRegistry, version: string): void {
  const recorded = (require("minecraft-data") as (version: string) => RecordedLogin)(version).loginPacket?.dimensionCodec ?? {};
  for (const codec of Object.values(recorded)) registry.loadDimensionCodec(codec);
}

/** `game.js:70-82`: the dimension's floor and height from the login registries, 0 and 256 when they name no such dimension. */
function dimensionHeightsOf(registry: LoginRegistry, dimension: string): DimensionHeights {
  const known = registry.dimensionsByName?.[dimension];
  return { minY: known?.minY ?? 0, height: known?.height ?? 256 };
}

/** The parts of a bot that are plain state: names, health, game, time, controls. */
function stateOf(options: FakeBotOptions, username: string, server: FakeServer, registry: LoginRegistry) {
  const dimension = options.dimension ?? "overworld";
  const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  return {
    username,
    health: options.health ?? 20,
    food: options.food ?? 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    usingHeldItem: false,
    currentWindow: null,
    game: { dimension, gameMode: options.gameMode ?? "survival", difficulty: "normal", ...dimensionHeightsOf(registry, dimension) },
    controlState: controls,
    swingArm: () => undefined,
    get time() {
      // `time.js`: all null until the first `update_time` packet, then `time` is the day time unwrapped, `timeOfDay` and `day` are read from it.
      if (!server.timePacketSent) return { doDaylightCycle: null, bigTime: null, time: null, timeOfDay: null, day: null, isDay: null, moonPhase: null, bigAge: null, age: null, clocks: {} };
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
  const world = createFakeWorld(version, { cells: options.cells, groundY, feet, loadedColumns: options.loadedColumns, heights: () => bot.game });
  const registry = world.registry;
  const loginRegistry = registry as unknown as LoginRegistry;
  loadLoginRegistries(loginRegistry, version);
  const server = createFakeServer(clock, { ...options.server, lagMs: options.lagMs });
  const inventory = createFakeInventory(registry, { slots: options.slots, carried: options.carried });
  const EntityClass = (require("prismarine-entity") as (registry: Bot["registry"]) => new (id: number) => Entity)(registry);
  const entities = createFakeEntities(registry, EntityClass, FIRST_SPAWNED_ENTITY_ID);
  const self = botEntity(entities.make, username, feet);

  // The one cast of the shared fake: everything Mineflayer's plugins put on the bot is assigned below.
  const bot = new EventEmitter() as unknown as FakeBot;
  Object.defineProperties(bot, Object.getOwnPropertyDescriptors(stateOf(options, username, server, loginRegistry)));
  const client = Object.assign(new EventEmitter(), { state: "play", write: (name: string, data: unknown) => server.receive(name, data) });
  Object.assign(bot, {
    version,
    registry,
    _client: client,
    entity: self,
    entities: { [BOT_ENTITY_ID]: self, ...spawnedEntities(entities.make, options.entities ?? {}) },
    players: { ...playersOf(world, entities, feet, options.players), [username]: { username, uuid: offlineUuidOf(username), ping: 0, gamemode: 0, displayName: undefined, entity: self } },
    inventory,
    blockAt: (point: Vec3) => world.blockAt(point),
    world: { getBlockStateId: world.getBlockStateId, getBlock: world.blockAt, raycast: world.raycast, getColumn: world.getColumn, getColumns: world.getColumns },
    supportFeature: registry.supportFeature,
  });
  world.getBlockStateId(feet); // the first read checks every named cell against the dimension's heights, now the bot's `game` exists
  world.forwardTo(bot);
  server.onTimePacket(() => bot.emit("time"));
  // The server's position packet, as the protocol hands it to Mineflayer's handler (`physics.js`).
  server.onPosition(({ x, y, z }) => client.emit("position", { x, y, z, yaw: 0, pitch: 0, flags: {}, teleportId: 0 }));
  attachFakePhysics(bot, clock, options.simulatePhysics);
  attachFakeDigging(bot, clock, world);
  const serverEntities = attachFakeEntities(bot, { server, inventory, entities });
  attachFakeVehicle(bot, { server });
  const swing = attachFakeSwing({ server, inventory });
  attachFakeBoatDamage(bot, { server, entities: serverEntities, inventory, swing });
  seatPassengersOfSpecs(bot, server, entities, options.entities ?? {});
  const windows = attachFakeWindows(bot, { server, world, inventory, containers: options.containers ?? {}, spawn: serverEntities.spawn });
  attachFakeUse(bot, { server, world, inventory, entities });
  attachFakeItems(bot, { server, world, inventory, spawn: serverEntities.spawn });
  attachFakePlacement(bot, { clock, server, world, inventory, windows });
  const combat = attachFakeCombat(bot, { server, inventory, entities: serverEntities, swing });
  attachFakeLavaFlow({ server, world });
  attachFakeFindBlocks(bot);
  const breath = attachFakeBreath(bot, { server });
  attachFakeSleep(bot, { server, world });
  attachFakePlugins(bot, client, username);
  Object.defineProperties(bot, Object.getOwnPropertyDescriptors(options.overrides ?? {}));
  return { bot, clock, server, world, inventory, entities: serverEntities, breath, windows, combat };
}

/** The test's entities as Prismarine entities, sized from the version's data, keyed by id. */
function spawnedEntities(
  make: (name: string, position: Vec3, id: number) => Entity,
  specs: Readonly<Record<number, FakeEntitySpec>>,
): Record<number, Entity> {
  return Object.fromEntries(
    Object.entries(specs).map(([id, { name, position, ...extra }]) => {
      const entity = make(name, new Vec3(position.x, position.y, position.z), Number(id));
      return [id, Object.assign(entity, withoutPassengers(extra))];
    }),
  );
}

/** The extra fields of an entity spec without `passengers`, which is not a field of the entity but its riders. */
function withoutPassengers(extra: Record<string, unknown>): Record<string, unknown> {
  const { passengers: _passengers, ...rest } = extra;
  return rest;
}

/** The riders the specs name, made and seated on their vehicles (the server's `Passengers` at the start). */
function seatPassengersOfSpecs(bot: FakeBot, server: FakeServer, entities: FakeEntities, specs: Readonly<Record<number, FakeEntitySpec>>): void {
  for (const [id, { passengers = [] }] of Object.entries(specs)) {
    const vehicle = bot.entities[Number(id)]!;
    seatStartingPassengers(bot, server, vehicle, passengers.map((name) => entities.make(name, vehicle.position, entities.nextId())));
  }
}
