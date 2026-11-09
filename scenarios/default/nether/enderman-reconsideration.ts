import assert from "node:assert/strict";
import { z } from "zod";
import { huntMobResultSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { changesObserved, releaseByTag } from "../../src/arranged-release.ts";
import { declaredEntitiesArranged, declaredStart, openRuntime, standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { settleReconsiderationHunt } from "../../src/reconsideration-settlement.ts";
import { observeReconsideration } from "./reconsideration-observer.ts";

const point = z.tuple([z.number(), z.number(), z.number()]);
const paramsSchema = z.strictObject({
  mode: z.enum(["bypass_near", "teleport_away", "failed_approach"]),
  primary: point,
  alternative: point,
  teleportTo: point.optional(),
  returnTo: point.optional(),
  expectedChanges: z.array(z.tuple([z.enum(["primary", "alternative"]), z.enum(["primary", "alternative"])])).default([]),
});

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
  const alternative = await releaseByTag(context, "reconsider_alternative", "enderman");
  assert.notEqual(primary, alternative, "The two declared Endermen were not independently observed.");

  const runtime = await openRuntime(context, `enderman-reconsideration-${params.mode}`);
  const home = declaredStart(context);
  const child = new AbortController();
  const observer = observeReconsideration(context, runtime, { primary, alternative }, params, child);
  try {
    const action = runtime.actions.find((candidate) => candidate.name === "collect_mob_drop")!;
    const hunt = runtime.run(
      action,
      { mob_name: "enderman", drop_name: "ender_pearl", count: 1, observe_for_ms: 5_000 },
      AbortSignal.any([signal, child.signal]),
    );
    const output = await settleReconsiderationHunt(hunt, child, observer.failure);
    const result = huntMobResultSchema.parse(output.result);
    const observed = changesObserved(result.hunt.targetChanges, params.expectedChanges, { primary, alternative });
    const expectedFirstHit = params.mode === "teleport_away" ? alternative : primary;
    const navigate = runtime.actions.find((candidate) => candidate.name === "navigate")!;
    const nextSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    let rejectNext = () => {};
    const nextTimeout = new Promise<never>((_, reject) => {
      rejectNext = () => reject(nextSignal.reason);
      if (nextSignal.aborted) rejectNext(); else nextSignal.addEventListener("abort", rejectNext, { once: true });
    });
    let next: Awaited<ReturnType<typeof runtime.run>>;
    try { next = await Promise.race([runtime.run(navigate, { x: Math.floor(home.x), y: Math.floor(home.y), z: Math.floor(home.z), range: 1 }, nextSignal), observer.failure, nextTimeout]); }
    finally { nextSignal.removeEventListener("abort", rejectNext); }
    const { firstNativeHit, primaryMoved, primaryReturned, deaths, movePending } = observer.snapshot();
    if (movePending) throw new Error("arranged move not observed");
    const passed = firstNativeHit === expectedFirstHit && observed && (!params.teleportTo || primaryMoved) && (params.mode !== "failed_approach" || primaryReturned) && deaths === 0 && bot.health > 0 && next.result.status === "succeeded";
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
        evidenceFile,
      }),
    };
  } finally {
    observer.close();
    child.abort("scenario ended");
    await runtime.close();
  }
};
