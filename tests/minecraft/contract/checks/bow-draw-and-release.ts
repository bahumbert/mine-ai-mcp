/**
 * A bow drawn and released (Mine Labs 1.21.4, 2026-10-23, 3 runs): the use sets the hand-in-use bit of the bot's living-entity
 * flags (metadata, bit 0) and the release clears it. A release inside the first 2 ticks (100 ms) is no shot: no arrow, the
 * arrows kept. From 4 ticks (200 ms) the server shoots: one `arrow` entity spawns at the eye (0.1 below), the stack of arrows
 * loses one. (Vanilla's minimum power is 0.1: a draw of 3 ticks; the check tells 2 from 4.)
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin } from "../subject.ts";
import { CALL_WALL_MS, finishWithin, holdInHand, useFlagsOf } from "./combat-scene.ts";

const ARROWS = 16;
const SHORT_DRAW_MS = 100;
const SHOT_DRAW_MS = 200;
const FULL_DRAW_MS = 1_000;
/** The flags and the slots reach the client a tick or two after the packet that changed them. */
const SETTLE_MS = 400;
const USING_HAND = 1;
/** An arrow is shot from the eye less 0.1 (y -58.48 for an eye at -58.38 measured). */
const SPAWN_FROM_EYE = { min: 0.05, max: 0.15 } as const;
const EYE_HEIGHT = 1.62;

export const bowDrawAndRelease: ContractCheck = {
  name: "bow-draw-and-release",
  fixture: { cells: {}, carried: { bow: 1, arrow: ARROWS }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
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
      await finishWithin(subject, bot.look(0, 0, true), CALL_WALL_MS, "look");
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "a bot at rest is using her hand");

      bot.activateItem();
      await subject.wait(SHORT_DRAW_MS);
      bot.deactivateItem();
      await subject.wait(SETTLE_MS);
      assert.equal(arrows.length, 0, `a draw of ${SHORT_DRAW_MS} ms shot an arrow`);
      assert.equal(bot.inventory.count(arrowType, null), ARROWS, "a draw too short spent an arrow");
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the release did not clear the hand-in-use bit");

      bot.activateItem();
      await subject.wait(SHOT_DRAW_MS);
      bot.deactivateItem();
      assert.ok(await holdsWithin(subject, () => arrows.length === 1, SETTLE_MS), `a draw of ${SHOT_DRAW_MS} ms shot no arrow`);
      await subject.wait(SETTLE_MS);
      assert.equal(bot.inventory.count(arrowType, null), ARROWS - 1, "the shot did not spend an arrow");

      bot.activateItem();
      await subject.wait(FULL_DRAW_MS);
      assert.equal(useFlagsOf(bot) & USING_HAND, USING_HAND, "a bow being drawn did not set the hand-in-use bit");
      assert.equal(bot.usingHeldItem, true);
      bot.deactivateItem();
      assert.ok(await holdsWithin(subject, () => arrows.length === 2, SETTLE_MS), `a draw of ${FULL_DRAW_MS} ms shot no arrow`);
      await subject.wait(SETTLE_MS);
      assert.equal(bot.inventory.count(arrowType, null), ARROWS - 2);
      assert.equal(useFlagsOf(bot) & USING_HAND, 0, "the shot did not clear the hand-in-use bit");
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
