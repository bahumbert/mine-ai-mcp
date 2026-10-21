// A fake farm body for the tend_crops tests: soil at y 63 and what stands on it at y 64, changed the way the server would.
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import type { CellBlock, PlotFacts, FarmBody, TillFailure } from "../actions/tend-crops/tend-plot.js";
import { cellBlockOf, isGroundCover, isTilledSoil } from "../actions/tend-crops/farm-body.js";
import { type FakeCell, createFakeBot } from "./fake-bot/index.js";

const FARM_VERSION = "1.21.4";
const registry = minecraftData(FARM_VERSION);

/** The properties of a block's default state, as the registry's states list them (the order the state ids are laid out in). */
function defaultProperties(name: string): CellBlock["properties"] {
  const entry = registry.blocksByName[name];
  if (entry?.states === undefined) return {};
  const properties: Record<string, string | number | boolean> = {};
  let offset = entry.defaultState - entry.minStateId;
  for (const state of [...entry.states].reverse()) {
    const index = offset % state.num_values;
    offset = Math.floor(offset / state.num_values);
    properties[state.name] = state.type === "bool" ? index === 0 : state.type === "int" ? index : String(state.values?.[index] ?? index);
  }
  return properties;
}

/** A block as the live bot reads it: collision box and diggable from the registry, state properties from the default state unless given. */
export const block = (name: string, properties: CellBlock["properties"] = {}, traits: Partial<Pick<CellBlock, "liquid" | "empty">> = {}): CellBlock => ({
  name,
  properties: { ...defaultProperties(name), ...properties },
  liquid: traits.liquid ?? false,
  breakable: registry.blocksByName[name]?.diggable ?? false,
  empty: traits.empty ?? registry.blocksByName[name]?.boundingBox === "empty",
});


/** Wheat and carrots as the loot tables have them (ripe at age 7, planted from their unripe drop); ground cover and tilled soil as the real facts answer. */
export const PLOT_FACTS: PlotFacts = {
  // A live block gives its age as the registry lists the value (`"7"`, Prismarine `propValue`); `block()` takes a number.
  isRipe: (cell) => (cell.name === "wheat" || cell.name === "carrots" ? String(cell.properties.age) === "7" : null),
  seedOf: (name) => ({ wheat: "wheat_seeds", carrots: "carrot" })[name] ?? null,
  isGroundCover: (name) => isGroundCover(name, "1.21.4"),
  isTilledSoil,
};


/**
 * A world of soil at y 63 and what stands on it at y 64, changed the way the server would. The cells are real blocks
 * of the version in the shared fake's world (`harness`, a bot beside the plot); a cell never set reads as not loaded
 * here (the harness world reads it as air). What the farm carries is `inventory`, not the harness bot's window.
 */
export class FakeFarm implements FarmBody {
  readonly harness = createFakeBot({ version: FARM_VERSION, groundY: null, position: { x: 0.5, y: 64, z: -1.5 } });
  /** The cells `set` or a gesture wrote: every other cell is unloaded. */
  readonly #written = new Set<string>();
  readonly inventory = new Map<string, number>();
  readonly calls: string[] = [];
  hoe = true;
  /** What breaking each crop drops on the ground, picked up by `collectDrops`. */
  readonly ground: string[] = [];
  unreachable = new Set<string>();
  tillable = new Set(["dirt", "grass_block"]);
  /** The hoe breaks once it has tilled this many cells. */
  hoeLasts = Infinity;
  /** Every use fails with this instead of reaching the world (a timeout, a thrown error). */
  useFails: string | null = null;
  /** Cells (x,z) where the use went out and the server was not seen to answer in time. */
  unconfirmed = new Set<string>();
  private tilledCells = 0;

  set(x: number, z: number, soil: string, above = "air", age?: number): void {
    this.#put({ x, y: 63, z }, soil === "farmland" ? { name: soil, properties: { moisture: 7 } } : soil);
    this.#put({ x, y: 64, z }, age === undefined ? above : { name: above, properties: { age } });
  }

