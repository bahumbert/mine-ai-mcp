// A fake farm body for the tend_crops tests: soil at y 63 and what stands on it at y 64, changed the way the server would.
import type { CellBlock, CropFacts, FarmBody, TillFailure } from "../actions/tend-crops/tend-plot.js";

export const block = (name: string, properties: CellBlock["properties"] = {}, traits: Partial<Pick<CellBlock, "liquid" | "empty">> = {}): CellBlock => ({
  name,
  properties,
  liquid: traits.liquid ?? false,
  breakable: name !== "air" && name !== "water",
  empty: traits.empty ?? (name === "air" || name === "short_grass" || name === "poppy" || name.startsWith("wheat") || name === "carrots"),
});


/** Wheat and carrots as the loot tables have them: ripe at age 7, planted from their unripe drop. */
export const CROPS: CropFacts = {
  isRipe: (cell) => (cell.name === "wheat" || cell.name === "carrots" ? cell.properties.age === 7 : null),
  seedOf: (name) => ({ wheat: "wheat_seeds", carrots: "carrot" })[name] ?? null,
};


/** A world of soil at y 63 and what stands on it at y 64, changed the way the server would. */
export class FakeFarm implements FarmBody {
  readonly world = new Map<string, CellBlock>();
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
    this.world.set(`${x},63,${z}`, block(soil, soil === "farmland" ? { moisture: 7 } : {}, { liquid: soil === "water", empty: soil === "water" }));
    this.world.set(`${x},64,${z}`, block(above, age === undefined ? {} : { age }));
  }

  read(x: number, y: number, z: number): CellBlock | null {
    return this.world.get(`${x},${y},${z}`) ?? null;
  }

  async reach(cell: { x: number; y: number; z: number }): Promise<string | null> {
    return this.unreachable.has(`${cell.x},${cell.z}`) ? "no route" : null;
  }

  async breakBlock(cell: { x: number; y: number; z: number }): Promise<string | null> {
    const broken = this.read(cell.x, cell.y, cell.z)!;
    this.calls.push(`break ${broken.name} ${cell.x},${cell.z}`);
    if (broken.name === "wheat") this.ground.push("wheat", "wheat_seeds", "wheat_seeds");
    this.world.set(`${cell.x},${cell.y},${cell.z}`, block("air"));
    return null;
  }

  async till(cell: { x: number; y: number; z: number }): Promise<TillFailure | null> {
    const soil = this.read(cell.x, cell.y, cell.z)!;
    if (!this.hasHoe()) return { kind: "no hoe" };
    this.calls.push(`till ${cell.x},${cell.z}`);
    if (this.useFails !== null) return { kind: "error", error: this.useFails };
    if (this.unconfirmed.has(`${cell.x},${cell.z}`)) return { kind: "unconfirmed" };
    if (!this.tillable.has(soil.name)) return { kind: "unchanged" };
    this.world.set(`${cell.x},${cell.y},${cell.z}`, block("farmland", { moisture: 7 }));
    this.tilledCells += 1;
    return null;
  }

  async plant(cell: { x: number; y: number; z: number }, item: string): Promise<string | null> {
    this.calls.push(`plant ${item} ${cell.x},${cell.z}`);
    // Only seeds take on farmland; the server leaves anything else in the hand.
    if (item !== "wheat_seeds" && item !== "carrot") return "nothing grew";
    this.inventory.set(item, (this.inventory.get(item) ?? 0) - 1);
    this.world.set(`${cell.x},${cell.y + 1},${cell.z}`, block(item === "carrot" ? "carrots" : "wheat", { age: 0 }));
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

