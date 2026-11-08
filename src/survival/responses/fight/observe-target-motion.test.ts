import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { TargetMotion } from "../../weapons/target-motion.js";
import type { CoverFight } from "./cover.js";
import type { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import { observeFight } from "./observe.js";
import { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/**
 * The fight's physics-tick observer over a stub scene (as in melee-turn.test.ts: only what the tick reads is stubbed),
 * with the scene's own `countTick`: a skeleton walking 0.2 b/tick must show up as the target's velocity.
 */
test("each physics tick of a fight records where its target stands, so the bow leads a walking skeleton", () => {
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), entities: { 8: { name: "skeleton", position: new Vec3(12.5, 64, 0.5) } } });
  const target = bot.entities[8]!;
  const scene = {
    bot, target, elapsedTicks: 0, targetMotion: new TargetMotion(), countTick: FightScene.prototype.countTick,
    navigation: { onEvent: () => () => {} },
    tactics: { observe: () => {} }, observeBoundary: () => {},
    execution: { tick: () => {}, progress: { milestone: () => {}, observe: () => null } },
    position: { plan: null }, reportProgress: () => {},
  } as unknown as FightScene;
  const weapons = { observeVolley: () => {}, aimGuardBeforeMovement: () => {} } as unknown as FightWeapons;
  const locomotion = { observeFooting: () => {}, footing: { release: () => {} } } as unknown as FightMovement;
  const observation = observeFight(scene, weapons, locomotion, {} as CoverFight, {} as EndermanFight);
  for (let tick = 0; tick < 6; tick++) {
    bot.emit("physicsTick");
    target.position = target.position.offset(0, 0, 0.2);
  }
  observation.stopEffects();
  observation.close();
  assert.equal(scene.elapsedTicks, 6);
  assert.ok(Math.abs(scene.targetMotion.velocity(8).z - 0.2) < 1e-9);
});
