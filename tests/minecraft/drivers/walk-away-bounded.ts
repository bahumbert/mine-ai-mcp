import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { arenaCell } from "../arena/params.ts";
import type { ArenaFrame } from "../arena/frame.ts";
import type { ScenarioContext } from "../scenario.ts";

const paramsIn = (arena: ArenaFrame) => z.strictObject({
  item_name: z.string().min(1),
  count: z.number().int().positive(),
  /** The path the walk off the toss may add past the bound's 12 blocks: the body still gliding in the tick that crosses it (13.1 measured). */
  max_path_blocks: z.number().positive(),
  /** The most server ticks (world age) the `drop_item` step may take: the walk's 5 s bound (wall time, `walk-bound.ts`) plus the toss, the pickup check and the result, so fewer ticks at 10 tps than at 20 (the measure is in the YAML). */
  max_step_ticks: z.number().int().positive(),
  /** The wall backstop of the same step, past the 5 s walk bound whatever the server rate (a step that outlasts it ran on after the walk's bound); the tick bound alone never fires on a server that crawls. */
  max_step_ms: z.number().int().positive(),
  /** Where the next action walks to: the way back to the start, through whatever the bounded walk left behind. */
  back: arenaCell(arena),
});

/**
 * The walks off a toss are bounded (plan 2026-11-02 Task R): a ground `drop_item` in a pocket whose only way 4 blocks
 * clear of the toss is a long tunnel (live s3l: 106 and 167 blocks underground) walks at most 12 blocks of path and ends
 * within seconds. The goal is on the drop step itself, measured here from the client's ticks; the `navigate` back that
 * follows is the next action the cut walk must leave runnable.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  let path = 0;
  let last = context.bot.entity.position.clone();
  const onTick = () => {
    path += last.distanceTo(context.bot.entity.position);
    last = context.bot.entity.position.clone();
  };
  context.bot.on("physicsTick", onTick);
  const startedAge = context.bot.time.age;
  const startedAt = monotonicNow();
  const dropped = await context.call("drop_item", { items: [{ item_name: params.item_name, count: params.count }], allow_equipped: true });
  const tookMs = Math.round(monotonicNow() - startedAt);
  const tookTicks = context.bot.time.age - startedAge;
  context.bot.off("physicsTick", onTick);
  const measured = `WALK_AWAY path=${path.toFixed(1)} blocks, drop_item took ${tookTicks} server ticks (${tookMs} ms)`;
  if (dropped.result.status !== "succeeded") return { status: "failed", detail: `${measured}; ${dropped.summary}` };
  if (path > params.max_path_blocks) return { status: "failed", detail: `${measured}: walked past ${params.max_path_blocks} blocks` };
  if (tookTicks > params.max_step_ticks) return { status: "failed", detail: `${measured}: took past ${params.max_step_ticks} server ticks` };
  // wall bound: the backstop of the tick bound above, which a server whose world age stands still never reaches
  if (tookMs > params.max_step_ms) return { status: "failed", detail: `${measured}: took past ${params.max_step_ms} ms` };
  const back = await context.call("navigate", { ...params.back, range: 1, dig: false, scaffold: false });
  if (back.result.status !== "succeeded") return { status: "failed", detail: `${measured}; the next action failed: ${back.summary}` };
  return { status: "succeeded", detail: `${measured}; ${back.summary}` };
}
