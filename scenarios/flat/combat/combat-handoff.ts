/** Reach the requested destinations alive through the production survival runtime. */
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { waitForReleaseAnswers } from "../../src/arranged-release.ts";
import { openRuntime, wearArmor, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, excessExplosions, readEncounters, watchExplosions, watchShield } from "./reflex.ts";

const destination = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
const paramsSchema = z.strictObject({
  wearArmor: z.boolean().default(false),
  firstTarget: destination,
  secondTarget: destination.optional(),
  forbidHide: z.boolean().default(false),
  requireEncounter: z.boolean().default(false),
  maxExplosions: z.number().int().nonnegative().optional(),
  releaseAfterOpen: z.boolean().default(false),
});

/** Find a declared mob at its arranged position, excluding already matched entities. */
export function arrangedEntityId(
  entities: readonly { id: number; name?: string; position: Vec3 }[],
  declaration: { type: string; pos: [number, number, number] | string },
  used: ReadonlySet<number>,
): number | undefined {
  if (!Array.isArray(declaration.pos)) return undefined;
  const position = new Vec3(...declaration.pos);
  return entities.find((entity) => entity.name === declaration.type.replace(/^minecraft:/u, "") &&
    !used.has(entity.id) && entity.position.distanceTo(position) <= 1)?.id;
}

/** Release the declared nearby NoAI mobs and wait for each server metadata answer. */
export async function releaseArranged(context: MineAiScenarioContext): Promise<void> {
  const { bot, signal } = context;
  signal.throwIfAborted();
  const pending = new Set<number>();
  const entities = Object.values(bot.entities).filter((entity) => entity.position.distanceTo(bot.entity.position) <= 16);
  for (const declaration of context.scenario.entities) {
    if (Array.isArray(declaration.pos) && new Vec3(...declaration.pos).distanceTo(bot.entity.position) > 16) continue;
    const name = declaration.type.replace(/^minecraft:/u, "");
    const id = arrangedEntityId(entities, declaration, pending);
    const entity = entities.find((candidate) => candidate.id === id);
    if (!entity) throw new Error(`release not answered: declared ${name} not visible`);
    pending.add(entity.id);
    // minecraft-data 1.21.4 entities.json: mob_flags index 15; creeper swell_dir index 16.
    context.log(`release entity ${name} ${entity.id} metadata ${JSON.stringify(entity.metadata)}`);
    const swell: unknown = entity.metadata[16];
    if (name === "creeper" && swell === 1) throw new Error("creeper fusing under NoAI");
  }
  await waitForReleaseAnswers(context, pending, `/execute at ${bot.username} as @e[distance=..16,nbt={NoAI:1b}] run data merge entity @s {NoAI:0b}`);
}

/** Wait for the foreground navigate action to own the body before releasing threats. */
async function waitForNavigate(runtime: Runtime, signal: AbortSignal): Promise<void> {
  const deadline = monotonicNow() + 500;
  while (monotonicNow() < deadline) {
    signal.throwIfAborted();
    const status = runtime.status();
    if (status.owner === "foreground" && status.activeAction?.action === NAVIGATE) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("navigate not started");
}

/** Abort and settle a started navigation if arranging its release fails. */
export async function navigateWithRelease<T>(
  start: (signal: AbortSignal) => Promise<T>,
  release: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const navigation = start(combined);
  const settled = navigation.then(() => {}, () => {});
  try {
    await release(combined);
  } catch (cause) {
    controller.abort(cause);
    await settled;
    throw cause;
  }
  return await navigation;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-navigation");
  const explosions = watchExplosions(context);
  const shield = watchShield(context);
  const died = new AbortController();
  const signal = AbortSignal.any([context.signal, died.signal]);
  const death = () => died.abort("bot died");
  context.bot.on("death", death);
  try {
    if (params.wearArmor) await wearArmor(context);
    if (params.forbidHide) {
      await runtime.run(
        runtime.actions.find((action) => action.name === "set_survival_policy")!,
        {
          operation: "set",
          expected_revision: runtime.status().survivalPolicy.revision,
          changes: { combat: { hide: "never" } },
          lifetime: { kind: "session" },
          reason: "Scenario setup.",
        },
        signal,
      );
    }
    const navigate = runtime.actions.find((action) => action.name === NAVIGATE)!;
    for (const [index, [x, y, zPosition]] of [params.firstTarget, ...(params.secondTarget ? [params.secondTarget] : [])].entries()) {
      const start = (navigationSignal: AbortSignal) => runtime.run(navigate, { x, y, z: zPosition, range: 1 }, navigationSignal);
      const output = index === 0 && params.releaseAfterOpen
        ? await navigateWithRelease(start, async (releaseSignal) => {
          await waitForNavigate(runtime, releaseSignal);
          await releaseArranged({ ...context, signal: releaseSignal });
        }, signal)
        : await start(signal);
      context.log(`NAVIGATION ${JSON.stringify(output)}`);
      if (context.bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zPosition + 0.5)) > 2)
        return { status: "failed", detail: `Did not reach ${x},${y},${zPosition}: ${JSON.stringify(output)}` };
    }
    const encounters = await readEncounters(context, runtime);
    const exploded = excessExplosions(explosions.count(), params.maxExplosions);
    const unexpectedHide = params.forbidHide && encounters.some((encounter) => encounter.response === "hide");
    const missedEncounter = params.requireEncounter && encounters.length === 0;
    return {
      status:
        !died.signal.aborted && context.bot.health > 0 && !exploded && !unexpectedHide && !missedEncounter
          ? "succeeded"
          : "failed",
      detail: `${exploded ?? ""}${unexpectedHide ? "Unexpected hide response; this route must manage the creepers without shelter." : ""}${missedEncounter ? "The route completed without exercising a hostile response." : ""}; ${encounters.map(describe).join(" | ")}; ${shield.summary()}`,
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: "Bot died before completing the route." };
  } finally {
    context.bot.off("death", death);
    shield.close();
    explosions.close();
    await runtime.close();
  }
}
