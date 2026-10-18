/**
 * The live bot's farming gestures (`FarmBody`) and the crop facts of its version (`CropFacts`).
 *
 * A hoe on soil and a seed on farmland are a right-click on the block's top face, exactly as a player does it
 * (`useItemAt`), each confirmed by the cell changing. A crop or a tuft of grass breaks at once by hand, so it is dug
 * directly once in reach: the movement policy refuses to break crops on routes (`ROUTE_PROTECTED_CROPS`), which is
 * right for every route and says nothing against harvesting one on purpose.
 */
import type { Bot, BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, observeMineflayerBlock, type NavigationRuntime } from "../../navigation/index.js";
import { ripeState, seedOf } from "../../world/block-drops.js";
import { droppedItemName, pickupObservedItem, snapshotEntityIds } from "../../world/item-pickup.js";
import { useItemAt } from "../../world/item-use.js";
import { snapshotTools } from "../../world/tool-tiers.js";
import type { TendCropsRequest } from "./contract.js";
import type { CellBlock, CropFacts, FarmBody, FarmCell, TillFailure } from "./tend-plot.js";

/** A player's block reach is 4.5 from the eyes; a little less keeps the use from failing at the edge. */
const FARM_REACH = 4.2;
/** Server answers to a right-click arrive within a few ticks; a use that changed nothing by then never will. */
const USE_TIMEOUT_TICKS = 10;
/** How far past the plot's edge a harvest drop may roll and still be fetched. */
const DROP_MARGIN = 2;
/** Looks with no drop to fetch before the sweep ends, this many ticks apart: drops still arriving are waited for. */
const QUIET_LOOKS = 3;
const QUIET_LOOK_TICKS = 10;

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Crops as the version's loot tables describe them: ripe in the state their crop drops in, planted from their unripe drop. */
export function cropFacts(bot: Pick<Bot, "registry" | "version">): CropFacts {
  return {
    isRipe(block) {
      if (block.properties.age === undefined) return null;
      const ripe = ripeState(block.name, bot.version);
      if (ripe !== null) return Object.entries(ripe).every(([key, value]) => String(block.properties[key]) === value);
      // No loot condition to read (nether wart drops the same at any age): ripe at its last age.
      const ages = bot.registry.blocksByName[block.name]?.states?.find((state) => state.name === "age")?.num_values;
      return ages !== undefined && Number(block.properties.age) === ages - 1;
    },
    seedOf: (name) => seedOf(name, bot.version),
  };
}

/** Server ticks that must pass after a use for an unchanged block to count as the server's answer (the server may be far behind). */
export const TILL_CONFIRM_TICKS = 20;

/**
 * A failed hoe use as the plot sees it. The block is "unchanged" only once the server clock moved on by
 * {@link TILL_CONFIRM_TICKS} after the use with no block update (packets arrive in order: ours would have come first)
 * and the hoe is still carried; a wait that ended earlier is "unconfirmed", an error or a broken hoe teaches nothing.
 */
export function tillFailure(failure: { readonly error: string; readonly serverTicksWaited: number | null }, hoeCarried: boolean): TillFailure {
  if (failure.serverTicksWaited === null || !hoeCarried) return { kind: "error", error: failure.error };
  return failure.serverTicksWaited >= TILL_CONFIRM_TICKS ? { kind: "unchanged" } : { kind: "unconfirmed" };
}

