// The physical driver must reject a lost seat even after it observed an earlier mount.
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { watchVehicle } from "../../../src/actions/navigate/vehicle-sync.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./hostile-boat.ts";

const scenario = await loadScenario(new URL("../scenarios/boat/hostile-at-sea-seated.yaml", import.meta.url).pathname);

test("the at-sea driver rejects a mount lost before hurt", async () => {
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
          world.entities.remove(7);
          world.combat.hurtBot(1, 8);
          await world.clock.advance(50);
          world.combat.hurt(8, null, 1);
          world.combat.kill(8);
          await world.clock.advance(50);
        }
        return { action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" };
      },
    }));
    assert.equal(result.status, "failed");
  } finally { stop(); }
});
