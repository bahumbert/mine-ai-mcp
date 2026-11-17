/**
 * The blocks a scaffold takedown dug out drop as items, and the build call ends when the last dig is done: an item that
 * landed out of the bot's reach lay where it fell and the next call started with fewer scaffold blocks than the last
 * one had taken (Mine Labs 2026-11-12, template-roof-counted-scaffold-medieval-small: the last dig was made from three
 * blocks away, call 6 placed 2 dirt and got 1 back). The sweep walks to each such item before the takedown returns.
 */
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { isItemEntity, pickupObservedItem } from "../../../world/item-pickup.js";
import { packKey, type BlockPosition } from "../../index.js";
import type { BuildProgress, BuildRequest } from "./build-process.js";

/** How far sideways of a removed block a drop of it is looked for (the cut-off is unmeasured: the drops measured lay within about a block of their block, houses.md "Measured with the counted scaffold carried"). */
const DROP_SPREAD = 3;

/** An item falls from the block it dropped from, down to the ground: only items not above the removed block count (unmeasured: the drop measured lay half a block above its block). */
const DROP_ABOVE_BLOCK = 1.5;

/** The walk to one drop gives up after this long (monotonic ms; unmeasured: the measured walks took 0.5 to 1.7 s): a drop in a hole the route cannot reach stays there, and the build is complete anyway. */
const DROP_WALK_MS = 8_000;

/**
 * The nearest dropped item new since `baseline`, not tried yet, lying near a removed block (sideways within `DROP_SPREAD`,
 * not above it). Any item entity counts, its stack still unnamed or not: what the sweep proves is its own pickup.
 */
function nextDrop(bot: Bot, baseline: ReadonlySet<number>, tried: ReadonlySet<number>, removed: readonly BlockPosition[]): Entity | null {
  const near = (entity: Entity) => removed.some((block) => Math.hypot(entity.position.x - (block.x + 0.5), entity.position.z - (block.z + 0.5)) <= DROP_SPREAD && entity.position.y <= block.y + DROP_ABOVE_BLOCK);
  const lying = Object.values(bot.entities).filter((entity) => isItemEntity(entity) && !baseline.has(entity.id) && !tried.has(entity.id) && near(entity));
  return lying.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] ?? null;
}

const carriedCount = (bot: Bot): number => bot.inventory.items().reduce((total, stack) => total + stack.count, 0);

/** Walks to `drop` and waits for its own pickup: the server's collect of that entity, or the bag growing once the entity is gone (another item picked up on the way is not it). */
async function pickUpDrop(bot: Bot, request: BuildRequest, progress: BuildProgress, drop: Entity, movements: ReturnType<BuildRequest["movements"]>): Promise<void> {
  let collected = false;
  const onCollect = (collector: Entity, item: Entity) => { if (collector.id === bot.entity.id && item.id === drop.id) collected = true; };
  const before = carriedCount(bot);
  bot.on("playerCollect", onCollect);
  try {
    await pickupObservedItem(bot, {
      entityId: drop.id,
      navigate: request.route,
      movements,
      hasArrived: () => collected || (bot.entities[drop.id] === undefined && carriedCount(bot) > before),
      onPlacement: (placed) => void progress.scaffold.set(packKey(placed.position.x, placed.position.y, placed.position.z), placed),
      signal: request.signal,
      timeoutMs: DROP_WALK_MS,
    });
  } finally {
    bot.off("playerCollect", onCollect);
  }
}

/**
 * Walks to and picks up the items the takedown's digs of `removed` dropped (each item tried once: `tried` is the takedown's
 * own set, shared by the sweeps of all its rounds, and takes the ids tried), through the request's
 * own route with the structure protected; what the walk places is recorded as scaffold in `progress`. An item it cannot
 * reach is left (the build is complete either way); an abort ends the sweep with the abort, and a policy stop
 * (`request.stopSignal`) ends it at once. The baseline is the request's: entities lying when its first takedown began.
 * No wait for a late drop: the dig's own confirmation and the build loop's turn after it pass the packets that follow
 * the block's change (the item spawn came 1 ms after it in the Mine Labs run).
 */
export async function pickUpScaffoldDrops(bot: Bot, request: BuildRequest, progress: BuildProgress, removed: readonly BlockPosition[], tried: Set<number>): Promise<void> {
  const baseline = progress.lyingBeforeTakedown;
  if (removed.length === 0 || baseline === null) return;
  const movements = request.movements(new Set(request.cells.map((cell) => packKey(cell.position.x, cell.position.y, cell.position.z))));
  for (let drop = nextDrop(bot, baseline, tried, removed); drop !== null; drop = nextDrop(bot, baseline, tried, removed)) {
    request.signal?.throwIfAborted();
    if (request.stopSignal?.aborted === true) return;
    tried.add(drop.id);
    await pickUpDrop(bot, request, progress, drop, movements);
  }
}
