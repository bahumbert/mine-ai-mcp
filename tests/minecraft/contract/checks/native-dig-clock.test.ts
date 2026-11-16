// The real-server native-dig contract also catches the fake's early wall-clock prediction.
import assert from "node:assert/strict";
import test from "node:test";
import type { Block } from "prismarine-block";
import type { Vec3 } from "vec3";
import { digTimeAndUpdate } from "./dig-time-and-update.ts";
import { nativeDigClock } from "./native-dig-clock.ts";
import { runOnFake } from "./run-on-fake.ts";

// Registered bot-contract.test.ts already runs the same native check at 20 tps in two lanes.
for (const ticksPerSecond of [10, 5]) {
  test(`native dig is authoritative at ${ticksPerSecond} tps`, async () => {
    await runOnFake(nativeDigClock, { ticksPerSecond });
  });
}

for (const ticksPerSecond of [20, 10]) {
  test(`native dig contract accepts its exact answer margin and rejects one tick beyond at ${ticksPerSecond} tps`, async () => {
    for (const extraTicks of [22, 23]) {
      const run = runOnFake(nativeDigClock, { ticksPerSecond }, (subject, { bot, clock }) => {
        const original = bot.dig;
        bot.dig = async (block: Block, forceLook: boolean | "ignore" = true, digFace: Vec3 | "auto" | "raycast" = "auto") => {
          await original(block, forceLook, digFace);
          // Deliberately late returns straddle the 20-tick margin plus two-tick read uncertainty.
          await clock.sleep(extraTicks * 1_000 / ticksPerSecond);
        };
        return subject;
      });
      if (extraTicks === 22) assert.match((await run)!, /native dig: 322 server ticks for 300 required/);
      else await assert.rejects(run, /native dig exceeded 322 server ticks: 323/);
    }
  });
}

for (const ticksPerSecond of [20, 10]) {
  test(`dry/wet dig contract rejects excessive completion delay at ${ticksPerSecond} tps`, async () => {
    await runOnFake(digTimeAndUpdate, { ticksPerSecond });
    for (const delayed of [1, 2]) {
      await assert.rejects(runOnFake(digTimeAndUpdate, { ticksPerSecond }, (subject, { bot, clock }) => {
        const original = bot.dig;
        let digs = 0;
        bot.dig = async (block: Block, forceLook: boolean | "ignore" = true, digFace: Vec3 | "auto" | "raycast" = "auto") => {
          await original(block, forceLook, digFace);
          // A deliberately faulty return, not a claimed server answer: 200/100 extra ticks.
          if (++digs === delayed) await clock.sleep(10_000);
        };
        return subject;
      }), /dig exceeded .* server ticks/);
    }
  });
}
