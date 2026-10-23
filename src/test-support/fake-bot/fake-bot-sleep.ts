/**
 * The fake bot's beds and weather: Mineflayer's own `bed.js` and `rain.js` run on the bot (so `sleep`, `wake`,
 * `isSleeping`, the refusals thrown before any packet, `isRaining`, `thunderState` and `rainState` are the library's code,
 * not a copy of it), `activateBlock` writes the use packet as `inventory.js:207-260` does, and the server answers a bed use
 * as measured by the contract checks `bed-sleep-and-wake`, `bed-refused-monster-near` and `rain-and-thunder-state`
 * (Mine Labs 2026-10-23): accepted at night or under a dark sky, refused with an action-bar message by day or with a monster
 * near, the sleeper's pose and bed in her metadata, the bed shown occupied, and the night skipped once every player has slept
 * 100 ticks, which wakes her at the dawn. Not measured (the contract driver runs one bot): the other players' sleep, which
 * the server reads from their metadata here; the spawn point a day use sets, with its `block.minecraft.set_spawn` message (the fake sends only the refusal); a bed too far or obstructed (Mineflayer refuses first); a bed another player sleeps in.
 */
import { createRequire } from "node:module";
import type { Bot, Player } from "mineflayer";
import type { Block } from "prismarine-block";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { MineflayerBlock } from "../../navigation/mineflayer/world.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeEntities } from "./fake-bot-items.js";
import type { FakeServer } from "./fake-server.js";
import type { FakeWorld } from "./fake-world.js";

declare module "mineflayer" {
  interface Bot {
    /** The rain level the server last sent (`rain.js`); Mineflayer's typings leave it out. */
    rainState: number;
    /** `bed.js:21-60`: which half of the bed the block is, whether it is taken, which way it faces and where the head lies from it. */
    parseBedMetadata(bedBlock: Block): { part: boolean; occupied: boolean; facing: number; headOffset: Vec3 };
  }
  interface BotEvents {
    weatherUpdate: () => void;
  }
}

const require = createRequire(import.meta.url);
type Plugin = (bot: Bot, options: object) => void;
const installRain = require("mineflayer/lib/plugins/rain") as Plugin;
const installBed = require("mineflayer/lib/plugins/bed") as Plugin;
const { nextInteractionSequence } = require("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: Bot): number | undefined };
const chatMessagesOf = require("prismarine-chat") as (registry: Bot["registry"]) => { fromNotch(json: string): ChatLine };

interface ChatLine {
  readonly translate?: string;
  toString(): string;
}

/** `entity_action` 2: leave the bed (`bed.js:wake`). */
const LEAVE_BED = 2;
/** The player's `pose` values (`entities.js:483`): standing and sleeping. */
const POSE_STANDING = 0;
const POSE_SLEEPING = 2;
/** `Player.SLEEP_DURATION`: ticks asleep before the night can be skipped. */
const SLEEP_TICKS_TO_SKIP = 100;
const TICK_MS = 50;
const TICKS_PER_DAY = 24_000;
/** The box a monster stops a rest in: the bed's cell grown 8 by 5 by 8 (`Player.startSleepInBed`). */
const MONSTER_BOX = { x: 8, y: 5, z: 8 };
/** `chat.js` position 2: the action bar. */
const ACTION_BAR = "game_info";
const MESSAGE_NO_SLEEP = "block.minecraft.bed.no_sleep";
const MESSAGE_NOT_SAFE = "block.minecraft.bed.not_safe";
const MESSAGE_OCCUPIED = "block.minecraft.bed.occupied";
const HOSTILE_KIND = "Hostile mobs";

/** A player the test names: Mineflayer's `Player` fields, and whether it sleeps (its entity then carries the pose, unmeasured). */
export type FakePlayerSpec = Partial<Player> & { readonly sleeping?: boolean };

/** The bot's own sleep: where, and how many server ticks so far. */
interface Sleeper {
  readonly head: Vec3;
  readonly foot: Vec3;
  ticks: number;
}

export interface FakeSleepParts {
  readonly clock: FakeClock;
  readonly server: FakeServer;
  readonly world: FakeWorld;
}

/** The keys of a player's metadata the version names, `-1` when it has none. */
function playerKeys(registry: Bot["registry"]): { pose: number; sleepingPos: number } {
  const keys = registry.entitiesByName.player?.metadataKeys ?? [];
  return { pose: keys.indexOf("pose"), sleepingPos: keys.indexOf("sleeping_pos") };
}

/** `entities.js:470-484` for a player's entity: the packet's fields filed by key, `entitySleep` for a sleeping pose or position. */
function hearPlayerMetadata(bot: FakeBot, entity: Entity, pose: number, sleepingPos: { x: number; y: number; z: number } | null): void {
  const keys = playerKeys(bot.registry);
  if (keys.pose < 0 || keys.sleepingPos < 0) throw new Error("no pose or sleeping_pos metadata for a player");
  Reflect.set(entity.metadata, keys.pose, pose);
  Reflect.set(entity.metadata, keys.sleepingPos, sleepingPos);
  bot.emit("entityUpdate", entity);
  if (sleepingPos !== null || pose === POSE_SLEEPING) bot.emit("entitySleep", entity);
}

/** The players the test names as Mineflayer lists them: a `sleeping` flag becomes an entity with the pose and bed in its metadata. */
export function playersOf(
  bot: Pick<Bot, "registry">,
  entities: FakeEntities,
  feet: Vec3,
  specs: Readonly<Record<string, FakePlayerSpec>> = {},
): Record<string, Partial<Player>> {
  const keys = playerKeys(bot.registry);
  return Object.fromEntries(
    Object.entries(specs).map(([username, { sleeping, ...player }]) => {
      if (sleeping === undefined) return [username, player];
      const entity = Object.assign(entities.make("player", feet, entities.nextId()), { username });
      Reflect.set(entity.metadata, keys.pose, sleeping ? POSE_SLEEPING : POSE_STANDING);
      Reflect.set(entity.metadata, keys.sleepingPos, sleeping ? { x: feet.x, y: feet.y, z: feet.z } : null);
      return [username, { username, uuid: "", ping: 0, gamemode: 0, displayName: undefined, ...player, entity } as Partial<Player>];
    }),
  );
}

/** `chat.js:134-143` for an action-bar line: the message, `messagestr` and `actionBar`. */
function hearActionBar(bot: FakeBot, key: string): void {
  const message = chatMessagesOf(bot.registry).fromNotch(JSON.stringify({ translate: key }));
  // The library files the message as its chat class; the typings name it by another path.
  const line = message as never;
  bot.emit("message", line, ACTION_BAR);
  bot.emit("messagestr", message.toString(), ACTION_BAR, line);
  bot.emit("actionBar", line);
}

/** `bot.canDigBlock` (`digging.js:224-230`), which `bed.js` asks before a sleep; the digging plugin of the fake leaves it out. */
function canDigBlock(bot: FakeBot, block: MineflayerBlock | null): boolean {
  return Boolean(block?.diggable) && block!.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0)) <= 5.1;
}

