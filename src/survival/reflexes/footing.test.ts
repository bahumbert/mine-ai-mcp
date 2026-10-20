import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { handClock } from "../../test-support/hand-clock.js";
import { ReflexDriver } from "../control/driver.js";
import { attachFootingReflex } from "./footing.js";

/** A footing reflex over a recovery that waits for the landing, on a hand clock. */
function fallingScene() {
  const entity = { position: new Vec3(0.5, 200, 0.5), isInWater: false, onGround: false };
  const bot = Object.assign(new EventEmitter(), { health: 20, entity, game: { dimension: "overworld" } }) as unknown as Bot;
  const time = handClock();
  const runner = new ActionRunner({ clock: time.clock, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, { now: time.clock.now });
  const recovery = {
    needed: true,
    recover: (signal: AbortSignal) => new Promise<"landed" | "failed">((resolve) => signal.addEventListener("abort", () => resolve("failed"), { once: true })),
  };
  const reflex = attachFootingReflex(driver, { activeEngagement: () => null }, recovery, () => {});
  /** One 50 ms step: the body falls `drop` blocks, a physics tick, time passes. */
  const step = async (drop: number) => {
    entity.position = entity.position.offset(0, -drop, 0);
    bot.emit("physicsTick");
    await time.advance(50);
  };
  return { entity, runner, step, dispose: async () => { await reflex[Symbol.asyncDispose](); await driver[Symbol.asyncDispose](); } };
}

test("a long fall keeps marking: 20 s in the air is not cut at the 5 s window", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 400; tick++) await scene.step(1);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "falling a block per tick is progress");
  await scene.dispose();
});

test("a body that hangs in the air with no landing is released after 5 s without progress", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "4 s: the window is open");
  for (let tick = 0; tick < 40; tick++) await scene.step(0);
  assert.equal(scene.runner.status().owner, "idle");
  await scene.dispose();
});

test("landing marks, and so does entering water", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  scene.entity.onGround = true;
  await scene.step(0);
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "the landing at 4 s reopened the window");
  scene.entity.isInWater = true;
  await scene.step(0);
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "so did the splash at 8 s");
  await scene.dispose();
});
