/** Reach the surveyed exit alive from a wounded start under native threat. */
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import { observeIdleWindow } from "../../flat/combat/idle-reflex-window.ts";
import { readEncounters, type Encounter } from "../../flat/combat/reflex.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { fortressParamsSchema, observeFortress, prepareFortress, releaseThreats } from "./fortress-common.ts";

export const run: MineAiScenario = async (context) => {
  const params = fortressParamsSchema.parse(context.scenario.params);
  await prepareFortress(context);
  const evidence = observeFortress(context);
  const encounters: Encounter[] = [];
  try {
    const runtime = await openRuntime(context, "fortress-withdrawal-20260906");
    try {
      const policy = runtime.actions.find((action) => action.name === "set_survival_policy");
      if (!policy) throw new Error("Fortress withdrawal requires the survival policy action.");
      const configured = await runtime.run(policy, {
        operation: "set", expected_revision: runtime.status().survivalPolicy.revision,
        changes: { combat: { hide: "never" } }, lifetime: { kind: "session" },
        reason: "Measure withdrawal while regeneration is disabled.",
      }, context.signal);
      assert.equal(configured.result.status, "succeeded", "Withdrawal policy must be installed.");
      assert.equal(runtime.status().survivalPolicy.effective.combat.hide, "never", "Withdrawal must not enter recovery hide.");
      const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
      if (!navigate) throw new Error("Fortress withdrawal requires the normal navigate action.");
      const [x, y, z] = params.exit;
      const release = releaseThreats(context);
      const pending = runtime.run(navigate, { x, y, z, range: 1 }, context.signal);
      const [, returned] = await Promise.all([release, pending]);
      context.log(`RETURN ${JSON.stringify(returned.result)}`);
      // Keep the reflex and native mobs active for delayed contact after arrival.
      const idle = await observeIdleWindow(context.bot, 100, () => evidence.snapshot().deaths > 0, context.signal);
      encounters.push(...(await readEncounters(context, runtime)));
      const final = evidence.snapshot();
      const atExit = context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) <= 2;
      return {
        status:
          final.deaths === 0 && final.health > 0 && final.dimension === "the_nether" && atExit ? "succeeded" : "failed",
        detail: JSON.stringify({
          ...final,
          atExit,
          encounters,
          returnStatus: returned.result.status,
          observedTicks: idle.observedTicks,
          interruptions: returned.interruptions ?? [],
          returnError: "error" in returned.result ? returned.result.error : null,
        }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    context.log(`FINAL ${JSON.stringify(evidence.snapshot())}`);
    evidence.close();
  }
};
