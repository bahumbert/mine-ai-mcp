// Run the installed Mineflayer digging plugin against the shared fake's world and server.
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { FakeHarness } from "./fake-bot.js";

const injectDigging = createRequire(import.meta.url)("mineflayer/lib/plugins/digging.js") as (bot: Bot) => void;

/** The plugin's prediction writes through the same world method as blocks.js; its server answers stay independent. */
export function useNativeDigging({ bot, world }: FakeHarness): void {
  Reflect.set(bot, "_updateBlockState", (position: Vec3, stateId: number) => world.setCell(position, stateId));
  injectDigging(bot);
}
