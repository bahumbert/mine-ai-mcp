// Casting admission through the shared fake's Prismarine ray and real block shapes.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { castOntoPool, type CastPhysics } from "./cast-obsidian.js";
import { standsOnBlock } from "./target-safety.js";

test("a buried pool's sole edge-support lid stays intact, then a supported bank can expose and pour", async () => {
  const lid = new Vec3(1, 64, 0);
  const source = new Vec3(1, 62, 0);
  const scene = createFakeBot({
    groundY: 61, position: new Vec3(0.85, 65, 0.5), carried: { water_bucket: 1 },
    cells: { "1,64,0": "stone", "1,62,0": "lava", "2,64,0": "stone", "0,63,0": "stone" },
  });
  scene.bot.entity.onGround = true;
  const eye = scene.bot.entity.position.offset(0, 1.62, 0);
  const ray = source.offset(0.5, 0.9, 0.5).minus(eye);
  assert.deepEqual(scene.world.raycast(eye, ray.scaled(1 / ray.norm()), ray.norm())?.position, lid);
  assert.equal(scene.bot.blockAt(source.offset(0, 1, 0))?.name, "air");
  assert.equal(standsOnBlock(scene.bot, lid), true);
  const dug: Vec3[] = [];
  let poured = false;
  const physics: CastPhysics = {
    movements: {} as CastPhysics["movements"],
    breakInPlace: async ({ position, retainSupport }) => {
      assert.equal(retainSupport, true);
      dug.push(new Vec3(position.x, position.y, position.z));
      scene.world.setCell(lid, "air");
      return { status: "broken" };
    },
    useItem: async () => {
      poured = true;
      return { kind: "failed", error: "the use port stops after the admitted pour" };
    },
  };
  assert.equal((await castOntoPool(scene.bot, physics, [source])).kind, "reposition");
  assert.deepEqual(dug, []);
  assert.equal(poured, false);
  assert.equal(scene.bot.blockAt(lid)?.name, "stone");
  scene.bot.entity.position = new Vec3(2.15, 65, 0.5);
  assert.equal(standsOnBlock(scene.bot, lid), false);
  const bankOutcome = await castOntoPool(scene.bot, physics, [source]);
  assert.equal(bankOutcome.kind, "failed", JSON.stringify({ bankOutcome, dug, poured }));
  assert.deepEqual(dug, [lid]);
  assert.equal(poured, true);
  assert.equal(scene.bot.listenerCount("physicsTick"), 0);
});

test("late support refusal while exposing a lid requests repositioning without pouring", async () => {
  const scene = createFakeBot({
    groundY: 61, position: new Vec3(2.15, 65, 0.5), carried: { water_bucket: 1 },
    cells: { "1,64,0": "stone", "1,62,0": "lava", "2,64,0": "stone", "0,63,0": "stone" },
  });
  scene.bot.entity.onGround = true;
  let refused = false;
  const outcome = await castOntoPool(scene.bot, {
    movements: {} as CastPhysics["movements"],
    breakInPlace: async ({ retainSupport }) => {
      assert.equal(retainSupport, true);
      refused = true;
      return { status: "failed", cause: "support", reason: "support changed; approach from a safe bank" };
    },
    useItem: async () => { throw new Error("a refused lid cannot be poured through"); },
  }, [new Vec3(1, 62, 0)]);
  assert.equal(refused, true, "the ray must reach the exposing-break port");
  assert.equal(outcome.kind, "reposition");
  assert.equal(scene.bot.blockAt(new Vec3(1, 64, 0))?.name, "stone");
});
