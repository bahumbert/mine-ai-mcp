// Gives offset blocks (bamboo, pointed dripstone) the collision box the server has at their cell, for everything that reads blocks from the bot's world.
import type { Bot } from "mineflayer";
import { offsetBlocks, placeShapes } from "../world/block-offset.js";

type World = Bot["world"];

/** What to put back on a world whose `getBlock` was wrapped: its own property, or none (the method came from its class). */
interface WrappedWorld {
  readonly own: PropertyDescriptor | undefined;
}

/**
 * Minecraft-data gives an offset block one box for every position, vanilla moves it per cell: a bot walking by
 * Mineflayer's box walks into the server's stalk and is put back (live 2026-10-18, Ayla at 191,78,292). Wraps `getBlock`
 * of the bot's world, and of every later world (a dimension change assigns a new one), so physics, `blockAt` and
 * raycasts all get the placed box. Other blocks come back untouched. Returns the cleanup.
 */
export function placeOffsetShapes(bot: Bot): () => void {
  const offsets = offsetBlocks(bot.registry);
  if (offsets.size === 0) return () => undefined;

  const wrapped = new Map<World, WrappedWorld>();
  // A world that caches its blocks must not have one moved twice.
  const placed = new WeakSet<object>();

  const wrap = (world: World): void => {
    // A bare test double has no `getBlock`; a real world always does.
    if (wrapped.has(world) || typeof world?.getBlock !== "function") return;
    const own = Object.getOwnPropertyDescriptor(world, "getBlock");
    const original = world.getBlock.bind(world);
    wrapped.set(world, { own });
    world.getBlock = (position) => {
      const block = original(position);
      const max = block === null ? undefined : offsets.get(block.name);
      if (block === null || max === undefined || block.position === undefined || placed.has(block)) return block;
      placed.add(block);
      block.shapes = placeShapes(block.shapes, max, block.position.x, block.position.z);
      return block;
    };
  };

  let current = bot.world;
  wrap(current);
  Object.defineProperty(bot, "world", {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (next: World) => {
      current = next;
      wrap(next);
    },
  });

  return () => {
    for (const [world, { own }] of wrapped) {
      if (own === undefined) delete (world as Partial<World>).getBlock;
      else Object.defineProperty(world, "getBlock", own);
    }
    wrapped.clear();
    Object.defineProperty(bot, "world", { configurable: true, enumerable: true, writable: true, value: current });
  };
}
