import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import type { PlannedStep } from "../../../src/navigation/movements/movement.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { SWIM_START_TICKS } from "../../../src/navigation/world/swimming.ts";

const paramsSchema = z.object({ legs: z.array(z.tuple([z.number(), z.number(), z.number()])).min(1) });

/** Game ticks the server takes to apply the effect command before the first request. */
const EFFECT_TICKS = 10;


type Stroke = "down" | "horizontal" | "up";
/** One swim step as the plan priced it and the body swam it. */
interface StepSample {
  readonly leg: number; readonly stroke: Stroke; readonly blocks: number; readonly ticks: number; readonly priced: number;
  /** The first and the last step of a leg start or end at rest; the interior ones hand over at speed. */
  readonly interior: boolean;
  /** The next step changes direction: the body settles before it (`turnsInWater`). */
  readonly turns: boolean;
  readonly startedAt: number; readonly endedAt: number;
}
type PlannedStroke = Pick<StepSample, "stroke" | "blocks" | "priced" | "turns"> & { index: number; last: boolean };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? NaN : (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2;
};

/**
 * Ticks a block of horizontal stroke took against its price, over the steps a long swim is made of (not the ones at rest),
 * for the steps that go straight on or turn at their end. Down and up strokes are judged by whole legs: see legTotals.
 */
function perBlock(samples: readonly StepSample[], stroke: Stroke, turns: boolean) {
  const rows = samples.filter((sample) => sample.stroke === stroke && sample.interior && sample.turns === turns);
  const per = rows.map((row) => row.ticks / row.blocks);
  return { n: rows.length, median: median(per), min: Math.min(...per), max: Math.max(...per), priced: median(rows.map((row) => row.priced / row.blocks)) };
}

/**
 * Ticks a leg took from its first stroke to its last (the ticks between steps included), against the sum of its steps' prices
 * and the start from rest. Null for a leg with a step that was not a swim step, or the first leg, which starts from the sink
 * after the spawn (its first stroke took 48 ticks).
 */
function legTotals(samples: readonly StepSample[], leg: number, otherSteps: number) {
  const rows = samples.filter((sample) => sample.leg === leg);
  if (leg === 1 || otherSteps > 0 || rows.length === 0) return null;
  return { leg, steps: rows.length, swum: Math.max(...rows.map((row) => row.endedAt)) - Math.min(...rows.map((row) => row.startedAt)),
    priced: rows.reduce((sum, row) => sum + row.priced, SWIM_START_TICKS) };
}

/** A swim step of a committed plan as the scenario measures it. */
function plannedStroke(steps: readonly PlannedStep[], index: number): PlannedStroke {
  const step = steps[index]!;
  const next = steps[index + 1];
  const dy = step.to.y - step.from.y;
  return { stroke: dy < 0 ? "down" : dy > 0 ? "up" : "horizontal",
    blocks: Math.hypot(step.to.x - step.from.x, step.to.z - step.from.z) + Math.abs(dy), priced: step.cost.expectedTicks, index,
    last: next === undefined,
    turns: next !== undefined && (next.to.x - next.from.x !== step.to.x - step.from.x || next.to.y - next.from.y !== dy ||
      next.to.z - next.from.z !== step.to.z - step.from.z) };
}

export const run: MineAiScenario = async (context) => {
  const { bot, log, signal } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const runtime = await openRuntime(context, context.scenario.name ?? "swim-stroke-ticks");
  let tick = 0;
  let leg = 0;
  let reflexSeen = false;
  const planned = new Map<string, PlannedStroke>();
  const started = new Map<string, number>();
  const samples: StepSample[] = [];
  /** Steps of each leg that were not swim steps (a surface walk, a climb): their legs are not judged as swims. */
  const otherSteps = new Map<number, number>();
  const onTick = () => {
    tick++;
    if (!reflexSeen && runtime.status().survival.owner.current === "breath_reflex") {
      reflexSeen = true;
      log(JSON.stringify({ firstBreathReflex: bot.entity.position, air: airSupplyTicks(bot), leg }));
    }
  };
  const unsubscribe = runtime.navigation.onEvent((event) => {
    if (event.kind === "route_committed")
      event.plan.steps.forEach((step, index, steps) => { if (step.kind === "swim") planned.set(step.id, plannedStroke(steps, index)); });
    if (event.kind === "step_started") started.set(event.stepId, tick);
    if (event.kind === "step_completed") {
      const step = planned.get(event.stepId);
      const from = started.get(event.stepId);
      if (from === undefined) return;
      if (!step) {
        otherSteps.set(leg, (otherSteps.get(leg) ?? 0) + 1);
        return;
      }
      const sample = { leg, stroke: step.stroke, blocks: step.blocks, ticks: tick - from, priced: step.priced, interior: step.index > 0 && !step.last,
        turns: step.turns, startedAt: from, endedAt: tick };
      samples.push(sample);
      log(JSON.stringify({ strokeSample: sample }));
    }
  });
  bot.on("physicsTick", onTick);
  try {
    // The strokes are measured, not the air: water breathing keeps every leg's admission on a full breath, so a long leg is
    // swum whole and the breath reflex never takes the body part-way.
    bot.chat(`/effect give ${bot.username} minecraft:water_breathing infinite 0 true`);
    await bot.waitForTicks(EFFECT_TICKS);
    const action = runtime.actions.find((action) => action.name === "navigate")!;
    for (const [x, y, z] of params.legs) {
      leg++;
      const output = await runtime.run(action, { x, y, z, range: 0.1, dig: false, scaffold: false }, signal);
      log(JSON.stringify(output));
      if (output.result.status !== "succeeded") return { status: "failed", detail: `Leg to ${x},${y},${z} failed: ${JSON.stringify(output)}` };
    }
    const strokes = { straight: perBlock(samples, "horizontal", false), turning: perBlock(samples, "horizontal", true) };
    const legs = params.legs.map((_, index) => legTotals(samples, index + 1, otherSteps.get(index + 1) ?? 0)).filter((total) => total !== null);
    log(JSON.stringify({ strokeSummary: strokes, legs, steps: samples.length, reflexSeen }));
    if (reflexSeen) return { status: "failed", detail: "The breath reflex held the body: the strokes were not swum undisturbed" };
    // The price the planner gives a stroke must cover the stroke swum live: a price below it hands the body to the breath reflex.
    for (const [name, stroke] of Object.entries(strokes))
      if (!(stroke.median <= stroke.priced))
        return { status: "failed", detail: `Swim ${name} (n=${stroke.n}) is priced ${stroke.priced} ticks a block, swum in ${stroke.median} (${stroke.min}..${stroke.max})` };
    const slow = legs.find((total) => total.swum > total.priced);
    if (slow) return { status: "failed", detail: `Leg ${slow.leg} took ${slow.swum} ticks, priced ${slow.priced} (${slow.steps} steps)` };
    return { status: "succeeded", detail: JSON.stringify({ strokes, legs }) };
  } finally {
    bot.off("physicsTick", onTick);
    unsubscribe();
    await runtime.close();
  }
};