export function mineflayerFarmBody(bot: Bot, navigation: NavigationRuntime, request: TendCropsRequest, signal?: AbortSignal): FarmBody {
  const baseline = snapshotEntityIds(bot);
  /** Drops it could not get (a full inventory, no route): left, so the others are still fetched. */
  const leftBehind = new Set<number>();
  const vec = (cell: FarmCell) => new Vec3(cell.x, cell.y, cell.z);
  // Routes never dig the farmland they work, nor drop scaffold onto the plot.
  const movements = () => createMovements(bot, { protectedBlockNames: ["farmland"], scaffolding: false });
  const inReach = (cell: FarmCell) => bot.entity.position.offset(0, 1.62, 0).distanceTo(vec(cell).offset(0.5, 0.5, 0.5)) <= FARM_REACH;
  const stack = (item: string) => bot.inventory.items().find((candidate) => candidate.name === item) ?? null;
  const hoe = () => {
    const name = snapshotTools(bot).tools.find((entry) => entry.class === "hoe")?.item ?? null;
    return name === null ? null : stack(name);
  };

  /** Right-click the top face of the block at `cell` holding `item`, until `watched` reads differently. */
  const useOnTop = async (cell: FarmCell, item: NonNullable<ReturnType<typeof stack>>, watched: FarmCell): Promise<{ readonly error: string; readonly serverTicksWaited: number | null } | null> => {
    const block = bot.blockAt(vec(cell));
    if (block === null) return { error: "the cell is not loaded", serverTicksWaited: null };
    const before = bot.blockAt(vec(watched))?.stateId;
    const result = await useItemAt(bot, {
      item,
      lookAt: { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 },
      on: { block, face: { x: 0, y: 1, z: 0 } },
      expectedCells: [{ position: watched, matches: (current) => current.stateId !== before }],
      timeoutTicks: USE_TIMEOUT_TICKS,
      ...(signal && { signal }),
    });
    return result.kind === "used" ? null : { error: result.error, serverTicksWaited: result.serverTicksWaited ?? null };
  };

  return {
    read(x, y, z) {
      const block = bot.blockAt(new Vec3(x, y, z));
      if (block === null) return null;
      const cell: CellBlock = {
        name: block.name,
        properties: block.getProperties() as CellBlock["properties"],
        liquid: observeMineflayerBlock(block).traits.liquid !== null,
        empty: block.boundingBox === "empty",
        breakable: bot.registry.blocksByName[block.name]?.diggable ?? false,
      };
      return cell;
    },

    async reach(cell) {
      if (inReach(cell)) return null;
      const route = await navigation.navigate({ movements: movements(), goal: nearGoal(cell, 3), ...(signal && { signal }) });
      if (inReach(cell)) return null;
      return route.status === "stopped" ? route.reason : "the route ended out of reach";
    },

    async breakBlock(cell) {
      const block = bot.blockAt(vec(cell));
      if (block === null) return "the cell is not loaded";
      try {
        await bot.dig(block, true);
      } catch (cause) {
        signal?.throwIfAborted();
        return message(cause);
      }
      return bot.blockAt(vec(cell))?.name === block.name ? "the block is still there" : null;
    },

    async till(soil) {
      const item = hoe();
      if (item === null) return { kind: "no hoe" };
      const failure = await useOnTop(soil, item, soil);
      if (failure === null) return null;
      return tillFailure(failure, hoe() !== null);
    },

    async plant(soil, item) {
      const seeds = stack(item);
      return seeds === null ? `no ${item} is carried` : (await useOnTop(soil, seeds, { x: soil.x, y: soil.y + 1, z: soil.z }))?.error ?? null;
    },

    async collectDrops() {
      const inPlot = (position: Vec3) =>
        position.x >= request.min.x - DROP_MARGIN && position.x <= request.max.x + 1 + DROP_MARGIN &&
        position.z >= request.min.z - DROP_MARGIN && position.z <= request.max.z + 1 + DROP_MARGIN &&
        position.y >= request.y - 1 && position.y <= request.y + 3;
      const dropped = () => Object.values(bot.entities).filter((entity) => !baseline.has(entity.id) && entity.name === "item" && inPlot(entity.position));
      // Nearest first, asked again after each pickup: the walk changes what is nearest. A drop whose item is not known
      // yet looks like nothing, so the sweep ends only after a few quiet looks (live 2026-10-03: 14 wheat harvested,
      // 2 picked up; the rest lay on the plot).
      let quiet = 0;
      while (quiet < QUIET_LOOKS) {
        signal?.throwIfAborted();
        const target = dropped()
          .filter((entity) => !leftBehind.has(entity.id) && droppedItemName(entity) !== null)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (target === undefined) {
          quiet += 1;
          await bot.waitForTicks(QUIET_LOOK_TICKS);
          continue;
        }
        quiet = 0;
        let collected = false;
        const onCollect: BotEvents["playerCollect"] = (collector, item) => {
          if (collector.id === bot.entity.id && item.id === target.id) collected = true;
        };
        bot.on("playerCollect", onCollect);
        try {
          const result = await pickupObservedItem(bot, {
            entityId: target.id,
            navigate: navigation.navigate,
            movements: movements(),
            hasArrived: () => collected,
            ...(signal && { signal }),
          });
          if (result.kind !== "collected") leftBehind.add(target.id);
        } finally {
          bot.off("playerCollect", onCollect);
        }
      }
      return { left: dropped().map((entity) => droppedItemName(entity) ?? "an item not identified yet") };
    },

    carried: (item) => bot.inventory.items().filter((candidate) => candidate.name === item).reduce((sum, candidate) => sum + candidate.count, 0),
    hasHoe: () => hoe() !== null,
  };
}
