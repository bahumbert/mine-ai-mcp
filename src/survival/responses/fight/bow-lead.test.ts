import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import { aimPoint } from "../../weapons/aim.js";
import { bowTrajectory } from "../../weapons/bow-trajectory.js";
import { TargetMotion } from "../../weapons/target-motion.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";

/** A bot at the origin shooting at a skeleton twelve blocks east over open ground, its motion fed tick by tick. */
function shooter(stepPerTick: number) {
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), entities: { 8: { name: "skeleton", position: new Vec3(12.5, 64, 0.5) } } });
  bot.world.raycast = () => null;
  const target = bot.entities[8]!;
  const targetMotion = new TargetMotion();
  for (let tick = 0; tick < 6; tick++) {
    targetMotion.observe(target, tick);
    target.position = target.position.offset(0, 0, stepPerTick);
  }
  const scene = { bot, target, targetMotion, signal: new AbortController().signal, perception: { read: () => [] } } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const eye = () => bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0).offset(0, -0.1, 0);
  return { bot, target, weapons, eye };
}

test("a bow shot at a target moving 0.2 b/tick leads it", () => {
  const { bot, target, weapons, eye } = shooter(0.2);
  const shot = weapons.clearShot();
  assert.ok(shot, "an open shot is found");
  const aim = aimPoint(bot, target);
  const arrival = shot.points.at(-1)!;
  assert.ok(shot.flightTicks > 1);
  assert.ok(Math.abs(arrival.z - (aim.z + 0.2 * shot.flightTicks)) < 0.05, `arrow ends ${arrival.z - aim.z} ahead of the aim point`);
  assert.ok(Math.abs(arrival.x - aim.x) < 0.05);
  const unled = bowTrajectory(eye(), aim)!;
  assert.ok(shot.velocity.z > unled.velocity.z + 0.1, "the aim is turned toward the way it moves");
});

test("a still target is aimed as today", () => {
  const { bot, target, weapons, eye } = shooter(0);
  const shot = weapons.clearShot();
  const today = bowTrajectory(eye(), aimPoint(bot, target))!;
  assert.ok(shot);
  assert.deepEqual(shot.velocity, today.velocity);
  assert.equal(shot.flightTicks, today.flightTicks);
});
