// Measure the first evade kept and the navigation it interrupted.
import assert from "node:assert/strict";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { z } from "zod";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { waitForWorldAge } from "../../../src/world/world-age.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { observeDeaths } from "./deaths.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { attributeCommand, createMeasureReader } from "../contract/checks/combat-data-measure.ts";

interface FlightEvidence {
  readonly health: number;
  readonly healthAfter: number | undefined;
  readonly floor: { readonly kind: "ok" } | { readonly kind: "below"; readonly index: number; readonly y: number } | { readonly kind: "unknown"; readonly index: number };
  readonly receipts: readonly z.output<typeof receiptSchema>[];
  readonly skipped: readonly { readonly receipt: z.output<typeof receiptSchema>; readonly reason: "footing" }[];
  readonly outcome: string | undefined;
  readonly basis: string | null | undefined;
  readonly distance: number | undefined;
  readonly status: string;
  readonly interruptions: readonly string[];
}

/** Judge the first kept evade and resumed order; baseline diagnostics can omit unavailable basis telemetry. */
export function flightVerdict(evidence: FlightEvidence, bases: readonly string[], maxDistance?: number,
  { requireBasis = true, judge = "order" }: { readonly requireBasis?: boolean; readonly judge?: "order" | "evade" } = {}): boolean {
  return evidence.floor.kind === "ok" && evidence.outcome === "safe_separation" &&
    (!requireBasis || (evidence.basis != null && bases.includes(evidence.basis))) &&
    (maxDistance === undefined || (evidence.distance !== undefined && evidence.distance < maxDistance)) &&
    (judge === "evade" ? (evidence.healthAfter ?? 0) > 0 : evidence.health > 0 &&
      evidence.status === "succeeded" && evidence.interruptions.some((item) => item.includes("[HOSTILE_CONTACT]")));
}

const receiptSchema = z.object({ response: z.string(), outcome: z.string(),
  healthAfter: z.number().optional(), finalPosition: z.unknown().optional(),
  elapsedMs: z.number().optional(), elapsedTicks: z.number().nullable().optional(), goalRefreshes: z.number().optional(),
  finalDistances: z.array(z.object({ id: z.number(), distance: z.number() })).optional(),
  ends: z.array(z.object({ id: z.number(), name: z.string(), basis: z.string().nullable(), distance: z.number() })).optional() });

/** Collect all evade receipts in the order the event cursor supplies them. */
export function flightEvidence(events: readonly unknown[], options: { readonly startY: number; readonly deaths: number;
  readonly health?: number; readonly status: string; readonly interruptions: readonly string[] }): FlightEvidence {
  const eventSchema = z.object({ type: z.literal("survival_outcome"), payload: z.object({ source: z.string(),
    evidence: z.object({ outcome: z.unknown() }) }) });
  const outcomes = events.flatMap((event) => { const parsed = eventSchema.safeParse(event); return parsed.success ? [parsed.data] : []; });
  const evades = outcomes.flatMap((event, index) => {
    const parsed = receiptSchema.safeParse(event.payload.evidence.outcome);
    return event.payload.source === "hostile_reflex" && parsed.success && parsed.data.response === "evade"
      ? [{ receipt: parsed.data, skip: parsed.data.outcome === "cancelled" &&
        outcomes[index + 1]?.payload.source === "recover_footing" }] : [];
  });
  const receipts = evades.map(({ receipt }) => receipt);
  const skipped = evades.filter(({ skip }) => skip).map(({ receipt }) => ({ receipt, reason: "footing" as const }));
  let floor: FlightEvidence["floor"] = { kind: "ok" };
  for (const [index, receipt] of receipts.entries()) {
    const parsed = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).safeParse(receipt.finalPosition);
    if (!parsed.success) { floor = { kind: "unknown", index }; break; }
    const position = parsed.data;
    if (position.y < options.startY - 0.5) { floor = { kind: "below", index, y: position.y }; break; }
  }
  const kept = evades.find(({ skip }) => !skip)?.receipt;
  const end = kept?.ends?.[0];
  return { health: options.deaths ? 0 : (options.health ?? 0), healthAfter: kept?.healthAfter, floor, receipts, skipped,
    outcome: kept?.outcome, basis: end?.basis, distance: end?.distance ?? kept?.finalDistances?.[0]?.distance,
    status: options.status, interruptions: options.interruptions };
}