  read(x: number, y: number, z: number): CellBlock | null {
    if (!this.#written.has(`${x},${y},${z}`)) return null;
    const placed = this.harness.world.blockAt(new Vec3(x, y, z));
    return placed === null ? null : cellBlockOf(placed, this.harness.bot.registry);
  }

  #put(cell: { x: number; y: number; z: number }, block: FakeCell): void {
    this.#written.add(`${cell.x},${cell.y},${cell.z}`);
    this.harness.world.setCell(new Vec3(cell.x, cell.y, cell.z), block);
  }

  async reach(cell: { x: number; y: number; z: number }): Promise<string | null> {
    return this.unreachable.has(`${cell.x},${cell.z}`) ? "no route" : null;
  }

  async breakBlock(cell: { x: number; y: number; z: number }): Promise<string | null> {
    const broken = this.read(cell.x, cell.y, cell.z)!;
    this.calls.push(`break ${broken.name} ${cell.x},${cell.z}`);
    if (broken.name === "wheat") this.ground.push("wheat", "wheat_seeds", "wheat_seeds");
    this.#put(cell, "air");
    return null;
  }

  async till(cell: { x: number; y: number; z: number }): Promise<TillFailure | null> {
    const soil = this.read(cell.x, cell.y, cell.z)!;
    if (!this.hasHoe()) return { kind: "no hoe" };
    this.calls.push(`till ${cell.x},${cell.z}`);
    if (this.useFails !== null) return { kind: "error", error: this.useFails };
    if (this.unconfirmed.has(`${cell.x},${cell.z}`)) return { kind: "unconfirmed" };
    if (!this.tillable.has(soil.name)) return { kind: "unchanged" };
    this.#put(cell, { name: "farmland", properties: { moisture: 7 } });
    this.tilledCells += 1;
    return null;
  }

  async plant(cell: { x: number; y: number; z: number }, item: string): Promise<string | null> {
    this.calls.push(`plant ${item} ${cell.x},${cell.z}`);
    // Only seeds take on farmland; the server leaves anything else in the hand.
    if (item !== "wheat_seeds" && item !== "carrot") return "nothing grew";
    this.inventory.set(item, (this.inventory.get(item) ?? 0) - 1);
    this.#put({ ...cell, y: cell.y + 1 }, { name: item === "carrot" ? "carrots" : "wheat", properties: { age: 0 } });
    return null;
  }

  async collectDrops(): Promise<{ readonly left: readonly string[] }> {
    this.calls.push("collect drops");
    for (const item of this.ground.splice(0)) this.inventory.set(item, (this.inventory.get(item) ?? 0) + 1);
    return { left: [] };
  }

  carried(item: string): number {
    return this.inventory.get(item) ?? 0;
  }

  hasHoe(): boolean {
    return this.hoe && this.tilledCells < this.hoeLasts;
  }
}

/** The error a reflex that takes the body mid-gesture makes the gesture throw. */
export const reflexCut = () => new Error("[HUNGER] reflex");

/** The farm's `method` does its work on the `nth` call and then the reflex takes the body: the effect is in the world. */
export function cutAfter(farm: FakeFarm, method: "breakBlock" | "till" | "plant" | "collectDrops", nth = 1): void {
  const original = farm[method].bind(farm) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  (farm as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    const result = await original(...args);
    if (++calls === nth) throw reflexCut();
    return result;
  };
}

/** The farm's `method` is cut by the reflex on the `nth` call before it acts. */
export function cutBefore(farm: FakeFarm, method: "collectDrops" | "reach", nth = 1): void {
  const original = farm[method].bind(farm) as (...args: unknown[]) => Promise<unknown>;
  let calls = 0;
  (farm as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
    if (++calls === nth) throw reflexCut();
    return original(...args);
  };
}

