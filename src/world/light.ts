/**
 * The light of a cell as the client holds it (contract check `light-in-cells`, with the prismarine-chunk light patch `patches/prismarine-chunk@1.41.0.patch`:
 * `bot.blockAt(cell).skyLight` and `.light` are what the server sent). A cell the client holds no light for reads null, never 0: the server sends light
 * sections only near the terrain, a cell in a section it sent none for (high over the ground, open sky in truth) answers 0 through Prismarine's `getSkyLight`,
 * and a bot told "sky 0" at noon on a hill would believe it stands in the dark.
 */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

type LightLayer = "skyLight" | "blockLight";

/** A prismarine-chunk 1.18 column's light sections, `null` for one the server sent none for (the library ships no typings). */
type LightColumn = Record<`${LightLayer}Sections`, readonly unknown[] | undefined>;

/**
 * Whether the column holds light data for the cell's section: false only when the column holds light in some other section and none in this one (the
 * real client's no-data case). A column with no light section at all is not judged here: the shared fake's columns hold none and its blocks carry
 * the measured values, undefined for a shape nobody measured.
 */
function sectionHoldsLight(bot: Bot, layer: LightLayer, cell: Vec3): boolean {
  const column = bot.world.getColumnAt(cell) as unknown as LightColumn | null | undefined;
  const sections = column?.[`${layer}Sections`];
  if (!Array.isArray(sections) || sections.every((section) => section === null)) return true;
  const { minY } = bot.game as typeof bot.game & { minY: number }; // the game plugin supplies it; Mineflayer's type omits it
  const index = Math.floor((Math.floor(cell.y) - minY) / 16) + 1;
  return sections[index] !== null && sections[index] !== undefined;
}

export interface CellLight {
  readonly sky: number | null;
  readonly block: number | null;
}

const NO_LIGHT: CellLight = { sky: null, block: null };

/** The sky and block light of `cell`: null for a cell with no block (unloaded) and for each layer the client holds no data for. */
export function lightAt(bot: Bot, cell: Vec3): CellLight {
  const block = bot.blockAt(cell);
  if (!block) return NO_LIGHT;
  const read = (value: unknown, layer: LightLayer) => (typeof value === "number" && sectionHoldsLight(bot, layer, cell) ? value : null);
  return { sky: read(block.skyLight, "skyLight"), block: read(block.light, "blockLight") };
}
