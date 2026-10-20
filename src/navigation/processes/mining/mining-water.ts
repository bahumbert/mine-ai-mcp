import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { waitForWorldAge } from "../../../world/world-age.js";
import type { useItemAt } from "../../../world/item-use.js";
import { HORIZONTAL, sourceFeeding, sourceInSight } from "../../../world/liquid.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import { holdWaterPosition } from "../../steering/hold-water-position.js";
import type { BlockPosition } from "../../world/world.js";
import { liveBlockReader } from "../../mineflayer/world.js";
import { isWater } from "../../world/block-geometry.js";
import { waterMiningStance } from "../../world/water.js";

/** World ticks a removed source's spread takes to drain (seven cells, a water update every 5 ticks, and a margin). */
const DRAIN_TICKS = 40;
/** Longest wall-clock wait for that drain, whatever the server's clock does. */
const DRAIN_WALL_MS = 5_000;

const touching = (cell: Vec3) => [
  cell.offset(0, 1, 0),
  cell.offset(0, -1, 0),
  ...HORIZONTAL.map((offset) => cell.plus(offset)),
];

/** Remove feeding sources first; otherwise isolate the target's local water faces. */
export async function clearMiningWater(
  bot: Bot,
  position: BlockPosition,
  place: PlaceIntoCell,
  use: typeof useItemAt | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const target = new Vec3(position.x, position.y, position.z);
  const read = liveBlockReader(bot);
  const holdsWaterAt = (cell: Vec3) => isWater(read(cell.x, cell.y, cell.z));
  if (waterMiningStance(read, bot.entity.position.floored(), bot.entity.onGround)) return null;
  // The target's own faces: water beside the cell over it reaches the target only through that cell, sealed first.
  const wetFaces = () => touching(target).filter(holdsWaterAt);
  const seeds = [...wetFaces(), bot.entity.position.floored()];
  if (!seeds.some(holdsWaterAt)) return null;
  const release = holdWaterPosition(bot, signal);
  const lifetime = signal ?? new AbortController().signal;
  try {
    const sources = new Map<string, Vec3>();
    for (const cell of seeds) {
      const source = sourceFeeding(bot, cell, "water");
      if (source) sources.set(source.toString(), source);
    }
    let removedSource = false;
    for (const source of sources.values()) {
      signal?.throwIfAborted();
      if (!sourceInSight(bot, bot.entity.position.offset(0, 1.62, 0), source)) continue;
      const bucket = bot.inventory.items().find((item) => item.name === "bucket");
      if (bucket && use) {
        const scooped = await use(bot, {
          item: bucket,
          lookAt: source.offset(0.5, 0.9, 0.5),
          expectedHeldItem: "water_bucket",
          ...(signal && { signal }),
        });
        if (scooped.kind !== "failed") {
          removedSource = true;
          continue;
        }
      }
      const plugged = await place(bot, source, { ...(signal && { signal }) });
      if (plugged.kind !== "failed") removedSource = true;
    }
    // A removed source drains its spread on the server's scheduled water updates: wait on the world age, bounded on
    // the wall clock, never on client ticks, which stop with physics.
    if (removedSource) await waitForWorldAge(bot, DRAIN_TICKS, { wallMs: DRAIN_WALL_MS, signal: lifetime,
      until: () => wetFaces().length === 0 && !holdsWaterAt(bot.entity.position.floored()) });
    for (const cell of wetFaces()) {
      const placed = await place(bot, cell, { ...(signal && { signal }) });
      if (placed.kind === "failed") return `water at ${cell} could not be isolated: ${placed.error}`;
    }
    if (Reflect.get(bot.entity, "isInWater") === true)
      return "the mining stance is still in water after isolating the target";
    return wetFaces().length === 0 ? null : "water returned to the target before mining";
  } finally {
    release();
  }
}
