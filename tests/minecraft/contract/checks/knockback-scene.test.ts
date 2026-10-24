import assert from "node:assert/strict";
import test from "node:test";
import type { LoggedPacket } from "./packet-log.ts";
import { assertFirstPush } from "./knockback-scene.ts";

const UNIT = 8_000;
const damageEvent = (atMs: number): LoggedPacket => ({ atMs, name: "damage_event", packet: {} });
const velocity = (atMs: number, x: number, y: number, z: number): LoggedPacket => ({ atMs, name: "entity_velocity", packet: { velocity: { x: x * UNIT, y: y * UNIT, z: z * UNIT } } });
const AWAY_Z = { x: 0, z: 0.4 };

test("a mob with AI that got a velocity of its own in the hit's tick, before the damage_event, is judged by the pair that follows", () => {
  // Seen on a lane (2026-10-24): the walking mob's own velocity 0.5 ms before the damage_event, then the push twice.
  const walking = velocity(99.5, 0.0419, -0.0784, -0.0458);
  assert.doesNotThrow(() => assertFirstPush("ai", damageEvent(100), [walking, velocity(101.4, 0, 0.36075, 0.4), velocity(101.5, 0, 0.36075, 0.4)], AWAY_Z, "any"));
});

test("a mob with AI pushed 0.424 along a direction 0.047 off the expected push is a push (it keeps half of the motion it had)", () => {
  assert.doesNotThrow(() => assertFirstPush("ai", damageEvent(100), [velocity(101, 0.058, 0.36075, 0.42075), velocity(101.1, 0.058, 0.36075, 0.42075)], AWAY_Z, "any"));
});

test("a mob with AI pushed the other way, or with no pair of equal velocities, is refused with the velocities heard", () => {
  assert.throws(() => assertFirstPush("ai", damageEvent(100), [velocity(101, 0, 0.36, -0.4), velocity(101.1, 0, 0.36, -0.4)], AWAY_Z, "any"), /not \{"x":0,"z":0\.4\}/u);
  assert.throws(() => assertFirstPush("ai", damageEvent(100), [velocity(101, 0, 0.36, 0.4), velocity(101.1, 0.1, 0.3, 0.4)], AWAY_Z, "any"), /no two equal velocities.*0\.1/u);
});

test("a push that came 172 ms after the damage_event is a push: a lane's stall holds it back, the order is what is stated", () => {
  const push = (atMs: number) => velocity(atMs, 0, 0, 0.4);
  assert.doesNotThrow(() => assertFirstPush("still", damageEvent(100), [push(272.5), push(272.6)], AWAY_Z, "none"));
  assert.throws(() => assertFirstPush("still", damageEvent(100), [push(99), push(99.1)], AWAY_Z, "none"), /before it/u);
});

test("a mob with no AI is judged by its first two velocities alone, to the unit, with no way up", () => {
  const push = (z: number, y = 0) => [velocity(101, 0, y, z), velocity(101.1, 0, y, z)];
  assert.doesNotThrow(() => assertFirstPush("still", damageEvent(100), push(0.4), AWAY_Z, "none"));
  assert.throws(() => assertFirstPush("still", damageEvent(100), push(0.424), AWAY_Z, "none"), /the push is/u);
  assert.throws(() => assertFirstPush("still", damageEvent(100), push(0.4, 0.36), AWAY_Z, "none"), /pushed up/u);
  assert.throws(() => assertFirstPush("still", damageEvent(100), [velocity(101, 0, 0, 0.4), velocity(101.1, 0, 0, 0.3)], AWAY_Z, "none"), /differs/u);
});