/** The server's reading of a player's entity: asleep by the pose or the bed in its metadata (the others, unmeasured). */
function sleepsOnServer(bot: FakeBot, entity: Entity | null | undefined): boolean {
  if (entity === null || entity === undefined) return false;
  const keys = playerKeys(bot.registry);
  const metadata = entity.metadata as unknown[];
  return metadata[keys.pose] === POSE_SLEEPING || (metadata[keys.sleepingPos] ?? null) !== null;
}

/**
 * Whether a monster's body reaches the bed's cell grown 8 by 5 by 8 (`Player.startSleepInBed`, from the game's source; "monster" as
 * Mineflayer files it, `bed.js`). Measured only for a zombie 4 blocks off (contract `bed-refused-monster-near`): the box edges are unmeasured.
 */
function monsterNear(bot: FakeBot, head: Vec3): boolean {
  return Object.values(bot.entities).some((entity) => {
    if (entity.kind !== HOSTILE_KIND) return false;
    const half = entity.width / 2;
    const reaches = (from: number, to: number, min: number, max: number) => to >= min && from <= max;
    return (
      reaches(entity.position.x - half, entity.position.x + half, head.x - MONSTER_BOX.x, head.x + 1 + MONSTER_BOX.x) &&
      reaches(entity.position.y, entity.position.y + entity.height, head.y - MONSTER_BOX.y, head.y + 1 + MONSTER_BOX.y) &&
      reaches(entity.position.z - half, entity.position.z + half, head.z - MONSTER_BOX.z, head.z + 1 + MONSTER_BOX.z)
    );
  });
}

/** The weather packets, as the protocol hands them to `rain.js` (it reads `reason` by name or number), the join ones now. */
function hearWeather(bot: FakeBot, server: FakeServer): void {
  server.onWeatherPacket((packet) => bot._client.emit("game_state_change", packet));
  for (const packet of server.weatherJoinPackets()) bot._client.emit("game_state_change", packet);
}

/** The server marks both halves of a bed taken or free: the cell rewritten with the same state but `occupied`. */
function setOccupied(world: FakeWorld, cell: Vec3, occupied: boolean): void {
  const block = world.blockAt(cell);
  if (block === null) return;
  world.setCell(cell, { name: block.name, properties: { ...(block.getProperties() as Record<string, string>), occupied: String(occupied) } });
}

