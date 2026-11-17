// Real impulse and self-hop fixtures for fire-owned landing and walk resumption.
import { z } from "zod";
import type { Vec3 } from "vec3";
import { declaredEntitiesArranged, declaredStart, openRuntime, standStill, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { isInFire } from "../../../src/survival/perception/body.ts";
import { waitForPhysicsTicks } from "../../../src/utils/physics-ticks.ts";

const paramsSchema = z.strictObject({ mode: z.enum(["impulse", "hop"]) });
const outcomeSchema = z.object({ outcome: z.object({
  kind: z.string(),
  footing: z.object({ recovered: z.number() }).optional(),
  airborneTicks: z.number().optional(),
}) });

/** Server commands provide actual fire and knockback, with no client velocity injection. */
function requestFireContact(context: MineAiScenarioContext, mode: "impulse" | "hop", start: Vec3): void {
  const { bot, log } = context;
  const at = start.floored().offset(mode === "impulse" ? 1 : 0, 0, 0);
  bot.deactivateItem();
  if (mode === "impulse") {
    bot.chat(`/setblock ${at.x} ${at.y} ${at.z} fire`);
    log(`Fire requested at ${at}`);
    bot.chat(`/damage ${bot.username} 1 minecraft:mob_attack by @e[type=minecraft:cow,sort=nearest,limit=1,distance=..8]`);
    log("Damage requested");
  } else bot.chat(`/fill ${at.x} ${at.y} ${at.z} ${at.x + 3} ${at.y} ${at.z} fire`);
}

/** Hold the original walk's first departure so the real fire response supplies the flight's controls (a9 T1). */
function startFireLandingWalk(context: MineAiScenarioContext, runtime: Runtime, goal: Vec3, trigger: () => void, triggered: () => boolean) {
  const action = runtime.actions.find(a => a.name === "navigate")!;
  const walk = { ...action, execution: { kind: "resumable_task" as const }, execute: undefined, begin: (...args: Parameters<NonNullable<typeof action.begin>>) => {
    const execute = action.begin!(...args);
    return async (execution: Parameters<typeof execute>[0]) => {
      if (!triggered()) {
        trigger();
        await waitForPhysicsTicks(context.bot, 1_000, execution.signal ?? context.signal);
      }
      return execute(execution);
    };
  } };
  return runtime.run(walk, { x: Math.floor(goal.x), y: goal.y, z: Math.floor(goal.z), range: 0, scaffold: false, dig: false }, context.signal);
}

/** Count persisted outcomes for the complete trial, beyond an incident's bounded tail. */
async function readFireLandingOutcomes(runtime: Runtime, signal: AbortSignal) {
  const read = runtime.actions.find(a => a.name === "read_recent_events")!;
  const fire: z.infer<typeof outcomeSchema>["outcome"][] = [];
  for (;;) {
    const result = readRecentEventsResultSchema.parse((await runtime.run(read, { limit: 100 }, signal)).result);
    for (const event of result.events) {
      if (event.type !== "survival_outcome" || event.payload.source !== "fire_reflex") continue;
      const parsed = outcomeSchema.safeParse(event.payload.evidence);
      if (parsed.success) fire.push(parsed.data.outcome);
    }
    if (result.remainingEventCount === 0) return fire;
  }
}

/** Both fixtures judge the completed walk and persisted fire receipts, never an unexercised survival. */
export const run: MineAiScenario = async context => {
  const { bot, signal, log } = context;
  const { mode } = paramsSchema.parse(context.scenario.params);
  if (!await standStill(context)) throw new Error("Fire landing fixture did not settle");
  if (mode === "impulse") await declaredEntitiesArranged(context);
  const start = declaredStart(context);
  const goal = start.offset(mode === "impulse" ? -10 : 10, 0, 0);
  const runtime = await openRuntime(context, `fire-${mode}-landing`);
  let lava = false;
  let impulse = false;
  let triggered = false;
  const samples: unknown[] = [];
  const messages: string[] = [];
  const message = (text: string) => { messages.push(text); log(`Server: ${text}`); };
  bot.on("messagestr", message);
  const tick = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    samples.push({ age: bot.time.age, position: bot.entity.position.clone(), ground: bot.entity.onGround, owner: runtime.status().activeAction?.action,
      inFire: isInFire(bot) });
  };
  const velocity = (packet: { entityId: number }) => { impulse ||= packet.entityId === bot.entity.id; };
  const trigger = () => {
    triggered = true;
    requestFireContact(context, mode, start);
  };
  bot.on("physicsTick", tick);
  bot._client.on("entity_velocity", velocity);
  try {
    const travel = await startFireLandingWalk(context, runtime, goal, trigger, () => triggered);
    const arrived = travel.result.status === "succeeded" && bot.entity.position.distanceTo(goal) < 2;
    await waitServerTicks(bot, 40, { signal });
    const fire = await readFireLandingOutcomes(runtime, signal);
    const exercised = fire.some(o => mode === "impulse" ? (o.footing?.recovered ?? 0) >= 1
      : (o.airborneTicks ?? 0) >= 1 && o.footing?.recovered === 0);
    const evidenceFile = await writeScenarioEvidence(context, "fire-landing.json", { samples, travel });
    const detail = { arrived, lava, impulse, triggered, exercised, fire, travel: travel.result, position: bot.entity.position, evidenceFile, messages };
    log(JSON.stringify(detail));
    return { status: arrived && !lava && exercised && (mode !== "impulse" || impulse) ? "succeeded" : "failed", detail: JSON.stringify(detail) };
  } finally {
    bot.off("physicsTick", tick);
    bot._client.off("entity_velocity", velocity);
    bot.off("messagestr", message);
    await runtime.close();
  }
};
