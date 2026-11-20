import { Vec3 } from "vec3";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { confirmArrival, fortressParamsSchema, observeFortress, prepareFortress, releaseThreats } from "./fortress-common.ts";
import { isReturn, requestOf } from "./withdrawal-judge.ts";

/** Acquire a rod and leave alive. The runtime owns combat and continuation. */
export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  const params = fortressParamsSchema.parse(context.scenario.params);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  using _progress = declareProductiveProgress(bot, context.progress, signal);
  await prepareFortress(context);
  const ownDeath = () => died.abort("bot died");
  const runtime = await openRuntime(context, "fortress-rod-and-exit");
  const evidence = observeFortress(context);
  bot.on("death", ownDeath);
  try {
    const release = releaseThreats(context);
    const pending = runtime.run(
      runtime.actions.find((action) => action.name === "collect_mob_drop")!,
      { mob_name: "blaze", drop_name: "blaze_rod", count: 1 },
      signal,
    );
    const [, hunt] = await Promise.all([release, pending]);
    log(`FORTRESS HUNT ${JSON.stringify(hunt)}`);
    if (signal.aborted || evidence.snapshot().rods < 1)
      return { status: "failed", detail: JSON.stringify({ hunt, final: evidence.snapshot() }) };
    const [x, y, z] = params.exit;
    const target = new Vec3(x, y, z);
    const navigate = runtime.actions.find((action) => action.name === "navigate")!;
    const input = { x: Math.floor(x), y, z: Math.floor(z), range: 1 };
    const firstExit = await runtime.run(navigate, input, signal);
    const exit = !signal.aborted && bot.health > 0 && isReturn(requestOf(firstExit))
      ? await runtime.run(navigate, input, signal) : firstExit;
    const arrivedOnServer = exit.result.status === "succeeded" && !signal.aborted && bot.health > 0
      && await confirmArrival({ ...context, signal }, target, 2);
    const final = evidence.snapshot();
    const remaining = bot.entity.position.distanceTo(target);
    return {
      status:
        arrivedOnServer && !signal.aborted && final.deaths === 0 && final.health > 0 && final.rods >= 1 && final.dimension === "the_nether"
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ hunt, firstExit: exit === firstExit ? undefined : firstExit, exit, arrivedOnServer, remaining, final }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: JSON.stringify({ reason: "bot died", final: evidence.snapshot() }) };
  } finally {
    log(`FORTRESS FINAL ${JSON.stringify(evidence.snapshot())}`);
    bot.off("death", ownDeath);
    evidence.close();
    await runtime.close();
  }
};
