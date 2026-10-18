// Spots a bot the server keeps putting back (a block her client holds as air, the server as solid) and asks the server for the cells' real state.
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { currentVehicle } from "../actions/navigate/vehicle-sync.js";

/** Corrections at one spot inside `WINDOW_MS` that mean the client and the server disagree about the cells around her. */
const CORRECTIONS = 8;
const WINDOW_MS = 2_000;
const MAX_RESYNCS = 3;
const RESYNC_WINDOW_MS = 30_000;
const PAUSE_MS = 60_000;
/** Two positions closer than this on every axis are the same spot. */
const SAME = 0.001;
/** The bot's hitbox half-width, rounded up: the columns it touches. */
const HALF_WIDTH = 0.3;
const OFF_HAND_SLOT = 45;
/** Items the off hand may hold while the resync runs: neither has a use on a block. */
const HARMLESS_OFF_HAND_ITEMS: readonly string[] = ["shield", "totem_of_undying"];
const FACE_UP = 1;
const OFF_HAND = 1;

// Mineflayer numbers every interaction from one counter per bot; the packet joins that count (live 2026-10-18, Ayla).
const { nextInteractionSequence } = createRequire(import.meta.url)("mineflayer/lib/interaction_sequence") as {
  nextInteractionSequence(bot: Bot): number | undefined;
};

export interface GhostBlockOptions {
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/** What the watcher knows of the spot the server keeps putting her back to. */
interface Spot {
  readonly position: Vec3;
  /** Wall-clock times of the corrections at this spot still inside `WINDOW_MS`. */
  corrections: number[];
  /** Wall-clock times of the resyncs at this spot still inside `RESYNC_WINDOW_MS`. */
  resyncs: number[];
  pausedUntil: number;
  offHandLogged: boolean;
}

/** The cells her hitbox touches and the levels around her feet: the columns at x and z ± 0.3, levels floor(y) - 1 to + 1. */
export function cellsAround(position: Vec3): Vec3[] {
  const columns = new Map<string, readonly [number, number]>();
  for (const x of [position.x - HALF_WIDTH, position.x + HALF_WIDTH]) {
    for (const z of [position.z - HALF_WIDTH, position.z + HALF_WIDTH]) {
      columns.set(`${Math.floor(x)},${Math.floor(z)}`, [Math.floor(x), Math.floor(z)]);
    }
  }
  const feet = Math.floor(position.y);
  return [...columns.values()].flatMap(([x, z]) => [feet - 1, feet, feet + 1].map((y) => new Vec3(x, y, z)));
}

/** Watches one bot's forced moves (the server's "go back there") and resyncs the cells around a spot it repeats; returns the cleanup. */
export function watchGhostBlocks(bot: Bot, options: GhostBlockOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => console.error(line));
  let spot: Spot | null = null;

  const onForcedMove = () => {
    if (currentVehicle(bot) !== null) return;
    const at = now();
    spot = countCorrection(spot, bot.entity.position, at);
    if (spot.corrections.length < CORRECTIONS) return;
    spot.corrections = [];
    resyncOrGiveUp(bot, spot, at, log);
  };
  const forget = () => { spot = null; };

  bot.on("forcedMove", onForcedMove);
  bot.on("death", forget);
  bot.on("spawn", forget);
  return () => {
    bot.off("forcedMove", onForcedMove);
    bot.off("death", forget);
    bot.off("spawn", forget);
  };
}

/** The spot after one more correction at `position`: a different position starts a new spot, old corrections drop out. */
function countCorrection(spot: Spot | null, position: Vec3, at: number): Spot {
  if (spot === null || !isSameSpot(spot.position, position)) {
    return { position: position.clone(), corrections: [at], resyncs: [], pausedUntil: 0, offHandLogged: false };
  }
  spot.corrections = [...spot.corrections.filter((time) => at - time <= WINDOW_MS), at];
  return spot;
}

function isSameSpot(a: Vec3, b: Vec3): boolean {
  return Math.abs(a.x - b.x) <= SAME && Math.abs(a.y - b.y) <= SAME && Math.abs(a.z - b.z) <= SAME;
}

/** Resync the cells around the spot, unless it is paused, was resynced `MAX_RESYNCS` times already, or the off hand is busy. */
function resyncOrGiveUp(bot: Bot, spot: Spot, at: number, log: (line: string) => void): void {
  if (at < spot.pausedUntil) return;
  spot.resyncs = spot.resyncs.filter((time) => at - time <= RESYNC_WINDOW_MS);
  if (spot.resyncs.length >= MAX_RESYNCS) {
    spot.pausedUntil = at + PAUSE_MS;
    spot.resyncs = [];
    log(`ghost block not resolved at ${describe(spot.position)}`);
    return;
  }
  const offHand = bot.inventory.slots[OFF_HAND_SLOT]?.name;
  if (offHand !== undefined && !HARMLESS_OFF_HAND_ITEMS.includes(offHand)) {
    if (!spot.offHandLogged) log(`ghost block at ${describe(spot.position)}: off hand holds ${offHand}, not resynced`);
    spot.offHandLogged = true;
    return;
  }
  spot.resyncs.push(at);
  const cells = cellsAround(spot.position);
  for (const cell of cells) askServerForCell(bot, cell);
  log(`ghost block at ${describe(spot.position)}: resynced ${cells.length} cells`);
}

/** An off-hand use-item-on: a vanilla server answers it with the cell's real block (and its neighbour's) and changes nothing. */
function askServerForCell(bot: Bot, cell: Vec3): void {
  bot._client.write("block_place", {
    hand: OFF_HAND,
    location: cell,
    direction: FACE_UP,
    cursorX: 0.5,
    cursorY: 1,
    cursorZ: 0.5,
    insideBlock: false,
    worldBorderHit: false,
    sequence: nextInteractionSequence(bot),
  });
}

function describe(position: Vec3): string {
  return `${position.x} ${position.y} ${position.z}`;
}
