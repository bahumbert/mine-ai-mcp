import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** A skeleton six blocks away on flat ground: outside sword reach, inside a clear bow line. */
function fixture(bow: boolean) {
  const { bot } = createFakeBot({
    position: { x: 0.5, y: 63, z: 0.5 },
    entities: { 7: { name: "skeleton", position: new Vec3(4.5, 63, 4.5), metadata: [] } },
    carried: { diamond_sword: 1, bow: 1, arrow: 3 },
  });
  const target = bot.entities[7]!;
  target.setEquipment(0, itemOf(bot.registry, "bow"));
  const world = flatWorld();
  const scene = {
    bot,
    target,
    navigation: { world },
    policy: { combat: { bow, melee: true, shield: true } },
  } as unknown as FightScene;
  const movement = new FightMovement(scene, {} as FightWeapons);
  const goal = movement.approachGoal(true).resolve({ ...observation(), position: bot.entity.position });
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("unreachable");
  const start = { feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" };
  return goal.isSatisfied(start, world);
}

test("a carried bow's firing line satisfies the approach only when the policy permits the bow", () => {
  assert.equal(fixture(true), true, "a permitted bow may answer the skeleton from this firing line");
  // Arrow collection forbids the bow for the whole request. Arriving at once on
  // a firing line the turn may not use left the bot spinning between guard and
  // a zero-length approach six blocks from a skeleton it never reached.
  assert.equal(fixture(false), false, "a forbidden bow's firing line is not an attack position");
});
