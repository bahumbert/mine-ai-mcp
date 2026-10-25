import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";

const paramsSchema = z.object({
  legs: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]),
  collect: z.number().optional(), cancel: z.boolean().default(false), reject: z.boolean().default(false),
  replan: z.boolean().default(false), backstop: z.boolean().default(false), breathing: z.boolean().default(false),
  holdDepth: z.boolean().default(false),
  /** Texts the refused request's error must all contain: the refusal under test, never any refusal (2026-10-21). */
  refusal: z.array(z.string()).optional(),
  /** The body must stay above this height: a dive refused or stopped where the air allows never goes deeper. */
  minYAbove: z.number().optional(),
  /**
   * Glass laid over the pond once the body is below `belowY`, lifted again at the breathing report: the way up grows
   * longer than the air left mid-dive (the one way a navigate leg reaches a breathing stop, plan T6), and the resumed leg
   * finds the pond open.
   */
  roof: z.object({ from: z.tuple([z.number(), z.number(), z.number()]), to: z.tuple([z.number(), z.number(), z.number()]),
    belowY: z.number() }).optional(),
}).refine((params) => !(params.reject || params.cancel) || params.refusal !== undefined,
  "A refused or cancelled case names the refusal under test (params.refusal)");

/** Game ticks the breath reflex has to bring a body resting under a closed column back to full air (owner, Q3 2026-10-21). */
const BACKSTOP_TAKEOVER_TICKS = 400;
/** Game ticks after the last request for a body still under water to come back to full air. */
const SETTLE_TICKS = 240;

/** Why a refused request does not prove the refusal under test, or null when it does. */
function refusalMismatch(result: { status: string; error?: string }, refusal: readonly string[] | undefined): string | null {
  if (result.status === "succeeded") return "Unsafe/cancelled request reported success";
  const missing = (refusal ?? []).filter((text) => !(result.error ?? "").includes(text));
  return missing.length === 0 ? null : `The refusal under test was not given: expected ${JSON.stringify(missing)} in ${JSON.stringify(result)}`;
}

type Params = z.infer<typeof paramsSchema>;
type Runtime = Awaited<ReturnType<typeof openRuntime>>;
type Bot = Parameters<MineAiScenario>[0]["bot"];

const sandCarried = (bot: Bot) => bot.inventory.items().filter((item) => item.name === "sand").reduce((n, item) => n + item.count, 0);

/** Runs the collect request; why it does not prove the case, or null when it does. */
async function collectSand(runtime: Runtime, bot: Bot, params: Params, count: number, signal: AbortSignal,
  log: (line: string) => void): Promise<string | null> {
  const action = runtime.actions.find((action) => action.name === "collect_block")!;
  const output = await runtime.run(action, { block_name: "sand", count, scaffold: false }, signal);
  log(JSON.stringify(output));
  const sand = sandCarried(bot);
  if (params.reject) return refusalMismatch(output.result, params.refusal) ??
    (sand > 0 ? `A refused collection still mined ${sand} sand` : null);
  if (output.result.status !== "succeeded") return JSON.stringify(output);
  return sand < count ? "Collection returned without the native inventory gain" : null;
}

/** What the run observed, for the case-specific checks once every request is over. */
interface Observed {
  readonly events: Record<string, number>; readonly reflexSeen: boolean; readonly injected: boolean;
  readonly changedAtDepth: number; readonly maxDepthError: number; readonly minY: number;
  /** Physics ticks counted when the breath reflex first held the body, and when the last request returned. */
  readonly reflexTick: number | null; readonly requestsOverTick: number;
}

/** Why the case-specific behaviour was not proved, or null. */
function caseFailure(params: Params, seen: Observed): string | null {
  if (params.minYAbove !== undefined && seen.minY <= params.minYAbove)
    return `The body went down to ${seen.minY}, below ${params.minYAbove}: the dive was not stopped where the air allows`;
  if (params.breathing && (!seen.events.breathing || !seen.events.resumed || seen.reflexSeen))
    return `Planned breathing was not proved: ${JSON.stringify({ events: seen.events, reflexSeen: seen.reflexSeen })}`;
  if (params.backstop && (!seen.injected || seen.reflexTick === null || seen.reflexTick < seen.requestsOverTick))
    return `Backstop takeover after the dive was not observed: ${JSON.stringify({ injected: seen.injected, reflexTick: seen.reflexTick, requestsOverTick: seen.requestsOverTick })}`;
  if (params.replan && (!seen.injected || !seen.events.world_changed || seen.changedAtDepth > 0))
    return `Depth replan injection=${seen.injected}, world changes=${seen.events.world_changed}, start changes=${seen.changedAtDepth}`;
  if (params.holdDepth && seen.maxDepthError > 0.35) return `Midwater turn left its depth band by ${seen.maxDepthError} blocks`;
  return null;
}

/** Fills the roof's cells with `block` where they hold `replaced`: glass laid over the pond, or lifted again. */
function fillRoof(bot: Bot, roof: NonNullable<Params["roof"]>, block: string, replaced: string): void {
  bot.chat(`/fill ${roof.from.join(" ")} ${roof.to.join(" ")} ${block} replace ${replaced}`);
}

/** Whether the server reports a full breath, or reports none and the eyes are in air. */
const hasFullBreath = (bot: Bot) => airSupplyTicks(bot) === 300 || (airSupplyTicks(bot) === null && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "air");

