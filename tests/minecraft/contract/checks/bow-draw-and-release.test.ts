import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { assertLaunchSpeed, bowDrawAndRelease, matchesLaunchSpeed } from "./bow-draw-and-release.ts";
import { runOnFake } from "./run-on-fake.ts";

test("bow-draw-and-release tells a short draw from a shot one in server ticks: servers at 20, 14, 10 and 8 ticks a second pass", async () => {
  for (const ticksPerSecond of [20, 14, 10, 8]) await runOnFake(bowDrawAndRelease, { ticksPerSecond });
});

test("the check rejects a bad spawn or first velocity independently", () => {
  const valid = new Vec3(1.25, 0, 0);
  const invalid = new Vec3(1.62, 0, 0);
  assert.doesNotThrow(() => assertLaunchSpeed({ spawnVelocity: valid, firstVelocity: valid }, 10, "half"));
  assert.throws(() => assertLaunchSpeed({ spawnVelocity: invalid, firstVelocity: valid }, 10, "half"), /spawn velocity/);
  assert.throws(() => assertLaunchSpeed({ spawnVelocity: valid, firstVelocity: invalid }, 10, "half"), /first velocity/);
});

test("bow-draw-and-release holds when the server stalls for 1 s and catches up, in the shot draw", async () => {
  for (const atMs of [200, 700]) await runOnFake(bowDrawAndRelease, {}, undefined, [{ atMs, ms: 1_000 }]);
});

test("launch speed rejects values outside the tick-reading and measurement bounds", () => {
  for (const [ticks, speed, accepted] of [[10, 0.92, true], [10, 0.90, false], [10, 1.60, true], [10, 1.62, false], [20, 3.04, true], [20, 3.06, false]] as const) {
    assert.equal(matchesLaunchSpeed(speed, ticks), accepted, `${ticks} ticks, ${speed}`);
  }
});

test("a stopped server during a draw fails within the stall bound", async () => {
  let stoppedAge = 0;
  let readAge = () => 0;
  await assert.rejects(runOnFake(bowDrawAndRelease, {}, (subject, harness) => {
    harness.clock.after(2_000, () => {
      harness.server.stop();
      stoppedAge = harness.server.gameTime;
    });
    readAge = () => harness.server.gameTime;
    return subject;
  }), /stalled/);
  assert.equal(readAge(), stoppedAge, "server age stays fixed through the stall");
});

test("the shot's inventory wait survives its wall bound while world age advances", async () => {
  for (const ticksPerSecond of [20, 10]) {
    let beganMs = 0;
    let beganAge = 0;
    let endedMs = 0;
    let endedAge = 0;
    await runOnFake(bowDrawAndRelease, { ticksPerSecond }, (subject, harness) => {
      const inventory = subject.bot.inventory;
      const originalCount = inventory.count.bind(inventory);
      let releaseAt = 0;
      subject.bot.once("entitySpawn", () => {
        beganMs = harness.clock.now();
        beganAge = subject.bot.time.age;
        releaseAt = beganMs + ANSWER_WALL_MS + 1_000;
      });
      inventory.count = (...args) => {
        const actual = originalCount(...args);
        if (releaseAt && harness.clock.now() < releaseAt) return actual + 1;
        if (releaseAt && endedMs === 0) {
          endedMs = harness.clock.now();
          endedAge = subject.bot.time.age;
        }
        return actual;
      };
      return subject;
    });
    assert.ok(endedMs - beganMs > ANSWER_WALL_MS, `${ticksPerSecond} tps: ${beganMs} -> ${endedMs} ms`);
    assert.ok(endedAge > beganAge, `${ticksPerSecond} tps: age ${beganAge} -> ${endedAge}`);
  }
});
