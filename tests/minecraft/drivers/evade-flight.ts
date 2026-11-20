// Measure the first evade kept and the navigation it interrupted.
import assert from "node:assert/strict";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { waitForWorldAge } from "../../../src/world/world-age.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { evadeBudgetTicks } from "../../../src/survival/responses/evade-clock.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { observeDeaths } from "./deaths.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { attributeCommand, createMeasureReader } from "../contract/checks/combat-data-measure.ts";
import { SERVER_ANSWER_TICKS } from "../../../src/world/world-age.ts";
import type { Entity } from "prismarine-entity";
import { navigationFeet } from "../../../src/navigation/world/block-geometry.ts";

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
  /** Server ticks the first kept evade ran (its budget when it ended as capability_limit). */
  readonly elapsedTicks?: number | null;
}

import { createLeeWitness, judgeNavigationEvents, judgeResume, observeResumeFlight, pairResumeReceipts, readResumeObservation, readResumeShooter, readResumeSpeed, resumeLeeCovered } from "./evade-flight-observation.ts";
export { createLeeWitness, judgeNavigationEvents, judgeResume, observeResumeFlight, pairResumeReceipts, readResumeObservation, readResumeProbe, readResumeSpeed, resumeLeeCovered } from "./evade-flight-observation.ts";

/** Wait for predicted movement, then confirm the server has crossed with at most one read outstanding. */
export async function waitResumeTrigger(context: ScenarioContext, threshold: number, anchor: () => number | undefined) {
  const { bot, signal } = context;
  let attempt = 0;
  for (;;) {
    const origin = anchor();
    const remaining = origin === undefined ? 3600 : Math.max(0, origin + 3600 - bot.time.age);
    assert.ok(remaining > 0, "movement trigger exceeded remaining trial ticks");
    const moved = await waitForWorldAge(bot, remaining, { wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS,
      signal, until: () => bot.entity.position.z > threshold });
    assert.equal(moved, "until", `movement trigger: ${moved}`);
    signal?.throwIfAborted();
    const beforeProbe = anchor();
    const probeTicks = beforeProbe === undefined ? SERVER_ANSWER_TICKS : Math.min(SERVER_ANSWER_TICKS, beforeProbe + 3600 - bot.time.age);
    assert.ok(probeTicks > 0, "movement trigger exceeded remaining trial ticks");
    const server = await readResumeObservation(context, "entity @s", `trigger_${++attempt}`, probeTicks);
    signal?.throwIfAborted();
    const afterProbe = anchor();
    assert.ok(afterProbe === undefined || bot.time.age < afterProbe + 3600, "movement trigger exceeded remaining trial ticks");
    if (!server.matched) throw new Error("invalid evidence: actor missing at movement trigger");
    if (server.position.z > threshold) return server;
    const currentOrigin = anchor();
    const left = currentOrigin === undefined ? 3600 : Math.max(0, currentOrigin + 3600 - bot.time.age);
    assert.ok(left > 0, "movement trigger exceeded remaining trial ticks");
    const paced = await waitForWorldAge(bot, Math.min(20, left), { wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS, signal });
    if (paced !== "moved") throw new Error(`movement trigger: ${paced}`);
  }
}

type ResumeParams = { target: [number, number, number]; spawn: [number, number, number];
  wall: [number, number, number]; nextTarget: [number, number, number];
  alternateNextTarget: [number, number, number]; mode: "detour" | "no-cover" };

export async function chooseResumeTarget(next: [number, number, number], alternate: [number, number, number],
  inRange: (point: [number, number, number], id: string) => Promise<boolean>): Promise<[number, number, number]> {
  const chosen = await inRange(next, "next_range") ? alternate : next;
  if (await inRange(chosen, "chosen_range")) throw new Error("follow-up target is already in range");
  return chosen;
}

export function resumeTargetInRange(point: [number, number, number], reading: { position: Vec3; matched: boolean; tick: number }): boolean {
  const cell = navigationFeet(reading.position, true);
  const inCellRange = new Vec3(cell.x, cell.y, cell.z).distanceTo(new Vec3(...point)) <= 1;
  const exact = reading.position.distanceTo(new Vec3(...point)) <= 1;
  if (reading.matched !== exact) throw new Error(`follow-up range mismatch ${JSON.stringify({ point, cell, reading })}`);
  return exact || inCellRange;
}

