// Physical corner-catch proof: native damage, confirmed placements and the footing reflex's incident.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { declaredEntitiesArranged, openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

const physicsSchema = z.object({
  kind: z.literal("physics"),
  footing: z.object({ placement: z.object({ cell: z.object({ x: z.number(), y: z.number(), z: z.number() }), result: z.string() }).nullable() }).nullable(),
});
const outcomeSchema = z.object({
  kind: z.literal("survival_receipt"),
  receipt: z.object({ kind: z.literal("outcome"), source: z.literal("recover_footing"), evidence: z.object({ outcome: z.object({ kind: z.string() }) }) }),
});

/** Read confirmed catching cells and the settled reflex from the same retained incident. */
async function catchingEvidence(file: string) {
  const placements = new Set<string>();
  let landed = false;
  for (const line of (await readFile(file, "utf8")).trim().split("\n")) {
    const record: unknown = JSON.parse(line);
    const physics = physicsSchema.safeParse(record);
    const placement = physics.success ? physics.data.footing?.placement : null;
    if (placement?.result === "placed") placements.add(JSON.stringify(placement.cell));
    const outcome = outcomeSchema.safeParse(record);
    landed ||= outcome.success && outcome.data.receipt.evidence.outcome.kind === "landed";
  }
  return { placements: [...placements], landed };
}

/** A real diagonal impulse carries the body across the scaffold corner above lava. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("The corner scaffold did not settle.");
  await declaredEntitiesArranged(context);
  await using runtime = await openRuntime(context, "footing-corner-catch");
  let impulse = false;
  let lava = false;
  const velocity = (packet: { entityId: number }) => { impulse ||= packet.entityId === bot.entity.id; };
  const tick = () => { lava ||= Reflect.get(bot.entity, "isInLava") === true; };
  bot._client.on("entity_velocity", velocity);
  bot.on("physicsTick", tick);
  try {
    bot.deactivateItem();
    bot.chat(`/damage ${bot.username} 1 minecraft:mob_attack by @e[type=cow,sort=nearest,limit=1,distance=..8]`);
    await waitServerTicks(bot, 80, { signal });
    const capture = await runtime.captureIncident();
    if (capture.kind !== "completed" || capture.reference.artifact.kind !== "written")
      throw new Error(`No corner-catch incident: ${JSON.stringify(capture)}`);
    const evidence = await catchingEvidence(capture.reference.artifact.path);
    const exercised = impulse && evidence.placements.length >= 2;
    const detail = { ...evidence, exercised, impulse, lava, grounded: bot.entity.onGround, position: bot.entity.position, incident: capture.reference };
    return { status: exercised && evidence.landed && !lava && bot.health > 0 && bot.entity.onGround ? "succeeded" : "failed", detail: JSON.stringify(detail) };
  } finally {
    bot._client.off("entity_velocity", velocity);
    bot.off("physicsTick", tick);
  }
};
