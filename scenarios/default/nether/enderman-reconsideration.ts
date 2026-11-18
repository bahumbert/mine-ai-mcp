import assert from "node:assert/strict";
import { z } from "zod";
import { huntMobResultSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { changesObserved, releaseByTag, removeArrangedEntities } from "../../src/arranged-release.ts";
import { declaredEntitiesArranged, declaredStart, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { settleReconsiderationHunt } from "../../src/reconsideration-settlement.ts";
import { hitsPerGameMinute, judgePursuit, observeReconsideration, type NextActionOutcome, type PursuitSnapshot } from "./reconsideration-observer.ts";
import { readReflexOutcomes } from "../../flat/combat/reflex.ts";
import type { Runtime } from "../../src/runtime.ts";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { ServerPacedExpired, serverPacedSignal } from "../../../src/world/server-paced.ts";

const point = z.tuple([z.number(), z.number(), z.number()]);
const paramsSchema = z.strictObject({
  mode: z.enum(["bypass_near", "teleport_away", "failed_approach", "pursuit"]),
  primary: point,
  alternative: point.optional(),
  teleportTo: point.optional(),
  returnTo: point.optional(),
  expectedChanges: z.array(z.tuple([z.enum(["primary", "alternative"]), z.enum(["primary", "alternative"])])).default([]),
  /**
   * Pursuit mode: the window after the first hit, the displacement that counts as moved and followed, the server ticks
   * the next action (navigate home from wherever the pursuit ended) gets, the prepared terrain box, the arranged
   * provocation that moves the Enderman.
   */
  pursuit: z.strictObject({ windowTicks: z.number().int().positive(), minDisplacement: z.number().positive(), returnTicks: z.number().int().positive(), terrain: z.strictObject({ from: point, to: point }), provoke: z.strictObject({ everyTicks: z.number().int().positive(), command: z.string().startsWith("/") }).optional() }).optional(),
}).superRefine((params, issues) => {
  if (params.mode === "pursuit" && !params.pursuit) issues.addIssue({ code: "custom", message: "pursuit mode needs `pursuit`", path: ["pursuit"] });
  if (params.mode !== "pursuit" && !params.alternative) issues.addIssue({ code: "custom", message: "this mode needs `alternative`", path: ["alternative"] });
});

/** Ask production to collect one pearl; the observer's proof or failure (child, failure) ends the hunt. */
async function huntEnderPearl(context: Parameters<MineAiScenario>[0], runtime: Runtime, child: AbortController, failure: Promise<never>) {
  const action = runtime.actions.find((candidate) => candidate.name === "collect_mob_drop")!;
  const hunt = runtime.run(
    action,
    { mob_name: "enderman", drop_name: "ender_pearl", count: 1, observe_for_ms: 5_000 },
    AbortSignal.any([context.signal, child.signal]),
  );
  const output = await settleReconsiderationHunt(hunt, child, failure, context.bot);
  return { output, result: huntMobResultSchema.parse(output.result) };
}

/**
 * The one removal of the arranged threat: it starts when `signal` aborts (the hunt is cancelled) or at the first call of
 * the returned function, whichever is first, and every call awaits that same removal. A fight response holds the body, and
 * the cancelled hunt unsettled, while the arranged Enderman stands; removing it is what lets the hunt settle. A failure
 * reaches the callers that await it; the early start leaves no unhandled rejection.
 */
export function removeOnceOnAbort(signal: AbortSignal, remove: () => Promise<void>): { run(): Promise<void>; settled(): Promise<void> } {
  let removal: Promise<void> | undefined;
  const run = () => (removal ??= remove());
  signal.addEventListener("abort", () => { run().catch(() => {}); }, { once: true });
  // `settled` waits for a removal that started and starts none.
  return { run, settled: () => removal ?? Promise.resolve() };
}

/** Remove the arranged Endermen; the reflex outcomes are logged around the removal. */
async function removeEndermen(context: Parameters<MineAiScenario>[0], runtime: Runtime, primary: number, alternative: number | undefined) {
  const targets = [{ tag: "reconsider_primary", id: primary }, ...(alternative === undefined ? [] : [{ tag: "reconsider_alternative", id: alternative }])];
  try { await removeArrangedEntities(context, targets); }
  catch (error) {
    context.log(`REFLEX ON REMOVAL FAILURE ${JSON.stringify(await readReflexOutcomes(context, runtime).catch(String))}`);
    throw error;
  }
  context.log(`REFLEX AFTER REMOVAL ${JSON.stringify(await readReflexOutcomes(context, runtime))}`);
}

/** The pursuit's measures for the report: hits per game minute, displacements, lowest y and cells off the terrain. */
function pursuitReport(pursuit: PursuitSnapshot | null, samples: "all" | "count") {
  return pursuit && { ...pursuit, hitsPerGameMinute: hitsPerGameMinute(pursuit), samples: samples === "all" ? pursuit.samples : pursuit.samples.length };
}

/** Server ticks the next action gets in the other modes: the old 10 wall seconds, as game time at 20 tps. */
const NEXT_ACTION_TICKS = 200;

/** Check the body can navigate after the arranged threats are gone, within `ticks` server ticks (a stopped clock ends it too). */
async function navigateHome(context: Parameters<MineAiScenario>[0], runtime: Runtime, home: { x: number; y: number; z: number }, failure: Promise<never>, ticks: number) {
  const navigate = runtime.actions.find((candidate) => candidate.name === "navigate")!;
  using budget = serverPacedSignal(context.bot, ticks, { stoppedMs: DRIVER_CLOCK_STOPPED_MS });
  const nextSignal = AbortSignal.any([context.signal, budget.signal]);
  let rejectNext = () => {};
  const nextTimeout = new Promise<never>((_, reject) => {
    rejectNext = () => reject(nextSignal.reason);
    if (nextSignal.aborted) rejectNext(); else nextSignal.addEventListener("abort", rejectNext, { once: true });
  });
  try { return await Promise.race([runtime.run(navigate, { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 }, nextSignal), failure, nextTimeout]); }
  catch (error) {
    context.log(`REFLEX AFTER NEXT ACTION ${JSON.stringify(await readReflexOutcomes(context, runtime).catch(String))}`);
    throw error;
  } finally { nextSignal.removeEventListener("abort", rejectNext); }
}

/**
 * A pursuit ends wherever the bot followed the target, possibly far off the terrain. The pursuit's measures are
 * already frozen; the next action (`navigate` home) runs from there within `ticks` server ticks and ends `home` or in
 * a bounded failure (its own failure, or its budget's end): both pass (spec D17), the rate is a measure. A cancelled
 * trial, or any other error, is not a bounded failure and is thrown.
 */
export async function nextActionFromPursuitEnd(context: Parameters<MineAiScenario>[0], runtime: Runtime, home: { x: number; y: number; z: number }, failure: Promise<never>, ticks: number): Promise<{ outcome: NextActionOutcome; detail: unknown }> {
  try {
    const output = await navigateHome(context, runtime, home, failure, ticks);
    return { outcome: output.result.status === "succeeded" ? "home" : "bounded failure", detail: output };
  } catch (error) {
    if (error instanceof ServerPacedExpired && !context.signal.aborted) return { outcome: "bounded failure", detail: { failed: error.message } };
    throw error;
  }
}

/**
 * Release the trial's observers, progress window, hunt and runtime. Every step runs even when an earlier one throws, and
 * the first error is the one thrown. The pursuit's removal of the arranged Enderman, started by the hunt's cancel (the
 * `child.abort` here starts it too), is awaited before the runtime closes, so it never runs against a closed runtime; its
 * own failure is logged (a trial that failed already carries its error), never thrown over it.
 */
export async function closeTrial(parts: { observer: { close(): void }; progress?: Disposable; child: AbortController; runtime: Runtime; removal: { settled(): Promise<void> }; log(message: string): void }): Promise<void> {
  const errors: unknown[] = [];
  const attempt = (step: () => void) => { try { step(); } catch (error) { errors.push(error); } };
  attempt(() => parts.observer.close());
  attempt(() => parts.progress?.[Symbol.dispose]());
  attempt(() => parts.child.abort("scenario ended"));
  try { await parts.removal.settled(); }
  catch (error) { parts.log(`arranged Endermen removal failed during cleanup: ${error instanceof Error ? error.message : String(error)}`); }
  try { await parts.runtime.close(); } catch (error) { errors.push(error); }
  if (errors.length > 0) throw errors[0];
}

/** The problems of a pursuit trial: the observer's judge over what the observer measured. */
function pursuitProblems(params: z.infer<typeof paramsSchema>, observed: { firstNativeHit: number | null; deaths: number; pursuit: PursuitSnapshot | null; next: NextActionOutcome | null }, health: number): string[] {
  if (!params.pursuit) return [];
  const { pursuit } = observed;
  return judgePursuit({
    firstHit: observed.firstNativeHit !== null,
    ended: pursuit?.ended ?? null,
    targetDisplacement: pursuit?.targetDisplacement ?? 0,
    botDisplacement: pursuit?.botDisplacement ?? 0,
    deaths: observed.deaths,
    health,
    next: observed.next,
  }, params.pursuit.minDisplacement);
}

/**
 * Two server-tagged native Endermen expose selection through native outgoing
 * damage. Scripted teleports only arrange target movement; production owns
 * every route, target decision, provocation and attack.
 */
export const run: MineAiScenario = async (context) => {
  await recordSourceIdentity();
  const { bot, signal } = context;
  const params = paramsSchema.parse(context.scenario.params);
  assert.ok(await standStill(context));
  await wearArmor(context);
  await declaredEntitiesArranged(context);

  const primary = await releaseByTag(context, "reconsider_primary", "enderman");
  const alternative = params.alternative ? await releaseByTag(context, "reconsider_alternative", "enderman") : undefined;
  assert.notEqual(primary, alternative, "The two declared Endermen were not independently observed.");

  const runtime = await openRuntime(context, `enderman-reconsideration-${params.mode}`);
  const home = declaredStart(context);
  const child = new AbortController();
  // A stationary pursuit lands hits and waits for the target: declare them to the still watchdog (T17), only while observing.
  const progress = params.mode === "pursuit" ? declareProductiveProgress(bot, (reason) => context.progress(reason), signal) : undefined;
  const observer = observeReconsideration(context, runtime, { primary, alternative }, params, child, progress);
  // A pursuit's cancelled hunt is held by the fight response until its Enderman is gone, so the removal starts at the cancel;
  // the other modes settle the hunt first and remove afterwards (an empty `any` never aborts).
  const removal = removeOnceOnAbort(params.pursuit ? child.signal : AbortSignal.any([]), () => removeEndermen(context, runtime, primary, alternative));
  try {
    const { output, result } = await huntEnderPearl(context, runtime, child, observer.failure);
    // One Enderman has no alternative to change to: nothing may be expected of the target changes.
    const observed = alternative === undefined ? params.expectedChanges.length === 0 : changesObserved(result.hunt.targetChanges, params.expectedChanges, { primary, alternative });
    const expectedFirstHit = params.mode === "teleport_away" ? alternative : primary;
    // The pursuit is measured before any cleanup: removing the Enderman must not become its endpoint.
    observer.settlePursuit();
    await removal.run();
    const pursuitNext = params.pursuit ? await nextActionFromPursuitEnd(context, runtime, home, observer.failure, params.pursuit.returnTicks) : undefined;
    const homeAction = pursuitNext ? undefined : await navigateHome(context, runtime, home, observer.failure, NEXT_ACTION_TICKS);
    const next = pursuitNext?.detail ?? homeAction;
    const { firstNativeHit, primaryMoved, primaryReturned, deaths, movePending, pursuit } = observer.snapshot();
    if (movePending) throw new Error("arranged move not observed");
    const problems = pursuitProblems(params, { firstNativeHit, deaths, pursuit, next: pursuitNext?.outcome ?? null }, bot.health);
    const passed = params.mode === "pursuit"
      ? problems.length === 0
      : firstNativeHit === expectedFirstHit && observed && (!params.teleportTo || primaryMoved) && (params.mode !== "failed_approach" || primaryReturned) && deaths === 0 && bot.health > 0 && homeAction?.result.status === "succeeded";
    const evidenceFile = await writeScenarioEvidence(context, `${params.mode}.json`, {
      params,
      primaryId: primary,
      alternativeId: alternative,
      expectedFirstHit,
      firstNativeHit,
      primaryMoved,
      primaryReturned,
      result,
      output,
      next,
      deaths,
      pursuit: pursuitReport(pursuit, "all"),
      pursuitProblems: problems,
    });
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        mode: params.mode,
        primaryId: primary,
        alternativeId: alternative,
        expectedFirstHit,
        firstNativeHit,
        primaryMoved,
        primaryReturned,
        expectedChanges: params.expectedChanges,
        changesObserved: observed,
        targetChanges: result.hunt.targetChanges,
        deaths,
        next,
        health: bot.health,
        pursuit: pursuitReport(pursuit, "count"),
        pursuitProblems: problems,
        evidenceFile,
      }),
    };
  } finally {
    await closeTrial({ observer, progress, child, runtime, removal, log: context.log });
  }
};
