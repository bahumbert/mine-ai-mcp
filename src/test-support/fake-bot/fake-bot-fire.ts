// The burn a body's feet cell gives it: lava and fire blocks light it, water puts it out (`fake-bot-burn.ts` counts it).
import type { FakeBurn } from "./fake-bot-burn.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/**
 * Burning ticks owed after the last tick in a contact: lava's 300 and a fire or soul fire block's 175. `fire-block-burn` reads the clear
 * a tick later than the count (lava 301-303 for 300; fire 164-176 for a 40-tick contact, the longest of 5 runs at 20 and at 10 tps,
 * 2026-11-21), so the fake's 175 is read as the 176 of the production estimate.
 */
export const BURN_AFTER_LAVA_TICKS = 300;
export const BURN_AFTER_FIRE_BLOCK_TICKS = 175;
/**
 * A body in a fire block lights only after this many ticks in it: contacts of 0 (the command's round trip), 5 and 10 ticks lit nothing and
 * one of 20 lit it (`fire-block-burn`, 5 runs at 20 tps, 2026-11-21); where between 11 and 20 it starts is not measured, so the fake takes
 * the measured 20. A soul fire block is taken the same (its 40-tick contact lit, shorter ones were not run).
 */
export const FIRE_BLOCK_LIGHTS_AFTER_TICKS = 20;

/** Mirror the source-cell transitions measured by water-extinguishes-burning and the contacts measured by fire-block-burn. */
export function attachFakeFire(bot: FakeBot, server: FakeServer, burn: FakeBurn): void {
  let ticksInFireBlock = 0;
  server.onTick(() => {
    const block = bot.blockAt(bot.entity.position);
    if (!block) return;
    const inFireBlock = block.name === "fire" || block.name === "soul_fire";
    ticksInFireBlock = inFireBlock ? ticksInFireBlock + 1 : 0;
    if (inFireBlock) {
      if (ticksInFireBlock >= FIRE_BLOCK_LIGHTS_AFTER_TICKS) burn.igniteFor(BURN_AFTER_FIRE_BLOCK_TICKS);
      return;
    }
    if (!["lava", "water"].includes(block.name) || Number(block.getProperties().level ?? 0) !== 0) return;
    if (block.name === "lava") burn.igniteFor(BURN_AFTER_LAVA_TICKS);
    else burn.extinguish();
  });
}
