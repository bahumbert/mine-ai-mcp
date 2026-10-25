/**
 * Worlds written as layers of letters, for fixtures copied from a frozen scene (`.agent/scripts/frozen-scene/blocks.py`).
 *
 * One layer is the rows of one y, `rows[0]` at `origin.z` and the first column at `origin.x`; the legend names the block
 * each letter stands for. Every cell of `box` the layers do not cover is `outside(y)`, so a pocket cut from a larger
 * scene keeps solid stone around it and water over it as it had.
 */
import type { Bot } from "mineflayer";
import { blockClass, observeMineflayerBlock } from "../navigation/mineflayer/world.js";
import { MemoryWorld } from "../navigation/world/memory-world.js";
import type { FakeCell } from "./fake-bot/index.js";

export interface LayeredWorldSpec {
  readonly origin: { readonly x: number; readonly z: number };
  /** Block name by letter; every letter a layer uses. */
  readonly legend: Readonly<Record<string, string>>;
  /** The rows of each y, listed from `origin.z` upward, columns from `origin.x` upward. */
  readonly layers: Readonly<Record<number, readonly string[]>>;
  /** The block name of a cell no layer covers, by y. */
  readonly outside: (y: number) => string;
  /** How far past the layers' own extent the outside blocks go, in x/z; and the y range. */
  readonly margin: number;
  readonly yRange: { readonly min: number; readonly max: number };
}

/** A legend name as a block name and, for `water[level=8]` (falling water), its level. */
function parseNamedBlock(name: string): { base: string; level?: number } {
  const [base, level] = name.split(/[[\]]/);
  return level === undefined ? { base: base! } : { base: base!, level: Number(level.replace("level=", "")) };
}

/** Put one block in the world; `name` may carry a level, as `water[level=8]` (falling water), which the legend uses too. */
export function loadNamedBlock(world: MemoryWorld, bot: Pick<Bot, "registry">, at: { x: number; y: number; z: number }, name: string): void {
  const { base, level } = parseNamedBlock(name);
  const registered = bot.registry.blocksByName[base];
  if (!registered) throw new Error(`unknown block ${name}`);
  const Block = blockClass(bot);
  const made = level === undefined
    ? Block.fromStateId(registered.defaultState, 0)
    : Block.fromProperties(registered.id, { level }, 0);
  const block = observeMineflayerBlock(made);
  if (block.kind !== "loaded") throw new Error(name);
  world.load(at, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
}

/** Every cell of the spec's box, with the block name its layer gives it or `outside` for its y. */
function forEachLayeredCell(spec: LayeredWorldSpec, visit: (at: { x: number; y: number; z: number }, name: string) => void): void {
  const rows = Object.values(spec.layers)[0]!;
  const width = rows[0]!.length;
  for (let y = spec.yRange.min; y <= spec.yRange.max; y += 1) {
    const layer = spec.layers[y];
    for (let z = spec.origin.z - spec.margin; z < spec.origin.z + rows.length + spec.margin; z += 1) {
      for (let x = spec.origin.x - spec.margin; x < spec.origin.x + width + spec.margin; x += 1) {
        const letter = layer?.[z - spec.origin.z]?.[x - spec.origin.x];
        visit({ x, y, z }, letter === undefined ? spec.outside(y) : spec.legend[letter]!);
      }
    }
  }
}

export function layeredWorld(bot: Pick<Bot, "registry">, spec: LayeredWorldSpec): MemoryWorld {
  const world = new MemoryWorld();
  forEachLayeredCell(spec, (at, name) => loadNamedBlock(world, bot, at, name));
  return world;
}

/** The same cells for the shared fake's world (`createFakeBot({ cells })`); every cell outside the box is air there. */
export function layeredCells(spec: LayeredWorldSpec): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  forEachLayeredCell(spec, (at, name) => {
    const { base, level } = parseNamedBlock(name);
    cells[`${at.x},${at.y},${at.z}`] = level === undefined ? base : { name: base, properties: { level } };
  });
  return cells;
}
