/**
 * The light the fake world's blocks hold, for the shapes the real 1.21.4 server was measured to answer and for no other
 * (contract check `tests/minecraft/contract/checks/light-in-cells.ts`, 2026-11-07/08, with the prismarine-chunk light patch
 * `patches/prismarine-chunk@1.41.0.patch` on the client: `bot.blockAt(cell).skyLight` and `.light` are what the server sent):
 * - an air cell with only air above it up to the dimension's top: sky 15, block 0 (block light unmeasured, so left out, with
 *   an emitting block within 15 cells that is not itself in a sealed region);
 * - an air cell in a sealed region (walls of opaque blocks all round, at most `REGION_CELL_LIMIT` cells): sky 0, block 0 with no
 *   emitter inside, and with one: the emitter's `emitLight` at the emitter's cell, minus the distance in cells through the region at
 *   1 to 3 cells from it; a region with an emitter farther than that: block unmeasured;
 * - a cell whose block is an emitter (empty bounding box, transparent: a torch) in a sealed region: sky 0, block its `emitLight`.
 * Every other shape (a solid block, a wall with a gap, a slab, water, an overhang, an emitter that is no torch such as glowstone, which lights its
 * neighbours at a level nobody measured and so seals nothing) is unmeasured: the fake says nothing (undefined).
 * Only the sections up to the one above the highest block of the world hold light on the server (measured once, on the flat
 * arena: light sections for y -80 to -33 above a floor at y -61, a cell at y -13 in a section with none, where the real client's
 * `blockAt` holds 0 and 0): a cell above them is unmeasured too.
 */
import type { Bot } from "mineflayer";
import type { MineflayerBlock } from "../../navigation/mineflayer/world.js";
import { type ChunkedCells, type DimensionRange, VOID } from "./fake-world-columns.js";

/** Block light is measured to this many cells from an emitter, inside a sealed region. */
const MEASURED_EMITTER_DISTANCE = 3;
/** A region larger than this is not measured as sealed; the walk stops. */
const REGION_CELL_LIMIT = 64;
/** Sky light under an open sky (the arena at noon). */
const OPEN_SKY_LIGHT = 15;
/** Block light reaches this far from an emitter in open air; an emitter that near leaves the open-air block light unmeasured. */
const EMITTER_REACH = 15;
const SECTION_HEIGHT = 16;

export interface CellLight {
  readonly sky: number;
  /** Undefined where the block light of the shape is unmeasured. */
  readonly block: number | undefined;
}

export interface WorldLightSource {
  readonly registry: Bot["registry"];
  /** The state id at the cell; null where the server sent no chunk. */
  stateIdAt(x: number, y: number, z: number): number | null;
  range(): DimensionRange;
  /** The highest y of a block that is not air in the world (the ground included); `undefined` for a world of only air. */
  highestBlockY(): number | undefined;
  /** Every cell whose block is an emitter, as `[x, y, z]`. */
  emitters(): readonly (readonly [number, number, number])[];
}

type CellKind = { readonly kind: "air" } | { readonly kind: "emitter"; readonly emitLight: number } | { readonly kind: "opaque" } | { readonly kind: "other" };

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;

const cellId = (x: number, y: number, z: number) => `${x},${y},${z}`;

export interface WorldLight {
  /** The measured light of the cell, or undefined for an unmeasured shape. */
  at(x: number, y: number, z: number): CellLight | undefined;
  /** False for a state whose cell is never measured (a solid block, a slab, water): its block holds no light, without reading the world. */
  mayHoldLight(stateId: number): boolean;
}

/**
 * A block as the fake's world hands it out: its `light` and `skyLight` are what the game was measured to hold for its shape, undefined
 * for any other (Prismarine's constructor sets 0 and 0, a reading no server sent). A shape that may be measured reads the world when
 * first read, not when the block is made (`blockAt` is hot); a test that assigns either field overrides it.
 */
export function giveBlockItsLight(block: MineflayerBlock, stateId: number, light: WorldLight): void {
  const lit = block as { light: number | undefined; skyLight: number | undefined };
  lit.light = undefined;
  lit.skyLight = undefined;
  if (!light.mayHoldLight(stateId) || block.position === null) return;
  const { x, y, z } = block.position;
  let measured: CellLight | undefined | null = null;
  const measure = (): CellLight | undefined => (measured === null ? (measured = light.at(x, y, z)) : measured);
  const field = (layer: "light" | "skyLight", read: (measure: CellLight | undefined) => number | undefined): PropertyDescriptor => ({
    configurable: true,
    enumerable: true,
    get: () => read(measure()),
    set: (value: number | undefined) => void Object.defineProperty(block, layer, { value, writable: true, configurable: true, enumerable: true }),
  });
  Object.defineProperties(block, { light: field("light", (cell) => cell?.block), skyLight: field("skyLight", (cell) => cell?.sky) });
}

export interface FakeWorldLight extends WorldLight {
  /** A cell was named or changed: the next read scans the named cells again. */
  cellChanged(): void;
}

