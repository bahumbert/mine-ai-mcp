import type { Bot } from "mineflayer";
import { z } from "zod";
import { waitForServerPaced } from "../../src/world/server-paced.ts";
import { monotonicNow } from "../../src/utils/monotonic-clock.ts";

export const recordedLoadoutSchema = z.array(z.tuple([
  z.number().int(), z.string(), z.number().int().positive(), z.number().int().nonnegative(),
]));

// Six first-entry setups at 20/10 tps spanned 0-5 cached age ticks: double the max, rounded to 10, floor 40 (2026-11-18).
const LOADOUT_ACK_TICKS = 40;

/** Restore recorded window slots, counts and durability; untouched slots remain intact. */
export async function restoreRecordedLoadout(bot: Bot, loadout: z.infer<typeof recordedLoadoutSchema>, signal: AbortSignal): Promise<void> {
  const slotName = (slot: number) => {
    const worn: Record<number, string> = { 5: "armor.head", 6: "armor.chest", 7: "armor.legs", 8: "armor.feet", 45: "weapon.offhand" };
    if (worn[slot]) return worn[slot];
    if (slot >= 9 && slot <= 35) return `inventory.${slot - 9}`;
    if (slot >= 36 && slot <= 44) return `hotbar.${slot - 36}`;
    throw new Error(`Invalid recorded inventory slot ${slot}`);
  };
  for (const [slot, name, count, damage] of loadout) {
    signal.throwIfAborted();
    bot.chat(`/item replace entity @s ${slotName(slot)} with minecraft:${name}${damage ? `[minecraft:damage=${damage}]` : ""} ${count}`);
  }
  const sentAtAge = bot.time.age, sentAtMs = monotonicNow();
  const end = await waitForServerPaced(bot, LOADOUT_ACK_TICKS, {
    signal,
    until: () => loadout.every(([slot, name, count, damage]) => {
      const item = bot.inventory.slots[slot];
      return item?.name === name && item.count === count && (item.durabilityUsed ?? 0) === damage;
    }),
  });
  console.error("RECORDED_LOADOUT_ACK " + JSON.stringify({
    end, sentAtAge, observedAge: bot.time.age,
    elapsedTicks: sentAtAge == null || bot.time.age == null ? null : bot.time.age - sentAtAge,
    elapsedMs: monotonicNow() - sentAtMs,
  }));
  if (end !== "until") throw new Error(`Recorded inventory slots/counts/durability were not acknowledged (${end})`);
}
