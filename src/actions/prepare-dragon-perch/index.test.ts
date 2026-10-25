import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { engagingCombat, unexpectedEngage } from "../../test-support/combat.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createPrepareDragonPerchAction } from "./index.js";

test("preparation delegates without attacking and publishes current staging readiness", async (t) => {
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 61, -2.5),
    dimension: "the_end",
    entities: { 17: { name: "ender_dragon", position: new Vec3(0, 70, 0), metadata: [] } },
  });
  let requestKind: string | null = null;
  const runEnd: CombatController["runEnd"] = async (request) => {
    if (request.kind !== "prepare_perch") throw new Error("wrong request");
    requestKind = request.kind;
    request.observation.preparedPosition = bot.entity.position.clone();
    request.observation.stage = "ready";
    return {
      outcome: "perch_ready",
      attacks: 0,
      healthBefore: null,
      healthAfter: null,
      reason: "Low staging position is ready.",
    };
  };
  const action = createPrepareDragonPerchAction(bot, engagingCombat(bot, unexpectedEngage, { runEnd }));
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const evidence: { current?: () => { checkpoint: unknown; completion: { observed: boolean } } } = {};
  const result = await action.begin(action.parse({ entity_id: 17 }), lifetime.signal, (observe) => {
    evidence.current = observe as typeof evidence.current;
  })({});

  assert.equal(requestKind, "prepare_perch");
  assert.equal(result.status, "succeeded");
  assert.equal(result.combat.outcome, "perch_ready");
  assert.equal(result.combat.attacks, 0);
  assert.deepEqual(evidence.current?.().checkpoint, {
    preparedPosition: { x: 0.5, y: 61, z: -2.5 },
    stage: "ready",
    blockedBy: null,
  });
  assert.equal(evidence.current?.().completion.observed, true);
});
