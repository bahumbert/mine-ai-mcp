/**
 * The fake bot's dig as Mineflayer's digging plugin runs it (`digging.js`): the look first, then the start packet,
 * the block's own dig time fed the same inputs, the client turning the cell to air, and `stopDigging`'s two windows.
 */
import type { Bot } from "mineflayer";
import type { FakeBot } from "./fake-bot.js";
import type { Item } from "prismarine-item";
import type { MineflayerBlock } from "../../navigation/mineflayer/world.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import type { FakeClock } from "./fake-clock.js";
import { type FakeWorld, blockUpdateEventOf } from "./fake-world.js";

const noop = () => undefined;

/** `bot.digTime` (`digging.js:232-259`): held item and its enchantments, the helmet's, creative, eye in water, airborne, effects. */
function digTimeOf(bot: FakeBot, block: MineflayerBlock): number {
  const held = bot.heldItem;
  const helmet: Item | null = bot.inventory.slots[bot.getEquipmentDestSlot("head")] ?? null;
  const enchantments = [...(held?.enchants ?? []), ...(helmet?.enchants ?? [])];
  const eyeBlock = bot.blockAt(bot.entity.position.offset(0, eyeHeightOf(bot.entity), 0));
  return block.digTime(
    held?.type ?? null,
    bot.game.gameMode === "creative",
    ["water", "flowing_water"].includes(eyeBlock?.name ?? ""),
    !bot.entity.onGround,
    enchantments,
    bot.entity.effects,
  );
}

/** Give `bot` `dig`, `stopDigging` and `digTime` on `world`, timed by `clock`. */
export function attachFakeDigging(bot: FakeBot, clock: FakeClock, world: FakeWorld): void {
  bot.targetDigBlock = null as never;
  bot.stopDigging = noop;
  bot.digTime = (block) => digTimeOf(bot, block);
  bot.dig = (async (block: MineflayerBlock, forceLook?: boolean | "ignore") => {
    if (block == null) throw new Error("dig was called with an undefined or null block");
    const waitTime = bot.digTime(block);
    if (waitTime === Infinity) throw new Error(`dig time for ${block.name} is Infinity`);
    if (forceLook !== "ignore") await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), forceLook);
    if (bot.targetDigBlock) bot.stopDigging();
    await digOnce(bot, clock, world, block, waitTime);
  }) as Bot["dig"];
  // `digging.js` death handler: the dig's own listeners go, then the dig is stopped.
  bot.on("death", () => {
    bot.removeAllListeners("diggingAborted");
    bot.removeAllListeners("diggingCompleted");
    bot.stopDigging();
  });
}

/** From the start packet to the cell turned to air (`diggingCompleted`) or a `stopDigging` (`Digging aborted`). */
function digOnce(bot: FakeBot, clock: FakeClock, world: FakeWorld, block: MineflayerBlock, waitTime: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const eventName = blockUpdateEventOf(block.position);
    const position = block.position.clone();
    const write = (status: number) => bot._client.write("block_dig", { status, location: position, face: 1 });
    const end = () => {
      bot.removeListener(eventName, onBlockUpdate);
      cancelFinish();
      bot.targetDigBlock = null as never;
      bot.stopDigging = noop;
    };
    const onBlockUpdate = (_before: MineflayerBlock | null, after: MineflayerBlock | null) => {
      if (after?.type !== 0) return; // `digging.js:196`: only air ends the dig
      end();
      bot.emit("diggingCompleted", after);
      resolve();
    };
    const finish = () => {
      write(2);
      bot.targetDigBlock = null as never;
      world.setCell(position, "air"); // the client's own prediction (`_updateBlockState(pos, 0)`)
    };
    write(0);
    const cancelFinish = clock.after(waitTime, finish);
    bot.targetDigBlock = block;
    bot.on(eventName, onBlockUpdate);
    bot.stopDigging = () => {
      if (!bot.targetDigBlock) return;
      write(1);
      end();
      bot.emit("diggingAborted", block);
      reject(new Error("Digging aborted"));
    };
  });
}
