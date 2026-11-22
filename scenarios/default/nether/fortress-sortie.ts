/** One native blaze hunt and one return to a surveyed fortress exit. */
import { COLLECT_MOB_DROP, NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import {
  confirmArrival, fortressParamsSchema, navigateWithOneReturn, observeFortress, prepareFortress, releaseThreats,
} from "./fortress-common.ts";
import { observeIdleWindow } from "../../flat/combat/idle-reflex-window.ts";
import { judgeWithdrawal } from "./withdrawal-judge.ts";

export const run: MineAiScenario = async (context) => {
  const params = fortressParamsSchema.parse(context.scenario.params);
  await prepareFortress(context);
  const evidence = observeFortress(context);
  try {
    await releaseThreats(context);
    const runtime = await openRuntime(context, "fortress-sortie-20260906");
    try {
      const hunt = runtime.actions.find((action) => action.name === COLLECT_MOB_DROP);
      const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
      if (!hunt || !navigate) throw new Error("Fortress trial requires the normal hunt and navigate actions.");
      const hunted = await runtime.run(hunt, { mob_name: "blaze", drop_name: "blaze_rod", count: 1 }, context.signal);
      context.log(`HUNT ${JSON.stringify(hunted.result)}`);
      if (evidence.snapshot().deaths > 0) return { status: "failed", detail: JSON.stringify(evidence.snapshot()) };
      const [x, y, z] = params.exit;
      // A death ends the wait for an idle runner, any second navigate and the arrival confirmation; the listener lives until then.
      const died = new AbortController();
      const onDeath = () => died.abort(new Error("Fortress bot died during the return."));
      context.bot.on("death", onDeath);
      let run: Awaited<ReturnType<typeof navigateWithOneReturn>>;
      let arrivedOnServer: boolean | null = null;
      let positionAtWalkEnd = context.bot.entity.position.clone();
      const exit = new Vec3(x + 0.5, y, z + 0.5);
      try {
        run = await navigateWithOneReturn(runtime, context.bot, { x, y, z, range: 1 }, died.signal, context.signal);
        positionAtWalkEnd = context.bot.entity.position.clone();
        // The server's answer decides the arrival, before the window starts.
        if (run.kind === "completed" && run.last.result.status === "succeeded")
          arrivedOnServer = await confirmArrival({ ...context, signal: AbortSignal.any([context.signal, died.signal]) }, exit, 2);
      } finally {
        context.bot.off("death", onDeath);
      }
      if (run.kind !== "completed")
        return { status: "failed", detail: JSON.stringify({ ...evidence.snapshot(), huntStatus: hunted.result.status, returnRun: run.kind, wait: run.wait }) };
      const returned = run.last;
      context.log(`RETURN ${JSON.stringify(returned.result)}`);
      // Five seconds of server ticks keeps the runtime active for delayed fireballs/contact.
      await observeIdleWindow(context.bot, 100, () => evidence.snapshot().deaths > 0, context.signal);
      const final = evidence.snapshot();
      const { atExit, passed } = judgeWithdrawal({
        positionAtWalkEnd, positionAfterWindow: context.bot.entity.position.clone(),
        exit, arrivedOnServer, requests: run.requests, final, returned,
      });
      return {
        status: passed && final.rods >= 1 ? "succeeded" : "failed",
        detail: JSON.stringify({
          ...final,
          atExit,
          huntStatus: hunted.result.status,
          returnStatus: returned.result.status,
          returns: run.returns,
          owners: run.owners,
          interruptions: [...(hunted.interruptions ?? []), ...run.outputs.flatMap((output) => output.interruptions ?? [])],
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
