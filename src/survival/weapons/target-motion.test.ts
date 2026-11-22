import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { TARGET_MOTION_TICKS, TargetMotion } from "./target-motion.js";

const at = (id: number, x: number, z = 0) => ({ id, position: new Vec3(x, 64, z) });

test("a target seen moving 0.2 blocks per tick reads that velocity, and an earlier burst is forgotten once it stops", () => {
  const motion = new TargetMotion();
  for (let tick = 0; tick < 6; tick++) motion.observe(at(8, tick * 0.2), tick);
  const velocity = motion.velocity(8);
  assert.ok(Math.abs(velocity.x - 0.2) < 1e-9);
  assert.equal(velocity.y, 0);
  assert.equal(velocity.z, 0);
  for (let tick = 6; tick < 6 + TARGET_MOTION_TICKS + 1; tick++) motion.observe(at(8, 1), tick);
  assert.equal(motion.velocity(8).x, 0);
});

test("fewer than two observations, or an unseen target, is a still target", () => {
  const motion = new TargetMotion();
  assert.equal(motion.velocity(8).norm(), 0);
  motion.observe(at(8, 3), 0);
  assert.equal(motion.velocity(8).norm(), 0);
});

test("a target not observed for ticks starts its history again", () => {
  const motion = new TargetMotion();
  motion.observe(at(8, 0), 0);
  motion.observe(at(8, 0.2), 1);
  motion.observe(at(8, 40), 30);
  assert.equal(motion.velocity(8).norm(), 0, "the jump across the gap is not a speed");
  motion.observe(at(8, 40.1), 31);
  assert.ok(Math.abs(motion.velocity(8).x - 0.1) < 1e-9);
});

test("each target keeps its own history across a retarget", () => {
  const motion = new TargetMotion();
  for (let tick = 0; tick < 4; tick++) motion.observe(at(8, tick * 0.2), tick);
  for (let tick = 4; tick < 8; tick++) motion.observe(at(9, 0, -(tick - 4) * 0.3), tick);
  assert.ok(Math.abs(motion.velocity(9).z + 0.3) < 1e-9);
  assert.equal(motion.velocity(9).x, 0);
  assert.equal(motion.velocity(8).norm() > 0, true, "target 8 is not erased by watching 9");
});