/** Do not leave observation waiting for an action after trial cancellation or death. */
export async function awaitResumeAction<T>(start: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const promise = start();
  if (!signal) return await promise;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

/** Pair the first qualifying cover receipt with its uninterrupted, server-confirmed lee occupancy. */
function monitorResume(context: ScenarioContext, params: ResumeParams, shooter: () => Entity | undefined, range: number, probeContext: ScenarioContext) {
  const { bot } = context;
  let leeWitness: Promise<boolean> | undefined;
  let primaryClaim: number | null = null;
  let witnessRequest: number | null = null;
  let witnessInLee = false;
  let serverShooter: Entity | undefined;
  let witness: ReturnType<typeof createLeeWitness> | undefined;
  let witnessPending = false;
  let hostileActive = false;
  let exposureLogged = false;
  let primarySampling = true;
  const observation = observeResumeFlight(context, () => shooter()?.id, range, (receipt, sequence) => {
    if (receipt.source === "hostile_reflex" && receipt.kind === "claim") {
      if (witnessPending) { witness?.handoff(); context.log?.(`resume witness handoff ${JSON.stringify({ age: bot.time.age, sequence })}`); }
      hostileActive = true;
      const request = receipt.status.request;
      const target = z.object({ x: z.number(), y: z.number(), z: z.number(), range: z.number() }).safeParse(request?.objective);
      primaryClaim = request?.action === "navigate" && target.success && target.data.x === params.target[0] &&
        target.data.y === params.target[1] && target.data.z === params.target[2] && target.data.range === 1 ? request.requestId : null;
    }
    if (receipt.source === "hostile_reflex" && receipt.kind === "outcome") hostileActive = false;
    if (leeWitness || receipt.source !== "hostile_reflex" || receipt.kind !== "outcome") return;
    const cover = z.object({ response: z.literal("evade"), cancelled: z.literal(false), outcome: z.object({
      outcome: z.literal("safe_separation"), finalPosition: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      ends: z.array(z.object({ id: z.number(), basis: z.string().nullable() })) }) }).safeParse(receipt.evidence);
    if (primaryClaim === null || !cover.success || !cover.data.outcome.ends.some(end => end.id === shooter()?.id && end.basis === "cover")) return;
    const p = cover.data.outcome.finalPosition;
    const endpoint = new Vec3(p.x, p.y, p.z);
    const wallX = params.wall[0];
    const covered = (position: Vec3) => resumeLeeCovered(bot, shooter(), position, wallX);
    witnessInLee = covered(endpoint);
    witness = createLeeWitness(covered, endpoint);
    witnessPending = true;
    context.log?.(`resume cover ${JSON.stringify({ age: bot.time.age, sequence, requestId: primaryClaim, shooterId: shooter()?.id, position: p })}`);
    witnessRequest = primaryClaim;
    leeWitness = Promise.all([readResumeObservation(probeContext, "entity @s", "lee"), readResumeShooter(probeContext, `resume_${bot.username}`)])
      .then(([reply, shooterPosition]) => {
        witnessPending = false;
        const held = shooter();
        serverShooter = held ? { ...held, position: shooterPosition } as Entity : undefined;
        const valid = !!held && reply.matched && witness!.answer(reply.position) &&
          resumeLeeCovered(bot, serverShooter, reply.position, wallX);
        context.log?.(`resume witness reply ${JSON.stringify({ age: bot.time.age, receiptSequence: sequence, tick: reply.tick, position: reply.position, shooterPosition, valid })}`);
        return valid;
      });
    void leeWitness.catch(() => {});
  }, (sample) => {
    if (witnessPending) {
      witness?.move(bot.entity.position);
    }
    if (!primarySampling || witnessRequest === null || hostileActive || exposureLogged || sample.exposed !== true) return;
    exposureLogged = true;
    context.log?.(`resume exposure ${JSON.stringify({ ...sample, requestId: witnessRequest, shooterId: shooter()?.id,
      body: bot.entity.position, shooter: shooter()?.position })}`);
  });
  return { observation, stopPrimary: () => { primarySampling = false; },
    witness: async () => ({ witnessed: leeWitness ? await leeWitness : false, witnessInLee, witnessRequest, serverShooter }),
    settle: async () => { await leeWitness?.catch(() => {}); } };
}

function resumeSpans(observation: ReturnType<typeof observeResumeFlight>, shooterId: number | undefined) {
  const parsed = observation.receipts.flatMap(({ seq, receipt }) => {
    if (receipt.source !== "hostile_reflex" || (receipt.kind !== "claim" && receipt.kind !== "outcome")) return [];
    const evidence = z.object({ response: z.string() }).safeParse(receipt.evidence);
    if (!evidence.success) throw new Error("invalid evidence: hostile response name missing");
    return [{ seq, kind: receipt.kind, source: receipt.source, response: evidence.data.response, requestId: receipt.status.request?.requestId ?? null }];
  });
  return pairResumeReceipts(parsed).map(pair => {
    const receipt = observation.receipts.find(entry => entry.seq === pair.end)?.receipt;
    const evidence = z.object({ cancelled: z.literal(false), outcome: z.object({ outcome: z.string(),
      ends: z.array(z.object({ id: z.number(), basis: z.string().nullable() })).optional(), finalPosition: z.unknown().optional() }) }).safeParse(receipt?.evidence);
    const end = evidence.success ? evidence.data.outcome.ends?.find(item => item.id === shooterId) : undefined;
    return { ...pair, outcome: evidence.success && pair.response === "evade" ? evidence.data.outcome.outcome : "", basis: end?.basis ?? null, shooterId: end?.id ?? null };
  });
}

async function waitResumeUntil(context: ScenarioContext, until: () => boolean): Promise<void> {
  const result = await waitForWorldAge(context.bot, SERVER_ANSWER_TICKS,
    { wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS, signal: context.signal, until });
  if (result !== "until") throw new Error(`resume observation: ${result}`);
}

async function prepareResume(context: ScenarioContext): Promise<number> {
  const { bot } = context;
  context.signal?.throwIfAborted();
  bot.chat(`/effect give ${bot.username} minecraft:resistance 180 3 true`);
  await waitResumeUntil(context, () => Object.values(bot.entity.effects).some(effect =>
    bot.registry.effects[effect.id]?.name?.toLowerCase() === "resistance" && effect.amplifier === 3));
  await setFlightPolicy(context);
  const status = await context.call("view_status", {});
  const range = status.survivalPolicy?.effective.combat.evade_safe_range;
  assert.equal(range, 36, "effective evade safe range");
  return range;
}

async function followResume(context: ScenarioContext, params: ResumeParams) {
  const { bot, signal } = context;
  const condition = (point: [number, number, number]) => `entity @s[x=${point[0]},y=${point[1]},z=${point[2]},distance=..1]`;
  let before: Vec3 | undefined;
  const target = await chooseResumeTarget(params.nextTarget, params.alternateNextTarget, async (point, id) => {
    const reading = await readResumeObservation(context, condition(point), id);
    if (id === "chosen_range") before = reading.position;
    return resumeTargetInRange(point, reading);
  });
  signal?.throwIfAborted();
  const startAge = bot.time.age;
  const next = await awaitResumeAction(() => context.call("navigate", { x: target[0], y: target[1], z: target[2], range: 1, dig: false, scaffold: false }), signal);
  const endAge = bot.time.age;
  assert.ok(next.requestId != null, "invalid evidence: next request id absent");
  const arrival = await readResumeObservation(context, condition(target), "next_arrival");
  const cell = navigationFeet(arrival.position, true);
  context.log?.(`resume follow-up ${JSON.stringify({ target, before, after: arrival.position, cell })}`);
  return { next, startAge, endAge, moved: !!before && arrival.position.distanceTo(before) > 0,
    arrived: new Vec3(cell.x, cell.y, cell.z).distanceTo(new Vec3(...target)) <= 1 };
}

async function resumeEndpoint(context: ScenarioContext, params: ResumeParams, shooter: Entity | undefined): Promise<boolean> {
  const [x, y, z] = params.target;
  const reading = await readResumeObservation(context, `entity @s[x=${x},y=${y},z=${z},distance=..1]`, "endpoint");
  return params.mode === "detour" ? reading.matched && reading.position.distanceTo(new Vec3(...params.target)) <= 1 + 1e-9 :
    resumeLeeCovered(context.bot, shooter, reading.position, params.wall[0]);
}

function observeResumeShooter(bot: Bot, spawn: [number, number, number]) {
  let entity: Entity | undefined;
  let armed = false;
  let ambiguous = false;
  const spawned = (candidate: Entity) => {
    if (!armed || candidate.name !== "skeleton" || candidate.position.distanceTo(new Vec3(...spawn)) >= 1) return;
    if (entity && entity.id !== candidate.id) ambiguous = true;
    else entity = candidate;
  };
  bot.on("entitySpawn", spawned);
  return { get: () => entity, arm: () => { armed = true; }, ambiguous: () => ambiguous,
    dispose: () => bot.off("entitySpawn", spawned) };
}

/** The stationary shooter is identified by its spawn packet before its attribute is read back. */
async function runResume(context: ScenarioContext, params: ResumeParams): Promise<ClientCompletion> {
  const { bot } = context;
  assert.equal(bot.health, 7, "the starting wound must be observed");
  assert.equal(bot.food, 20, "the actor must start with full food");
  const life = new AbortController();
  const signal = context.signal ? AbortSignal.any([context.signal, life.signal]) : life.signal;
  const death = () => life.abort(new Error("actor died during resume observation"));
  let anchor: number | undefined = bot.time.age ?? undefined;
  const rememberAge = () => { anchor ??= bot.time.age ?? undefined; };
  bot.on("time", rememberAge);
  bot.on("death", death);
  try { return await runLivingResume({ ...context, signal, call: (action, input) => awaitResumeAction(() => context.call(action, input), signal) }, params, () => anchor); }
  finally { bot.off("death", death); bot.off("time", rememberAge); }
}

async function runLivingResume(context: ScenarioContext, params: ResumeParams, anchor: () => number | undefined): Promise<ClientCompletion> {
  const { bot, signal } = context;
  const safeRange = await prepareResume(context);
  const heldShooter = observeResumeShooter(bot, params.spawn);
  const deaths = observeDeaths(bot);
  const probeAbort = new AbortController();
  const probeContext = { ...context, signal: signal ? AbortSignal.any([signal, probeAbort.signal]) : probeAbort.signal };
  let monitor: ReturnType<typeof monitorResume> | undefined;
  let observing = true;
  try {
    monitor = monitorResume(context, params, heldShooter.get, safeRange, probeContext);
    const { observation } = monitor;
    const [x, y, targetZ] = params.target;
    const start = bot.entity.position.clone();
    const primaryStartAge = bot.time.age;
    let ended = false;
    const triggerAbort = new AbortController();
    signal?.throwIfAborted();
    const order = context.call("navigate", { x, y, z: targetZ, range: 1, dig: false, scaffold: false });
    let cutoff: number | undefined;
    let primaryEndAge = bot.time.age;
    const settlePrimary = (reason: string) => {
      if (!observing) return;
      cutoff = observation.cutoff(); monitor!.stopPrimary(); primaryEndAge = bot.time.age;
      ended = true; triggerAbort.abort(new Error(reason));
    };
    void order.then(() => settlePrimary("primary settled before trigger"), () => settlePrimary("primary rejected before trigger"));
    const triggerContext = { ...context, signal: signal ? AbortSignal.any([signal, triggerAbort.signal]) : triggerAbort.signal };
    const server = await waitResumeTrigger(triggerContext, start.z + 0.1, anchor);
    context.log?.(`resume server trigger ${JSON.stringify({ age: bot.time.age, tick: server.tick, position: server.position })}`);
    assert.equal(ended, false, "primary ended before summon");
    const tag = `resume_${bot.username}`;
    heldShooter.arm();
    bot.chat(`/summon minecraft:skeleton ${params.spawn.join(" ")} {Tags:["${tag}"],PersistenceRequired:1b,attributes:[{id:"minecraft:movement_speed",base:0d}],HandItems:[{id:"minecraft:bow",count:1},{}]}`);
    await waitResumeUntil(context, () => !!heldShooter.get());
    const shooter = heldShooter.get()!;
    context.log?.(`resume trigger ${JSON.stringify({ age: bot.time.age, actor: bot.entity.position, shooterId: shooter!.id, shooter: shooter!.position })}`);
    await readResumeSpeed(context, tag);
    assert.equal(heldShooter.ambiguous(), false, "invalid evidence: ambiguous shooter spawn");
    const result = await awaitResumeAction(() => order, signal);
    assert.ok(cutoff !== undefined && result.requestId != null, "invalid evidence: primary cutoff or request id absent");
    const settledCutoff = cutoff;
    const spans = resumeSpans(observation, shooter?.id);
    const firstCover = spans.find(span => span.response === "evade" && span.requestId === result.requestId &&
      span.outcome === "safe_separation" && span.basis === "cover" && span.shooterId === shooter?.id && span.end <= settledCutoff);
    if (!firstCover) return { status: "failed", detail: "not exercised: no qualifying cover separation" };
    const navigationValid = observation.hasNavigation && !!firstCover && judgeNavigationEvents(
      observation.navigation.map(({ seq, event, requestId, owner }) => ({ seq, ...event, requestId, owner })), firstCover.end, settledCutoff, result.requestId);
    const { witnessed, witnessInLee, witnessRequest, serverShooter } = await monitor.witness();
    const endpoint = await resumeEndpoint(context, params, serverShooter);
    const expected = params.mode === "detour" ? result.result.status === "succeeded" : result.result.status === "failed" &&
      "error" in result.result && String(result.result.error).includes("[COVER_ROUTE_REFUSED]");
    if (params.mode === "no-cover" && !navigationValid)
      return { status: "failed", detail: JSON.stringify({ reason: "invalid evidence: resumed navigation events", witnessed, witnessInLee,
        witnessRequest, endpoint, primary: result.result, samples: observation.samples, spans, events: observation.navigation }) };
    if (!expected || !endpoint || !witnessed || !witnessInLee || witnessRequest !== result.requestId)
      return { status: "failed", detail: JSON.stringify({ reason: "primary status, endpoint or lee witness", endpoint, witnessed, witnessInLee,
        witnessRequest, spans, receipts: observation.receipts.filter(item => item.receipt.source === "hostile_reflex" &&
          (item.receipt.kind === "claim" || item.receipt.kind === "outcome")).map(item => ({ seq: item.seq, age: item.age,
          kind: item.receipt.kind, evidence: item.receipt.evidence, requestId: item.receipt.status.request?.requestId })), primary: result.result }) };
    const follow = await followResume(context, params);
    const { next } = follow;
    const verdict = judgeResume(observation.samples, spans, { mode: params.mode, status: result.result.status,
      error: "error" in result.result ? String(result.result.error) : "", nextStatus: next.result.status,
      requestId: result.requestId!, shooterId: shooter!.id, endpointCovered: endpoint, nextMoved: follow.moved,
      nextArrived: follow.arrived, deaths: deaths.deaths.length, cutoff: settledCutoff });
    const nextEvades = observation.receipts.filter(({ receipt }) => receipt.kind === "claim" && receipt.source === "hostile_reflex" &&
      receipt.status.request?.requestId === next.requestId && z.object({ response: z.literal("evade") }).safeParse(receipt.evidence).success).length;
    return { status: verdict.passed ? "succeeded" : "failed", detail: JSON.stringify({ verdict, spans,
      primary: { id: result.requestId, status: result.result.status, error: "error" in result.result ? result.result.error : null,
        age: [primaryStartAge, primaryEndAge], evades: spans.filter(span => span.response === "evade" && span.requestId === result.requestId).length },
      next: { id: next.requestId, status: next.result.status, error: "error" in next.result ? next.result.error : null,
        age: [follow.startAge, follow.endAge], evades: nextEvades } }) };
  } finally {
    observing = false;
    probeAbort.abort();
    await monitor?.settle();
    try { monitor?.observation.close(); } finally { heldShooter.dispose(); deaths.dispose(); }
  }
}

/**
 * Judge the first kept evade and resumed order; baseline diagnostics can omit unavailable basis telemetry.
 * `chain` proves survival, the floor, a hostile interruption and an order that succeeded after a kept evade that either
 * really separated or spent its server-tick budget (`capability_limit` with at least `budgetTicks` elapsed); its basis
 * and distance are not asserted, and a wall-backstop stop below the budget is not a budget ending.
 */
export function flightVerdict(evidence: FlightEvidence, bases: readonly string[], maxDistance?: number,
  { requireBasis = true, judge = "order", budgetTicks }: { readonly requireBasis?: boolean; readonly judge?: "order" | "evade" | "chain";
    readonly budgetTicks?: number } = {}): boolean {
  if (judge === "chain") return chainVerdict(evidence, budgetTicks);
  return evidence.floor.kind === "ok" && evidence.outcome === "safe_separation" &&
    (!requireBasis || (evidence.basis != null && bases.includes(evidence.basis))) &&
    (maxDistance === undefined || (evidence.distance !== undefined && evidence.distance < maxDistance)) &&
    (judge === "evade" ? (evidence.healthAfter ?? 0) > 0 : evidence.health > 0 &&
      evidence.status === "succeeded" && evidence.interruptions.some((item) => item.includes("[HOSTILE_CONTACT]")));
}

/** A kept evade that really separated, or that ended as `capability_limit` after the whole server-tick budget elapsed. */
function chainVerdict(evidence: FlightEvidence, budgetTicks: number | undefined): boolean {
  const separated = evidence.outcome === "safe_separation";
  const budgetSpent = evidence.outcome === "capability_limit" && budgetTicks !== undefined && (evidence.elapsedTicks ?? -1) >= budgetTicks;
  return evidence.floor.kind === "ok" && (separated || budgetSpent) &&
    (evidence.healthAfter ?? 0) > 0 && evidence.health > 0 && evidence.status === "succeeded" &&
    evidence.interruptions.some((item) => item.includes("[HOSTILE_CONTACT]"));
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
    elapsedTicks: kept?.elapsedTicks, status: options.status, interruptions: options.interruptions };
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
    judge: z.enum(["order", "evade", "chain", "resume"]).default("order"), holdShooter: z.boolean().default(false),
    mode: z.enum(["detour", "no-cover"]).optional(), wall: arenaPoint(context.arena).optional(),
    nextTarget: arenaPoint(context.arena).optional(), alternateNextTarget: arenaPoint(context.arena).optional() }).parse(context.scenario.params);
  if (params.judge === "resume") {
    assert.ok(params.mode && params.wall && params.nextTarget && params.alternateNextTarget);
    return runResume(context, { ...params, mode: params.mode, wall: params.wall,
      nextTarget: params.nextTarget, alternateNextTarget: params.alternateNextTarget });
  }
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
    // The flight policy changes only `hide` (setFlightPolicy), so the default evade timeout is the effective budget.
    const budgetTicks = evadeBudgetTicks(DEFAULT_COMBAT_POLICY);
    const evidence = flightEvidence(await flightEvents(context), { startY, deaths: deaths.deaths.length, health: context.bot.health,
      status: result.result.status, interruptions: result.interruptions ?? [] });
    const detail = JSON.stringify({ ...evidence, ages, budgetTicks, deaths: deaths.deaths.length, summary: result.summary,
      physicalPass: flightVerdict(evidence, params.bases, params.maxDistance, { requireBasis: false, judge: params.judge }),
      chainPass: flightVerdict(evidence, params.bases, params.maxDistance, { judge: "chain", budgetTicks }) });
    return { status: flightVerdict(evidence, params.bases, params.maxDistance, { judge: params.judge, budgetTicks }) ? "succeeded" : "failed", detail };
  } finally { context.bot.off("time", onTime); deaths.dispose(); }
}