/** Give `bot` beds, weather and `activateBlock`, and the server its answers to them. */
export function attachFakeSleep(bot: FakeBot, parts: FakeSleepParts): void {
  const { clock, server, world } = parts;
  installRain(bot, {});
  installBed(bot, {});
  bot.canDigBlock ??= (block) => canDigBlock(bot, block as MineflayerBlock | null);
  bot.activateBlock = (block, direction, cursorPos) => activateBlock(bot, block as MineflayerBlock, direction, cursorPos);
  hearWeather(bot, server);

  let sleeper: Sleeper | null = null;

  /** The server seats her in the bed whose head is `head`: pose and bed in her metadata, both halves occupied. */
  const startSleeping = (head: Vec3, foot: Vec3) => {
    sleeper = { head, foot, ticks: 0 };
    setOccupied(world, head, true);
    setOccupied(world, foot, true);
    hearPlayerMetadata(bot, bot.entity, POSE_SLEEPING, { x: head.x, y: head.y, z: head.z });
  };

  /** She leaves the bed (`wake`, or the skip): the server's record first, what the client hears after. */
  const wakeUp = () => {
    if (sleeper === null) return;
    const { head, foot } = sleeper;
    sleeper = null;
    server.answer(() => {
      setOccupied(world, head, false);
      setOccupied(world, foot, false);
      hearPlayerMetadata(bot, bot.entity, POSE_STANDING, null);
      // The leave-bed animation (`entities.js:144-148`, animation 2).
      bot.emit("entityWake", bot.entity);
    });
  };

  /** `BedBlock.useWithoutItem` and `Player.startSleepInBed`, in the order the game asks. */
  const answerBedUse = (clicked: MineflayerBlock) => {
    const metadata = bot.parseBedMetadata(clicked as unknown as Block);
    const head = metadata.part ? clicked.position : clicked.position.plus(metadata.headOffset);
    const foot = head.minus(metadata.headOffset);
    if (metadata.occupied) return hearActionBar(bot, MESSAGE_OCCUPIED);
    if (sleeper !== null) return;
    if (!server.skyAllowsSleep) return hearActionBar(bot, MESSAGE_NO_SLEEP);
    if (bot.game.gameMode !== "creative" && monsterNear(bot, head)) return hearActionBar(bot, MESSAGE_NOT_SAFE);
    startSleeping(head, foot);
  };

  server.onPacket("block_place", (data) => {
    const clicked = world.blockAt((data as { location: Vec3 }).location);
    if (clicked !== null && bot.isABed(clicked)) server.answer(() => answerBedUse(clicked));
  });
  server.onPacket("entity_action", (data) => {
    if ((data as { actionId: number }).actionId === LEAVE_BED) server.answer(wakeUp);
  });

  /** Everyone asleep (the others by their metadata) and the bot's 100 ticks done: the night goes, the sleepers wake (`ServerLevel.tick`). */
  const skipNightIfEveryoneSleeps = () => {
    const others = Object.values(bot.players).filter((player) => player.entity !== bot.entity);
    if (sleeper === null || sleeper.ticks < SLEEP_TICKS_TO_SKIP || !others.every((player) => sleepsOnServer(bot, player.entity))) return;
    // The server's own weather, not the client's; the weather-cycle gamerule is not modelled (unmeasured).
    const dawn = server.dayTime + TICKS_PER_DAY;
    server.setDayTime(dawn - (dawn % TICKS_PER_DAY));
    // `wakeUpAllPlayers`, then the weather cleared when it rains (`resetWeatherCycle`).
    wakeUp();
    for (const other of others) if (other.entity) hearPlayerMetadata(bot, other.entity, POSE_STANDING, null);
    if (server.raining) server.setWeather("clear");
  };
  let accumulatedMs = 0;
  clock.onSlice("server", (sliceMs) => {
    if (!server.isRunning) return;
    for (accumulatedMs += sliceMs; accumulatedMs >= TICK_MS; accumulatedMs -= TICK_MS) {
      if (sleeper === null) continue;
      // `Player.tick`: a sleep ends once the sky is bright (an operator's `time set`; not measured).
      if (!server.skyAllowsSleep) {
        wakeUp();
        continue;
      }
      sleeper.ticks += 1;
      skipNightIfEveryoneSleeps();
    }
  });
}

/** `vectorToDirection` (`inventory.js:931-944`): the face number by the vector's sign, bottom 0, top 1, north 2, south 3, west 4, east 5. */
function directionOf(face: Vec3): number {
  if (face.y < 0) return 0;
  if (face.y > 0) return 1;
  if (face.z < 0) return 2;
  if (face.z > 0) return 3;
  return face.x < 0 ? 4 : 5;
}

/** `inventory.js:207-260` for a 1.21 server: look at the block, write the use, swing. */
async function activateBlock(bot: FakeBot, block: MineflayerBlock, direction?: Vec3, cursorPos?: Vec3): Promise<void> {
  const face = direction ?? new Vec3(0, 1, 0);
  const cursor = cursorPos ?? new Vec3(0.5, 0.5, 0.5);
  await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), false);
  bot._client.write("block_place", {
    location: block.position,
    direction: directionOf(face),
    hand: 0,
    cursorX: cursor.x,
    cursorY: cursor.y,
    cursorZ: cursor.z,
    insideBlock: false,
    sequence: nextInteractionSequence(bot),
    worldBorderHit: false,
  });
  bot.swingArm(undefined);
}