/** The light of a fake world: its named cells are scanned (the highest block, the emitters) on a read after a change. */
export function createFakeWorldLight(world: {
  readonly registry: Bot["registry"];
  readonly cells: Pick<ChunkedCells, "keys" | "get">;
  readonly groundY: number | null;
  readonly range: () => DimensionRange;
  /** The cell's state, `VOID` where the server sent no chunk. */
  readonly stateAt: (x: number, y: number, z: number) => number | typeof VOID;
}): FakeWorldLight {
  const { registry, cells, groundY } = world;
  let changes = 0;
  let scanned: { version: number; highest: number | undefined; emitters: [number, number, number][] } | undefined;
  const scan = () => {
    if (scanned?.version === changes) return scanned;
    const current = { version: changes, highest: groundY ?? undefined, emitters: [] as [number, number, number][] };
    for (const key of cells.keys()) {
      const state = cells.get(key);
      const block = state === undefined || state === VOID ? undefined : registry.blocksByStateId[state];
      if (block === undefined || block.name === "air") continue;
      const [x, y, z] = key.split(",").map(Number) as [number, number, number];
      current.highest = Math.max(current.highest ?? y, y);
      if (block.emitLight > 0) current.emitters.push([x, y, z]); // every emitter: one that is not sealed in a measured region leaves the open cells near it unmeasured
    }
    scanned = current;
    return current;
  };
  const stateIdAt = (x: number, y: number, z: number) => {
    const state = world.stateAt(x, y, z);
    return state === VOID ? null : state;
  };
  const light = createWorldLight({ registry, stateIdAt, range: world.range, highestBlockY: () => scan().highest, emitters: () => scan().emitters });
  return { ...light, cellChanged: () => void (changes += 1) };
}

function createWorldLight(source: WorldLightSource): WorldLight {
  const { registry } = source;
  const kinds = new Map<number, CellKind>();
  const kindOf = (stateId: number): CellKind => {
    let kind = kinds.get(stateId);
    if (kind === undefined) {
      const block = registry.blocksByStateId[stateId];
      if (block === undefined) kind = { kind: "other" };
      else if (block.name === "air") kind = { kind: "air" };
      else if (block.emitLight > 0 && block.transparent && block.boundingBox === "empty") kind = { kind: "emitter", emitLight: block.emitLight };
      else if (block.emitLight === 0 && !block.transparent && block.boundingBox === "block" && block.filterLight === 15) kind = { kind: "opaque" };
      else kind = { kind: "other" };
      kinds.set(stateId, kind);
    }
    return kind;
  };

  /** Air up to the dimension's top; an unloaded cell on the way leaves it unmeasured. */
  const openToSky = (x: number, y: number, z: number): boolean => {
    const { minY, height } = source.range();
    for (let above = y + 1; above < minY + height; above++) {
      const stateId = source.stateIdAt(x, above, z);
      if (stateId === null || kindOf(stateId).kind !== "air") return false;
    }
    return true;
  };

  /** An emitter whose light may reach the cell: one near it that is not sealed in a region of its own (a sealed one's light stays in it, measured). */
  const unsealedEmitterNear = (x: number, y: number, z: number): boolean =>
    source.emitters().some(([ex, ey, ez]) => Math.max(Math.abs(ex - x), Math.abs(ey - y), Math.abs(ez - z)) <= EMITTER_REACH && sealedRegionLight(ex, ey, ez) === undefined);

  /** The block light of a sealed region as seen from the cell, or `unmeasured` (the region leaks, is too big, has an unmeasured wall, or holds a far emitter). */
  const sealedRegionLight = (x: number, y: number, z: number): CellLight | undefined => {
    const distances = new Map<string, number>([[cellId(x, y, z), 0]]);
    const queue: [number, number, number][] = [[x, y, z]];
    let best = 0;
    let farEmitter = false;
    for (let head = 0; head < queue.length; head++) {
      const [cx, cy, cz] = queue[head]!;
      const distance = distances.get(cellId(cx, cy, cz))!;
      const stateId = source.stateIdAt(cx, cy, cz);
      const kind = stateId === null ? undefined : kindOf(stateId);
      if (kind?.kind === "emitter") {
        if (distance > MEASURED_EMITTER_DISTANCE) farEmitter = true;
        else best = Math.max(best, kind.emitLight - distance);
      }
      for (const [dx, dy, dz] of NEIGHBOURS) {
        const next: [number, number, number] = [cx + dx, cy + dy, cz + dz];
        if (distances.has(cellId(...next))) continue;
        const nextId = source.stateIdAt(...next);
        if (nextId === null) return undefined;
        const nextKind = kindOf(nextId).kind;
        if (nextKind === "opaque") continue;
        if (nextKind === "other") return undefined;
        if (queue.length >= REGION_CELL_LIMIT) return undefined;
        distances.set(cellId(...next), distance + 1);
        queue.push(next);
      }
    }
    return { sky: 0, block: farEmitter ? undefined : best };
  };

  return {
    mayHoldLight: (stateId) => {
      const kind = kindOf(stateId).kind;
      return kind === "air" || kind === "emitter";
    },
    at(x, y, z) {
      const stateId = source.stateIdAt(x, y, z);
      if (stateId === null) return undefined;
      const kind = kindOf(stateId).kind;
      if (kind !== "air" && kind !== "emitter") return undefined;
      const highest = source.highestBlockY();
      const { minY } = source.range();
      if (highest === undefined || y > minY + (Math.floor((highest - minY) / SECTION_HEIGHT) + 2) * SECTION_HEIGHT - 1) return undefined;
      if (kind === "air" && openToSky(x, y, z)) return { sky: OPEN_SKY_LIGHT, block: unsealedEmitterNear(x, y, z) ? undefined : 0 };
      return sealedRegionLight(x, y, z);
    },
  };
}
