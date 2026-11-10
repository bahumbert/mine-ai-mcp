// The physical driver keeps its seat checks through the fight and cancels before the approach resumes.
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { watchVehicle } from "../../../src/actions/navigate/vehicle-sync.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./hostile-boat.ts";

const scenario = await loadScenario(new URL("../scenarios/boat/hostile-at-sea-seated.yaml", import.meta.url).pathname);

test("the at-sea driver rejects a seat lost before hurt or before the kill", async () => {
  for (const lossAt of ["before hurt", "before kill"]) {
    const world = createFakeBot({ entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
      8: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
    const stop = watchVehicle(world.bot);
    let navigates = 0;
    try {
      const result = await run(scenarioTestContext({ bot: world.bot, scenario,
        call: async (action) => {
          if (action === "navigate" && ++navigates === 1) {
            world.bot.mount(world.bot.entities[7]!);
            await world.clock.advance(100);
            if (lossAt === "before hurt") world.entities.remove(7);
            world.combat.hurtBot(1, 8);
            await world.clock.advance(50);
            world.combat.hurt(8, null, 1);
            if (lossAt === "before kill") world.entities.remove(7);
            world.combat.kill(8);
            await world.clock.advance(50);
          }
          return { action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" };
        },
      }));
      assert.equal(result.status, "failed", lossAt);
    } finally { stop(); }
  }
});

test("the at-sea driver cancels the approach at the kill before it can resume and leave the seat", async () => {
  const world = createFakeBot({ entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
    8: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
  const stop = watchVehicle(world.bot);
  let navigates = 0;
  let cancelled = false;
  try {
    const result = await run(scenarioTestContext({ bot: world.bot, scenario,
      call: async (action) => {
        if (action === "cancel_foreground_action") cancelled = true;
        if (action === "navigate" && ++navigates === 1) {
          world.bot.mount(world.bot.entities[7]!);
          await world.clock.advance(100);
          world.combat.hurtBot(1, 8);
          await world.clock.advance(50);
          world.combat.hurt(8, null, 1);
          world.combat.kill(8);
          // T17e t00044: the first navigate resumed after the kill, before the driver's next sample.
          if (!cancelled) world.entities.remove(7);
        }
        return { action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" };
      },
    }));
    assert.equal(result.status, "succeeded", result.detail ?? "scenario completed without detail");
    assert.equal(navigates, 2, "the next navigate is exercised from the retained seat");
    assert.equal(world.bot.vehicle?.id, 7);
  } finally { stop(); }
});
