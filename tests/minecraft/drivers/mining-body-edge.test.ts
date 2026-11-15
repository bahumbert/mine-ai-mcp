// Evidence required from an instrumented mining trial.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { classifyTargetSwings, requireSealedTargetSwing, run } from "./mining-body-edge.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";

test("the driver admits the translated edge and forwards translated action input, restoring observation on failure", async () => {
  for (const [x, z, targetX, targetZ] of [[0, 0, 1, 0], [64, 1536, 65, 1536]]) {
    const { bot } = createFakeBot({ position: new Vec3(x! + 0.85, 63, z! + 0.5), groundY: null,
      cells: { [`${targetX},62,${targetZ}`]: "dirt" } });
    const dig = bot.dig;
    const listeners = bot.listenerCount("physicsTick");
    const asked: unknown[] = [];
    const completion = await run(scenarioTestContext({ bot, arena: arenaFrame({ x: x!, z: z! }),
      scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" }, params: {
        action: "collect_block", input: { x: 1, y: 62, z: 0, block_name: "dirt", count: 1, scaffold: false },
        target: { x: 1, y: 62, z: 0 },
      } }),
      call: async (action, input) => { asked.push({ action, input }); throw new Error("host call rejected"); },
    }));
    assert.deepEqual(asked, [{ action: "collect_block", input: { x: targetX, y: 62, z: targetZ, block_name: "dirt", count: 1, scaffold: false } }]);
    assert.equal(completion.status, "failed");
    assert.match(completion.detail ?? "", /host call rejected/);
    assert.equal(bot.dig, dig);
    assert.equal(bot.listenerCount("physicsTick"), listeners);
  }
});

test("requires a target swing and a recorded path rather than unrelated digs", () => {
  assert.throws(() => classifyTargetSwings([], { x: 1, y: 2, z: 3 }), /target swing/);
  assert.throws(() => classifyTargetSwings([{ target: { x: 2, y: 2, z: 3 }, body: { x: 2.5, y: 3, z: 3.5 }, depends: false, path: [] }], { x: 1, y: 2, z: 3 }), /target swing/);
  assert.throws(() => classifyTargetSwings([{ target: { x: 1, y: 2, z: 3 }, body: { x: 1.5, y: 3, z: 3.5 }, depends: true, path: [] }], { x: 1, y: 2, z: 3 }), /path/);
});

test("rejects unsafe edge swings and classifies centred and bank work", () => {
  const target = { x: 1, y: 2, z: 3 };
  const path = [{ x: 0.85, y: 3, z: 3.5 }];
  assert.throws(() => classifyTargetSwings([{ target, body: path[0]!, depends: true, path }], target), /unsafe target edge swing/);
  assert.deepEqual(classifyTargetSwings([{ target, body: { x: 1.5, y: 3, z: 3.5 }, depends: true, path }], target), ["centred downward"]);
  assert.deepEqual(classifyTargetSwings([{ target, body: { x: 2.5, y: 3, z: 3.5 }, depends: false, path }], target), ["bank"]);
});

test("sealed work requires the lava face to be closed when the target is swung", () => {
  assert.throws(() => requireSealedTargetSwing(["lava"]), /sealed/);
  assert.throws(() => requireSealedTargetSwing([]), /sealed/);
  assert.doesNotThrow(() => requireSealedTargetSwing(["cobblestone"]));
});
