// Real automatic combat choices, their settled receipts, and work after an evade.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ClientCompletion } from "mine-labs/client";
import type { Entity } from "prismarine-entity";
import { z } from "zod";
import { SERVER_ANSWER_TICKS } from "../../../src/world/world-age.ts";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { arenaActionInput } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import { serverContractSubject } from "../contract/subject.ts";
import type { ScenarioContext } from "../scenario.ts";
import { observeDeaths } from "./deaths.ts";
import { waitServerTicks } from "./server-ticks.ts";

const paramsSchema = z.strictObject({
  mob: z.enum(["zombie", "creeper"]),
  response: z.enum(["fight", "evade"]),
  reason: z.enum(["outmatched", "explosive"]).optional(),
  observeSeconds: z.number().positive(),
  bagItem: z.string().optional(),
  nextAction: z.strictObject({
    action: z.string(), input: z.record(z.string(), z.unknown()),
    logMin: z.tuple([z.number(), z.number(), z.number()]),
    logMax: z.tuple([z.number(), z.number(), z.number()]),
  }).optional(),
});
// Empty equipment prevents finalizeSpawn from randomly changing the measured encounter (P4-06a T6).
const EMPTY_MOB = "{PersistenceRequired:1b,IsBaby:0b,HandItems:[{},{}],ArmorItems:[{},{},{},{}]}";

/** Spawn only after listeners and the runtime are ready, so preparation cannot spend the fuse or lose a death. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params);
  const { bot } = context;
  const deaths = observeDeaths(bot);
  const killed = new Set<number>();
  let targetId: number | null = null;
  const onDead = (entity: Entity) => { if (entity.id === targetId) killed.add(entity.id); };
  bot.on("entityDead", onDead);
  try {
    if (params.bagItem) await putStartingItemInBag(context, params.bagItem, sleep);
    bot.chat(`/execute at @s run summon minecraft:${params.mob} ~3 ~ ~ ${EMPTY_MOB}`);
    const seen = await waitServerTicks(bot, SERVER_ANSWER_TICKS, {
      until: () => (targetId = Object.values(bot.entities).find(entity => entity.name === params.mob)?.id ?? null) !== null,
      sleep,
    });
    assert.notEqual(seen, "stalled", "the server's clock stood still while waiting for the summoned contact");
    assert.notEqual(targetId, null, "the summoned contact was never seen");
    // Encounters need the same game time at every rate, plus a packet of margin for a stale age (scenario-ticks P5, 2026-11-15).
    const observed = await waitServerTicks(bot, params.observeSeconds * 20, {
      until: () => deaths.deaths.length > 0, sleep,
    });
    assert.equal(deaths.deaths.length, 0, "the actor died during the encounter");
    assert.notEqual(observed, "stalled", "the server's clock stood still during the encounter");
    assert.ok(bot.health > 0, "the actor is not alive");
    const receipts = await encounterReceipts(context);
    const matching = receipts.filter(outcome => outcome.response === params.response &&
      outcome.threats.some(threat => threat.id === targetId) &&
      outcome.outcome === (params.response === "fight" ? "target_died" : "safe_separation") &&
      (params.reason === undefined || outcome.reason === params.reason));
    assert.ok(matching.length > 0, `missing ${params.response} ${params.reason ?? ""} outcome: ${JSON.stringify(receipts)}`);
    if (params.response === "fight") assert.ok(killed.has(targetId!), "zombie never died on the client");
    if (params.nextAction) await collectAfterEvade(context, params.nextAction);
    assert.equal(deaths.deaths.length, 0, "the actor died during the next action");
    return { status: "succeeded", detail: JSON.stringify({ response: params.response, reason: params.reason,
      outcomes: matching, zombieDied: killed.has(targetId!), health: bot.health, nextAction: params.nextAction?.action }) };
  } finally {
    bot.off("entityDead", onDead);
    deaths.dispose();
  }
}

/** Mine Labs grants into the selected hotbar slot; move that grant into the bag before any hostile exists. */
async function putStartingItemInBag(context: ScenarioContext, item: string, sleep: (ms: number) => Promise<void>): Promise<void> {
  const { bot } = context;
  assert.equal(bot.heldItem?.name, item, "the declared inventory grant was not held");
  bot.chat("/item replace entity @s inventory.0 from entity @s weapon.mainhand");
  bot.chat("/item replace entity @s weapon.mainhand with minecraft:air");
  const moved = await waitServerTicks(bot, SERVER_ANSWER_TICKS, {
    until: () => bot.heldItem === null && bot.inventory.slots[9]?.name === item,
    sleep,
  });
  assert.notEqual(moved, "stalled", "the server's clock stood still while moving the starting weapon into the bag");
  assert.equal(bot.heldItem, null, "the starting hand was not emptied");
  assert.equal(bot.inventory.slots[9]?.name, item, "the starting weapon was not in the bag");
}

/** Read the real settled event stream, including pages filled by setup chat, without depending on a transient poll. */
async function encounterReceipts(context: ScenarioContext) {
  const schema = z.object({ response: z.string(), reason: z.string(), outcome: z.string(),
    threats: z.array(z.object({ id: z.number() })) });
  const events: z.output<typeof schema>[] = [];
  let remaining: number;
  do {
    const page = readRecentEventsResultSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
    assert.equal(page.status, "succeeded");
    for (const event of page.events) {
      if (event.type !== "survival_outcome" || event.payload.source !== "hostile_reflex") continue;
      const envelope = z.object({ outcome: schema }).safeParse(event.payload.evidence);
      if (envelope.success) events.push(envelope.data.outcome);
    }
    remaining = page.remainingEventCount;
  } while (remaining > 0);
  return events;
}

/** Place a log beside the actual evade endpoint and collect it while the original zombie remains alive. */
async function collectAfterEvade(context: ScenarioContext, next: NonNullable<z.output<typeof paramsSchema>["nextAction"]>): Promise<void> {
  const { bot } = context;
  const cell = bot.entity.position.floored().offset(2, 0, 0);
  const min = arenaPoint(context.arena).parse(next.logMin);
  const max = arenaPoint(context.arena).parse(next.logMax);
  assert.ok(cell.x >= min[0] && cell.x <= max[0] && cell.y >= min[1] && cell.y <= max[1] && cell.z >= min[2] && cell.z <= max[2],
    `next-action log ${cell} is outside the declared restoration bounds`);
  assert.equal(bot.blockAt(cell)?.name, "air", "the next-action fixture must not replace an existing block");
  const subject = serverContractSubject(bot, context.arena);
  try {
    await subject.setBlock(cell, "oak_log");
    const output = await context.call(next.action, arenaActionInput(next.input, context.arena));
    assert.equal(output.result.status, "succeeded", output.summary);
  } finally {
    if (bot.blockAt(cell)?.name === "oak_log") await subject.setBlock(cell, "air");
  }
}
