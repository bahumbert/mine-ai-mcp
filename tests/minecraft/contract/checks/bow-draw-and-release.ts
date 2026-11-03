/**
 * A bow drawn and released (Mine Labs 1.21.4, 2026-10-23, 3 runs): the use sets the hand-in-use bit of the bot's living-entity
 * flags (metadata, bit 0) and the release clears it. A release inside the first 2 ticks (100 ms) is no shot: no arrow, the
 * arrows kept. From 4 ticks (200 ms) the server shoots (the check releases after 1 client tick and after 6 server ticks): one `arrow` entity spawns at the eye (0.1 below), the stack of arrows
 * loses one. (Vanilla's minimum power is 0.1: a draw of 3 ticks; the check tells 2 from 4.)
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, afterClientTicks, answerArrives, serverQuiet } from "../server-answer.ts";
import { holdsWithin } from "../subject.ts";
import { finishWithin, holdInHand, useFlagsOf } from "./combat-scene.ts";
import { READING_TICKS, markNow, restTicksSince } from "./server-tick-marks.ts";

const ARROWS = 16;
/**
 * The short draw is released after one client physics tick (50 ms of a bot on time, a tick or two of a server on time, under the 3 ticks the game
 * shoots from; a slower server counts it fewer). The shot draw and the full draw are paced in server ticks read in chat (`restTicksSince`: at
 * least that many ticks after the use, whatever the wall time): 4 ticks shoot, so the shot draw rests 4 plus the reading's error, the full draw 20.
 */
const SHORT_DRAW_CLIENT_TICKS = 1;
const SHOT_DRAW_TICKS = 4 + READING_TICKS;
const FULL_DRAW_TICKS = 20;
const USING_HAND = 1;
/** An arrow is shot from the eye less 0.1 (y -58.48 for an eye at -58.38 measured). */
const SPAWN_FROM_EYE = { min: 0.05, max: 0.15 } as const;
const EYE_HEIGHT = 1.62;

export const bowDrawAndRelease: ContractCheck = {
  name: "bow-draw-and-release",
  fixture: { cells: {}, carried: { bow: 1, arrow: ARROWS }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  exclusive: "kept on a server of its own until a lane batch shows it green: the draws used to be wall holds of 100 and 200 ms standing for 2 and 4 ticks, which another lane's clone (it stalls the server thread 0.16 to 0.9 s) put out; the shot draw is paced in server ticks since 2026-10-30 (plan 2026-10-30-contract-batch-timing T2a), the short one is a single client tick",
  async run(subject) {
    const { bot } = subject;
    const arrowType = bot.registry.itemsByName.arrow!.id;
    const arrows: { entity: Entity; at: Vec3 }[] = [];
    const onSpawn = (entity: Entity) => {
      if (entity.name === "arrow") arrows.push({ entity, at: entity.position.clone() });
    };
    bot.on("entitySpawn", onSpawn);
    try {
      await holdInHand(subject, "bow");
      await finishWithin(subject, bot.look(0, 0, true), "look");
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "a bot at rest is using her hand");

      bot.activateItem();
      await afterClientTicks(subject, SHORT_DRAW_CLIENT_TICKS, "the short draw");
      bot.deactivateItem();
      await serverQuiet(subject, `after a draw of ${SHORT_DRAW_CLIENT_TICKS} client tick`);
      assert.equal(arrows.length, 0, `a draw of ${SHORT_DRAW_CLIENT_TICKS} client tick shot an arrow`);
      assert.equal(bot.inventory.count(arrowType, null), ARROWS, "a draw too short spent an arrow");
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the release did not clear the hand-in-use bit");

      bot.activateItem();
      await restTicksSince(subject, markNow(subject), SHOT_DRAW_TICKS, "the shot draw");
      bot.deactivateItem();
      await answerArrives(subject, () => arrows.length === 1, `a draw of ${SHOT_DRAW_TICKS} server ticks shot no arrow`);
      assert.ok(await holdsWithin(subject, () => bot.inventory.count(arrowType, null) === ARROWS - 1, ANSWER_WALL_MS), `the shot did not spend an arrow (${bot.inventory.count(arrowType, null)} of ${ARROWS} left)`);

      bot.activateItem();
      await restTicksSince(subject, markNow(subject), FULL_DRAW_TICKS, "the full draw");
      assert.equal(useFlagsOf(bot) & USING_HAND, USING_HAND, "a bow being drawn did not set the hand-in-use bit");
      assert.equal(bot.usingHeldItem, true);
      bot.deactivateItem();
      await answerArrives(subject, () => arrows.length === 2, `a draw of ${FULL_DRAW_TICKS} server ticks shot no arrow`);
      assert.ok(await holdsWithin(subject, () => bot.inventory.count(arrowType, null) === ARROWS - 2, ANSWER_WALL_MS), `the second shot did not spend an arrow (${bot.inventory.count(arrowType, null)} of ${ARROWS} left)`);
      await answerArrives(subject, () => (useFlagsOf(bot) & USING_HAND) === 0, "the shot did not clear the hand-in-use bit");
      assert.equal(bot.usingHeldItem, false);
      const eye = bot.entity.position.offset(0, EYE_HEIGHT, 0);
      for (const { at } of arrows) {
        const below = eye.y - at.y;
        assert.ok(Math.hypot(at.x - eye.x, at.z - eye.z) < 1 && below >= SPAWN_FROM_EYE.min && below <= SPAWN_FROM_EYE.max, `an arrow spawned at ${at}, not ${SPAWN_FROM_EYE.min} to ${SPAWN_FROM_EYE.max} below the eye ${eye}`);
      }
    } finally {
      bot.off("entitySpawn", onSpawn);
    }
  },
};
