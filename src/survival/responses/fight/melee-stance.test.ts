// Passive quarry and imminent hostile contacts share the real approach stance checks.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { meleeApproachGoal, meleeStanceSafe } from "../../weapons/melee.js";
import { meleeAttackers, meleeStanceKey } from "./melee-stance.js";
import type { FightScene } from "./scene.js";

test("passive quarry and defenders do not reject a lip-side stance; hostile contacts still do", () => {
  for (const { target, defender, imminent, safe, approachSafe } of [
    { target: "cow", defender: "cow", imminent: false, safe: true, approachSafe: true },
    { target: "zombie", defender: "cow", imminent: false, safe: false, approachSafe: false },
    { target: "cow", defender: "zombie", imminent: false, safe: false, approachSafe: true },
    { target: "cow", defender: "cow", imminent: true, safe: false, approachSafe: false },
  ]) {
    const { bot } = createFakeBot({
      position: new Vec3(0.5, 63, 0.5),
      entities: {
        7: { name: target, position: new Vec3(0.5, 63, 2.5) },
        8: { name: defender, position: new Vec3(0.5, 63, 2.5) },
        9: { name: "zombie", position: new Vec3(0.5, 63, 2.5) },
      },
    });
    const world = flatWorld();
    world.load({ x: 0, y: 63, z: -1 }, { stateId: 1 });
    const scene = {
      bot, target: bot.entities[7]!, navigation: { world },
      perception: { read: () => imminent ? [{ id: 9, meleeImminent: true }] : [] },
    } as unknown as FightScene;
    const label = JSON.stringify({ target, defender, imminent });
    assert.equal(meleeStanceSafe(world, bot.entity.position, meleeAttackers(scene, bot.entities[8]!), bot.health), safe, label);
    const goal = meleeApproachGoal(bot, 7, world, () => meleeAttackers(scene)).resolve({
      ...observation(), position: bot.entity.position, stance: "supported",
    });
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") continue;
    assert.equal(goal.isSatisfied({ feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }, world), approachSafe, label);
    const key = meleeStanceKey(scene, bot.entities[8]!);
    bot.entities[8]!.position.z++;
    assert.equal(meleeStanceKey(scene, bot.entities[8]!) === key, defender === "cow", label);
  }
});