/** Waits up to `ticks` game ticks for a body still under water, or short of air, to come back to full air. */
async function waitForFullAir(bot: Bot, ticks: number): Promise<void> {
  for (let waited = 0; waited < ticks && ((airSupplyTicks(bot) ?? 300) < 300 ||
    bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === "water"); waited++) await bot.waitForTicks(1);
}

export const run: MineAiScenario = async (context) => {
  const { bot, log, signal } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const runtime = await openRuntime(context, context.scenario.name ?? "underwater");
  const cancel = new AbortController();
  const events: Record<string, number> = {};
  let tick = 0;
  let minAir = 300;
  let minY = bot.entity.position.y;
  let injected = false;
  let reflexSeen = false;
  let reflexTick: number | null = null;
  let changedAtDepth = 0;
  let heldDepth: number | null = null;
  let maxDepthError = 0;
  let obstruction: { x: number; y: number; z: number } | null = null;
  const observe = () => {
    minAir = Math.min(minAir, airSupplyTicks(bot) ?? 300);
    minY = Math.min(minY, bot.entity.position.y);
    if (heldDepth !== null) maxDepthError = Math.max(maxDepthError, Math.abs(bot.entity.position.y - heldDepth));
    if (!reflexSeen && runtime.status().survival.owner.current === "breath_reflex") {
      reflexSeen = true;
      reflexTick = tick;
      log(JSON.stringify({ firstBreathReflex: bot.entity.position, air: airSupplyTicks(bot), events }));
    }
    if (!injected && bot.entity.position.y < -58.5 && (params.replan || params.backstop)) {
      const at = params.backstop ? bot.entity.position.floored().offset(0, 3, 0) : obstruction;
      if (at) {
        injected = true;
        bot.chat(`/setblock ${at.x} ${at.y} ${at.z} glass`);
        log(JSON.stringify({ injectedObstacle: at }));
      }
    }
    if (!injected && params.roof && bot.entity.position.y < params.roof.belowY) {
      injected = true; fillRoof(bot, params.roof, "glass", "air");
      log(JSON.stringify({ injectedRoof: params.roof, position: bot.entity.position, air: airSupplyTicks(bot) }));
    }
    if (params.cancel && bot.entity.position.y < -58.5) cancel.abort("Scenario cancellation at depth");
    if (++tick % 40 === 0) log(JSON.stringify({ position: bot.entity.position, air: airSupplyTicks(bot), sand: sandCarried(bot), events }));
  };
  const unsubscribe = runtime.navigation.onEvent((event) => {
    if (event.kind === "run_settled") log(JSON.stringify(event));
    events[event.kind] = (events[event.kind] ?? 0) + 1;
    if (event.kind === "dive") events[event.state] = (events[event.state] ?? 0) + 1;
    if (event.kind === "dive" && event.state === "breathing" && params.roof && events.breathing === 1) fillRoof(bot, params.roof, "air", "glass");
    if (event.kind === "search_started" && injected && event.reason === "start_changed") changedAtDepth++;
    if (event.kind === "route_committed" && params.replan && !injected)
      obstruction = event.plan.steps.find(({ from, to }) => to.y <= -59 && (to.x !== from.x || to.z !== from.z))?.to ?? null;
    if (event.kind === "search_started") events[event.reason] = (events[event.reason] ?? 0) + 1;
  });
  bot.on("physicsTick", observe);
  try {
    const collected = params.collect === undefined ? null : await collectSand(runtime, bot, params, params.collect, signal, log);
    if (collected) return { status: "failed", detail: collected };
    for (const [x, y, z] of params.legs) {
      heldDepth = params.holdDepth && bot.entity.position.floored().y === y ? y + 0.2 : null;
      const action = runtime.actions.find((action) => action.name === "navigate")!;
      const output = await runtime.run(action, { x, y, z, range: 0.1, dig: false, scaffold: false }, AbortSignal.any([signal, cancel.signal]));
      log(JSON.stringify(output));
      if (params.reject || params.cancel) {
        const mismatch = refusalMismatch(output.result, params.refusal);
        if (mismatch) return { status: "failed", detail: mismatch };
      } else if (output.result.status !== "succeeded" || bot.entity.position.floored().x !== x ||
        bot.entity.position.floored().y !== y || bot.entity.position.floored().z !== z)
        return { status: "failed", detail: `Arrival at ${x},${y},${z} failed: ${JSON.stringify(output)}` };
      heldDepth = null;
    }
    const requestsOverTick = tick;
    // Keep the real runtime alive to observe the action-to-idle survival handoff.
    // The backstop's body rests under a closed column: the breath reflex has a longer bound to take it to air.
    await waitForFullAir(bot, params.backstop ? BACKSTOP_TAKEOVER_TICKS : SETTLE_TICKS);
    const failure = caseFailure(params, { events, reflexSeen, injected, changedAtDepth, maxDepthError, minY, reflexTick, requestsOverTick });
    if (failure) return { status: "failed", detail: failure };
    return { status: bot.health === 20 && hasFullBreath(bot) ? "succeeded" : "failed",
      detail: JSON.stringify({ minY, minAir, health: bot.health, air: airSupplyTicks(bot), events, reflexSeen, injected, changedAtDepth, maxDepthError }) };
  } finally {
    bot.off("physicsTick", observe);
    unsubscribe();
    await runtime.close();
  }
};
