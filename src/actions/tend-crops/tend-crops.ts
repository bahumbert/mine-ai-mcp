import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { defineAction, type ActionContext, type RequestExecution } from "../action.js";
import { tendCheckpointSchema } from "../checkpoint-schemas.js";
import { watchForStall, type StallClock } from "../stall-watch.js";
import {
  parseTendCropsRequest,
  TEND_CROPS,
  TEND_CROPS_DESCRIPTION,
  TEND_STALL_MS,
  tendCropsAnnotations,
  tendCropsInputSchema,
  tendCropsOutcomes,
  tendCropsResultSchema,
  type TendCropsRequest,
  type TendCropsResult,
  type TendEvidence,
} from "./contract.js";
import { plotFacts, dropLedger, mineflayerFarmBody } from "./farm-body.js";
import { beginTendPlot, type PlotFacts, type FarmBody, type TendProgress } from "./tend-plot.js";

/**
 * Settle a run: succeeded when no cell was left for a reason that needs the caller (cells still growing, and water,
 * are a farm as it should be), partial when some work was done beside such cells, failed when none was.
 */
export function settleTend(evidence: TendEvidence, stop: string | null, refused: string | null): TendCropsResult {
  if (refused !== null) return { status: "failed", error: refused, tended: evidence };
  const leftReasons = Object.entries(evidence.skipped).filter(([reason]) => reason !== "growing" && reason !== "water");
  const left = leftReasons.reduce((sum, [, cells]) => sum + cells.length, 0);
  const worked = evidence.harvested + evidence.cleared + evidence.tilled + evidence.planted > 0;
  if (stop === null && left === 0) return { status: "succeeded", tended: evidence };
  return { status: worked ? "partial" : "failed", error: stop ?? tendCropsOutcomes.incomplete(left), tended: evidence };
}

/** The stall watch of one attempt: how long nothing may change, and (for a test) how often it looks and by which clock. */
export interface TendStallSettings {
  readonly stallMs: number;
  readonly sampleMs?: number;
  readonly clock?: StallClock;
}

/**
 * Take the request: the plot's counts and baselines are made once here, and the executor it returns runs one attempt
 * each time the runner calls it (again after a reflex): a fresh farm body for the attempt's signal and a fresh stall
 * watch, whose window starts when the attempt does.
 */
export function beginTendCrops(
  bot: Bot,
  request: TendCropsRequest,
  facts: PlotFacts,
  bodyFor: (signal?: AbortSignal) => FarmBody,
  observe: ObserveRequest = () => {},
  stall: TendStallSettings = { stallMs: TEND_STALL_MS },
): RequestExecution<TendCropsResult> {
  const plotState = () => {
    const parts: string[] = [];
    for (let x = request.min.x; x <= request.max.x; x += 1) for (let z = request.min.z; z <= request.max.z; z += 1) {
      parts.push(`${bot.blockAt(new Vec3(x, request.y, z))?.stateId}:${bot.blockAt(new Vec3(x, request.y + 1, z))?.stateId}`);
    }
    return parts.join(",");
  };
  const cells = (request.max.x - request.min.x + 1) * (request.max.z - request.min.z + 1);
  let progress: TendProgress = { phase: "clearing", harvested: 0, cleared: 0, tilled: 0, planted: 0 };
  observe(() => ({
    baseline: { cells },
    checkpoint: { cells, ...progress },
    completion: { kind: "current", observed: false, owes: "Every cell of the plot harvested, tilled and planted, or reported skipped." },
  }));
  const plot = beginTendPlot(request, bodyFor(), facts, (next) => {
    progress = next;
  });
  return async (context) => {
    context.signal?.throwIfAborted();
    const watch = watchForStall({
      work: plotState,
      position: () => bot.entity.position,
      ...stall,
      describe: ({ seconds, walked }) => tendCropsOutcomes.stalled(seconds, walked),
    });
    try {
      const outcome = await plot.attempt(bodyFor(context.signal), watch.reason);
      return settleTend(outcome.evidence, outcome.stop, outcome.refused);
    } finally {
      watch.close();
    }
  };
}

/** Farm the plot with this body, stopping when no cell has changed for the stall window. */
export function tendCrops(
  bot: Bot,
  request: TendCropsRequest,
  body: FarmBody,
  facts: PlotFacts,
  context: ActionContext,
  stallMs = TEND_STALL_MS,
): Promise<TendCropsResult> {
  return beginTendCrops(bot, request, facts, () => body, context.observeProgress, { stallMs })(context);
}

export function formatTendCropsResult(result: TendCropsResult): string {
  const { tended } = result;
  const lines = [
    `- Cells: ${tended.cells}; harvested ${tended.harvested}, cleared ${tended.cleared}, tilled ${tended.tilled}, planted ${tended.planted}`,
    `- Items gained: ${Object.entries(tended.gained).map(([item, count]) => `${item} ${count}`).join(", ") || "none"}`,
    `- After: ${Object.entries(tended.after.crops).map(([crop, count]) => `${count} ${crop}`).join(", ") || "no crops"}; empty farmland ${tended.after.emptyFarmland}, dry farmland ${tended.after.dryFarmland}, water ${tended.after.water}`,
    ...Object.entries(tended.skipped).map(([reason, cells]) => `- Skipped (${reason}): ${cells.map((cell) => `${cell.x},${cell.z}`).join(" ")}`),
    ...(tended.dropsLeft.length === 0 ? [] : [`- Drops left on the ground: ${tended.dropsLeft.join(", ")}`]),
  ];
  return result.status === "succeeded" ? lines.join("\n") : `${lines.join("\n")}\n\n**Observed stop:** ${result.error}`;
}

export function createTendCropsAction(bot: Bot, navigation: NavigationRuntime) {
  return defineAction({
    checkpointSchema: tendCheckpointSchema,
    name: TEND_CROPS,
    description: TEND_CROPS_DESCRIPTION,
    inputSchema: tendCropsInputSchema,
    resultSchema: tendCropsResultSchema,
    formatResult: formatTendCropsResult,
    execution: { kind: "resumable_task", prepare: (signal) => prepareBotForMovement(bot, navigation, signal) },
    annotations: tendCropsAnnotations,
    parse: parseTendCropsRequest,
    begin: (request, _lifetime, observe) => {
      const drops = dropLedger(bot);
      return beginTendCrops(bot, request, plotFacts(bot), (signal) => mineflayerFarmBody(bot, navigation, request, signal, drops), observe);
    },
  });
}