/** Read every page of the durable event stream, oldest first. */
async function flightEvents(context: ScenarioContext): Promise<unknown[]> {
  const events: unknown[] = [];
  let remaining: number;
  do {
    const page = readRecentEventsResultSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
    assert.equal(page.status, "succeeded");
    events.push(...page.events);
    remaining = page.remainingEventCount;
  } while (remaining > 0);
  return events;
}

/** Verify the server stored zero speed; command feedback is disabled, so use storage and tellraw. */
export async function holdShooter(bot: Bot, mob: string): Promise<void> {
  const selector = `@e[type=minecraft:${mob},limit=1,sort=nearest]`;
  // Two ticks: twice the measured worst of one at 20/10 tps (held-shooter contract, 2026-11-16).
  const reader = createMeasureReader({ bot }, { responseWithinTicks: 2, stallMs: DRIVER_CLOCK_STOPPED_MS });
  reader.send(`attribute ${selector} minecraft:movement_speed base set 0`);
  const [answer] = await reader.read([attributeCommand(selector, "minecraft:movement_speed", "total")]);
  assert.deepEqual(answer, { present: true, raw: 0 }, "shooter movement speed must be zero");
}

/** Set and verify policy before navigation or mob spawn can trigger a reflex. */
async function setFlightPolicy(context: ScenarioContext): Promise<void> {
  const before = await context.call("view_status", {});
  assert.ok(before.survivalPolicy?.revision);
  const result = await context.call("set_survival_policy", { operation: "set", expected_revision: before.survivalPolicy.revision,
    changes: { combat: { hide: "never" } }, lifetime: { kind: "session" }, reason: "Measure flight from a hostile." });
  assert.equal(result.result.status, "succeeded", result.summary);
  const after = await context.call("view_status", {});
  assert.equal(after.survivalPolicy?.effective.combat.hide, "never");
}

/** Start the order first, then summon its pursuer in the lane behind the actor. */
export async function waitForNavigationStart(bot: Bot, start: Vec3, ended: () => boolean): Promise<void> {
  const result = await waitForWorldAge(bot, Infinity, { wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS,
    until: () => bot.entity.position.distanceTo(start) > 0 || ended() });
  assert.equal(result, "until", `navigation start: server clock ${result}`);
  assert.ok(bot.entity.position.distanceTo(start) > 0, "navigation ended before the actor moved");
}

/** Start the order first, then summon its pursuer in the lane behind the actor. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = z.strictObject({ mob: z.enum(["zombie", "skeleton"]), target: arenaPoint(context.arena),
    spawn: arenaPoint(context.arena), bases: z.array(z.string()).min(1), maxDistance: z.number().optional(),
    judge: z.enum(["order", "evade"]).default("order"), holdShooter: z.boolean().default(false) }).parse(context.scenario.params);
  await setFlightPolicy(context);
  assert.equal(context.bot.food, 20, "the actor must start with full food");
  assert.equal(context.bot.health, 7, "the starting wound must be observed");
  const startY = context.bot.entity.position.y;
  const deaths = observeDeaths(context.bot);
  const ages: { age: number; ms: number; health: number; x: number; y: number; z: number }[] = [];
  const onTime = () => {
    const { x, y, z } = context.bot.entity.position;
    ages.push({ age: context.bot.time.age, ms: monotonicNow(), health: context.bot.health, x, y, z });
  };
  context.bot.on("time", onTime);
  try {
    const [x, y, z] = params.target;
    const start = context.bot.entity.position.clone();
    let ended = false;
    const order = context.call("navigate", { x, y, z, range: 2 });
    void order.then(() => { ended = true; }, () => { ended = true; });
    await waitForNavigationStart(context.bot, start, () => ended);
    const equipment = params.mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
    context.bot.chat(`/summon minecraft:${params.mob} ${params.spawn.join(" ")} {PersistenceRequired:1b${equipment}}`);
    if (params.holdShooter) await holdShooter(context.bot, params.mob);
    const result = await order;
    const evidence = flightEvidence(await flightEvents(context), { startY, deaths: deaths.deaths.length, health: context.bot.health,
      status: result.result.status, interruptions: result.interruptions ?? [] });
    const detail = JSON.stringify({ ...evidence, ages, deaths: deaths.deaths.length, summary: result.summary,
      physicalPass: flightVerdict(evidence, params.bases, params.maxDistance, { requireBasis: false, judge: params.judge }) });
    return { status: flightVerdict(evidence, params.bases, params.maxDistance, { judge: params.judge }) ? "succeeded" : "failed", detail };
  } finally { context.bot.off("time", onTime); deaths.dispose(); }
}
