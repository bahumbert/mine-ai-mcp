/** The arena frame: how a scenario client turns arena-local coordinates into the world coordinates of its lane. */
import { z } from "zod";

/** `client.env` key carrying the lane offset from the scenario server to the client host. */
export const ARENA_ENV = "MINE_AI_ARENA";

export interface ArenaOffset {
  readonly x: number;
  readonly z: number;
}

/** A scenario run by plain `mine-labs run`: no offset, every coordinate as written. */
export const ZERO_ARENA: ArenaOffset = Object.freeze({ x: 0, z: 0 });

export interface ArenaFrame {
  readonly offset: ArenaOffset;
  world(local: readonly [number, number, number]): [number, number, number];
  local(world: readonly [number, number, number]): [number, number, number];
}

const arenaOffsetSchema = z.strictObject({ x: z.number().int(), z: z.number().int() });

/** The `client.env` value for a lane offset. */
export function encodeArena(offset: ArenaOffset): string {
  return JSON.stringify({ x: offset.x, z: offset.z });
}

/** The offset a client host runs at; a bad value throws, because a lane client at offset zero would build in another lane. */
export function decodeArena(env: Record<string, string | undefined>): ArenaOffset {
  const encoded = env[ARENA_ENV];
  if (encoded === undefined) return ZERO_ARENA;
  return arenaOffsetSchema.parse(JSON.parse(encoded));
}

/** Offsets move x and z only: the flat floor is at the same y in every lane. */
export function arenaFrame(offset: ArenaOffset): ArenaFrame {
  return {
    offset,
    world: ([x, y, z]) => [x + offset.x, y, z + offset.z],
    local: ([x, y, z]) => [x - offset.x, y, z - offset.z],
  };
}

const X_KEYS: ReadonlySet<string> = new Set(["x", "x1", "x2"]);
const Z_KEYS: ReadonlySet<string> = new Set(["z", "z1", "z2"]);
/** Action input keys holding an absolute world coordinate (the census test in `frame.test.ts` holds the action schemas to it). */
export const ACTION_COORDINATE_KEYS: ReadonlySet<string> = new Set([...X_KEYS, ...Z_KEYS]);

/** A copy of an action input with every numeric `x`, `x1`, `x2`, `z`, `z1`, `z2` at any depth moved into the lane; `y` and non-numbers stay. */
export function arenaActionInput<T>(input: T, frame: ArenaFrame): T {
  return shiftValue(input, frame.offset) as T;
}

function shiftValue(value: unknown, offset: ArenaOffset): unknown {
  if (Array.isArray(value)) return value.map((item) => shiftValue(item, offset));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shiftEntry(key, child, offset)]));
}

function shiftEntry(key: string, child: unknown, offset: ArenaOffset): unknown {
  if (typeof child === "number") {
    if (X_KEYS.has(key)) return child + offset.x;
    if (Z_KEYS.has(key)) return child + offset.z;
  }
  return shiftValue(child, offset);
}
