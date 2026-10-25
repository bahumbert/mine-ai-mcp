/**
 * How far a hit on a mob reaches: the nearest point of its box from the eye, by distance (Mine Labs 1.21.4, 2026-10-23, 3 runs;
 * a zombie 5.25 blocks off was hit in the first probe). Beyond it the server ignores the hit: no packet, no damage.
 * (The boat checks use the same constant, `ENTITY_REACH`; none measured the edge for a boat.)
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, serverQuiet } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { NIGHT, STILL_MOB_NBT, listenToFight, mobAt } from "./combat-scene.ts";

/** The bot's feet x; a zombie's box edge is its centre less 0.3. */
const BOT_X = -5.5;
const HALF_WIDTH = 0.3;
/** The distance from the eye to the box (the eye is level with the zombie's box), and whether the server answers. */
const DISTANCES: readonly { readonly box: number; readonly hurts: boolean }[] = [
  { box: 3.5, hurts: true },
  { box: 4.5, hurts: true },
  { box: 5.4, hurts: true },
  { box: 5.9, hurts: true },
  { box: 6.1, hurts: false },
  { box: 6.6, hurts: false },
];
const centreX = (box: number) => Math.round((BOT_X + box + HALF_WIDTH) * 10) / 10;

export const attackOutOfReach: ContractCheck = {
  name: "attack-out-of-reach",
  fixture: {
    cells: {},
    carried: { iron_sword: 1 },
    position: [BOT_X, -60, 0.5],
    timeOfDay: NIGHT,
    entities: DISTANCES.map(({ box }) => ({ name: "zombie", position: [centreX(box), -60, 0.5] as const, nbt: STILL_MOB_NBT })),
  },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    for (const { box, hurts } of DISTANCES) {
      const mob = await mobAt(subject, "zombie", centreX(box), 0.5);
      const fight = listenToFight(subject, mob);
      try {
        bot.attack(mob);
        // A hit in reach is answered (the mob's hurt); one out of reach is ignored, which only server ticks can show.
        if (hurts) await holdsWithin(subject, () => fight.heard.hurts.length > 0, ANSWER_WALL_MS);
        else await serverQuiet(subject, `after the hit on a zombie ${box} blocks from the eye`);
        assert.equal(fight.heard.hurts.length, hurts ? 1 : 0, `a zombie ${box} blocks from the eye ${hurts ? "was not hit" : "was hit"}`);
      } finally {
        fight.stop();
      }
    }
  },
};
