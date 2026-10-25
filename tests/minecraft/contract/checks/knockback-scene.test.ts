import assert from "node:assert/strict";
import test from "node:test";
import type { LoggedPacket } from "./packet-log.ts";
import { assertDecay, assertFirstPush } from "./knockback-scene.ts";

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

const DECAY_PER_TICK = 0.98;
/** The told velocities of a push along z that decays by 0.98 a tick, one every `gapTicks` ticks, all heard at the same wall time (the wall is not what is judged). */
function decayHeard(gapsInTicks: readonly number[]): LoggedPacket[] {
  const heard = [velocity(0, 0, 0, 0.4), velocity(0, 0, 0, 0.4)];
  let ticks = 0;
  for (const gap of gapsInTicks) {
    ticks += gap;
    heard.push(velocity(0, 0, 0, Math.round(0.4 * DECAY_PER_TICK ** ticks * UNIT) / UNIT));
  }
  return [...heard, velocity(0, 0, 0, 0)];
}

test("a decay told every 3 ticks, or on the 6th when a change was too small, is judged by the 0.98 a tick, whatever the wall time between the packets", () => {
  assert.doesNotThrow(() => assertDecay("by hand", decayHeard([3, 3, 3, 3, 3, 6, 3]), 243));
});

test("a decay that fell 2 ticks between two told velocities, or 4, is refused naming the ticks its ratio says", () => {
  assert.throws(() => assertDecay("by hand", decayHeard([3, 3, 2, 3]), 243), /velocity 5 is 0\.96\d of the one before, 2 ticks of decay: the mob is told every 3 ticks/u);
  assert.throws(() => assertDecay("by hand", decayHeard([3, 4, 3]), 243), /velocity 4 is 0\.92\d of the one before, 4 ticks of decay/u);
});

test("a mob that rested before its push could have decayed, or long after, is refused with the ticks read", () => {
  // 0.4 under 0.003 takes 243 ticks (0.4 * 0.98 ^ 242 = 0.003004): told on the next 3rd tick, read with an error of 2.
  assert.doesNotThrow(() => assertDecay("by hand", decayHeard([3]), 238));
  assert.throws(() => assertDecay("by hand", decayHeard([3]), 100), /by hand: the mob rested 100 server ticks after the hit \(the readings \+-2\), not 238 to 748/u);
  assert.throws(() => assertDecay("by hand", decayHeard([3]), 749), /rested 749 server ticks/u);
});

test("the first velocity after the pair comes 1, 2 or 3 ticks on: the pair is sent in the hit's tick, the tracker's looks fall on every 3rd tick of the server's count", () => {
  // Seen on a real server (lanes, 2026-10-24): 4 of 5 decays had 2 ticks (0.960 of the pair) between the pair and the next velocity, the rest every 3.
  for (const firstGap of [1, 2, 3]) assert.doesNotThrow(() => assertDecay("by hand", decayHeard([firstGap, 3, 3, 3]), 243), `first gap ${firstGap}`);
  assert.throws(() => assertDecay("by hand", decayHeard([4, 3, 3]), 243), /velocity 3 is 0\.92\d of the one before, 4 ticks of decay/u);
});
