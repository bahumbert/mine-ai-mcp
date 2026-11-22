import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { NavigationEvent } from "../../../src/navigation/telemetry/index.ts";
import { heldByBlockAt } from "../../../src/navigation/world/block-geometry.ts";
import { liveBlockReader } from "../../../src/navigation/mineflayer/world.ts";
import { positionExposed } from "../../../src/survival/positioning/combat/exposure.ts";
import type { SurvivalReceipt } from "../../../src/survival/evidence/contract.ts";
import type { ScenarioContext } from "../scenario.ts";
import assert from "node:assert/strict";
import { waitForWorldAge, SERVER_ANSWER_TICKS, STALE_AGE_TICKS } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/** Correlate one system reply, retain conflicts, and always release its listener. */
async function readResumeReply(context: ScenarioContext, prefix: string, label: string, ticks: number, send: () => void) {
  context.signal?.throwIfAborted();
  let answer: string | undefined;
  let conflicting = false;
  const onMessage = (message: string, kind: string) => {
    if (kind !== "system" || !message.startsWith(prefix)) return;
    const value = message.slice(prefix.length);
    if (answer !== undefined && answer !== value) conflicting = true;
    answer = value;
  };
  context.bot.on("messagestr", onMessage);
  try {
    send();
    const result = await waitForWorldAge(context.bot, ticks, { wallMs: Infinity, stallMs: DRIVER_CLOCK_STOPPED_MS,
      signal: context.signal, until: () => answer !== undefined });
    if (result !== "until") throw new Error(`${label}: ${result}`);
    return { answer: answer!, conflicting };
  } finally { context.bot.off("messagestr", onMessage); }
}

/** One server-side decision, tick and feet position, with its answer listener armed first. */
export async function readResumeObservation(context: ScenarioContext, condition: string, id: string, maxTicks = SERVER_ANSWER_TICKS): Promise<{
  matched: boolean; tick: number; position: Vec3;
}> {
  const key = `resume_${context.bot.username}_${id}`;
  const prefix = `resume_probe_${context.bot.username}_${id} `;
  const { answer, conflicting } = await readResumeReply(context, prefix, `resume probe ${id}`, Math.min(SERVER_ANSWER_TICKS, maxTicks), () => {
    context.bot.chat(`/data merge storage mine_ai:cm {p_${key}:0,v_${key}:0}`);
    context.bot.chat(`/execute as ${context.bot.username} at @s store success storage mine_ai:cm p_${key} int 1 store result storage mine_ai:cm v_${key} int 1 if ${condition} run time query gametime`);
    context.bot.chat(`/tellraw @s ${JSON.stringify({ text: prefix, extra: [{ nbt: `p_${key}`, storage: "mine_ai:cm" }, { text: " " },
      { nbt: `v_${key}`, storage: "mine_ai:cm" }, { text: " " }, { nbt: "Pos", entity: "@s" }] })}`);
  });
  const parsed = /^(0|1)\s+(\d+)\s+\[\s*([-+\d.eE]+)[dD]?\s*,\s*([-+\d.eE]+)[dD]?\s*,\s*([-+\d.eE]+)[dD]?\s*\]$/u.exec(answer.trim());
  if (conflicting || !parsed) throw new Error(`resume probe ${id}: malformed or conflicting answer ${answer}`);
  const values = parsed.slice(2).map(Number);
  if (values.some(value => !Number.isFinite(value))) throw new Error(`resume probe ${id}: non-finite answer`);
  return { matched: parsed[1] === "1", tick: values[0]!, position: new Vec3(values[1]!, values[2]!, values[3]!) };
}

export async function readResumeProbe(context: ScenarioContext, condition: string, id: string): Promise<boolean> {
  return (await readResumeObservation(context, condition, id)).matched;
}

/** Read the stationary tagged shooter's server position at the cover receipt. */
export async function readResumeShooter(context: ScenarioContext, tag: string): Promise<Vec3> {
  const prefix = `resume_shooter_${context.bot.username} `;
  const { answer, conflicting } = await readResumeReply(context, prefix, "shooter position", SERVER_ANSWER_TICKS, () => {
    context.bot.chat(`/tellraw @s ${JSON.stringify({ text: prefix, extra: [{ nbt: "Pos", entity: `@e[type=minecraft:skeleton,tag=${tag},limit=1]` }] })}`);
  });
  const parsed = /^\[\s*([-+\d.eE]+)[dD]?\s*,\s*([-+\d.eE]+)[dD]?\s*,\s*([-+\d.eE]+)[dD]?\s*\]$/u.exec(answer.trim());
  if (conflicting || !parsed || parsed.slice(1).map(Number).some(value => !Number.isFinite(value))) throw new Error("invalid shooter position");
  return new Vec3(Number(parsed[1]), Number(parsed[2]), Number(parsed[3]));
}

/** Read the tagged shooter's total speed with the held-shooter measured answer budget. */
export async function readResumeSpeed(context: ScenarioContext, tag: string): Promise<void> {
  const { bot } = context;
  const key = `resume_${bot.username}`;
  const prefix = `resume_speed_${bot.username} `;
  const { answer, conflicting } = await readResumeReply(context, prefix, "shooter speed", 2 + STALE_AGE_TICKS, () => {
    bot.chat(`/execute store success storage mine_ai:cm p_${key} int 1 store result storage mine_ai:cm v_${key} int 1 run attribute @e[type=minecraft:skeleton,tag=${tag},limit=1] minecraft:movement_speed get 100000`);
    bot.chat(`/tellraw @s ${JSON.stringify({ text: prefix, extra: [{ nbt: `p_${key}`, storage: "mine_ai:cm" }, { text: " " }, { nbt: `v_${key}`, storage: "mine_ai:cm" }] })}`);
  });
  assert.equal(conflicting, false, "conflicting shooter speed replies");
  assert.deepEqual(answer.trim().split(/\s+/).map(Number), [1, 0], "shooter movement speed must be zero");
}

interface ResumeReceipt {
  readonly seq: number;
  readonly kind: string;
  readonly source: string;
  readonly response: string;
  readonly requestId: number | null;
}

export function judgeNavigationEvents(events: readonly { seq: number; kind: string; runId: string; planId?: string | null; requestId?: number | null; owner?: string | null }[],
  coverSeq: number, cutoff: number, requestId?: number): boolean {
  const window = events.filter(event => event.seq > coverSeq && event.seq <= cutoff);
  const starts = window.filter(event => event.kind === "run_started" &&
    (requestId === undefined || (event.requestId === requestId && event.owner === "navigate")));
  if (starts.length !== 1) return false;
  const run = window.filter(event => event.runId === starts[0]!.runId);
  const refusals = run.filter(event => event.kind === "route_refused");
  return refusals.length === 1 && refusals[0]!.planId === null && refusals[0]!.seq > starts[0]!.seq &&
    (requestId === undefined || (refusals[0]!.requestId === requestId && refusals[0]!.owner === "navigate")) && !run.some(event =>
    ["search_started", "search_slice", "route_committed", "step_started"].includes(event.kind));
}

/** The first receipt owns its witness; an exit or handoff cannot be repaired by a later re-entry. */
export function createLeeWitness(covered: (position: Vec3) => boolean, endpoint: Vec3) {
  let valid = covered(endpoint);
  return {
    move: (position: Vec3) => { if (!covered(position)) valid = false; },
    handoff: () => { valid = false; },
    answer: (position: Vec3) => valid && covered(position),
  };
}

/** Return null when a body or ray crosses unloaded geometry. */
function resumeExposed(bot: Bot, entity: Entity | undefined, position: Vec3, range: number): boolean | null {
  if (!entity?.isValid) return null;
  let unknown = !bot.blockAt(position) || !bot.blockAt(position.offset(0, 1, 0));
  const rays = { raycast: (from: Vec3, direction: Vec3, distance: number) => {
    const hit = bot.world.raycast(from, direction, distance);
    const end = hit ? Math.min(distance, from.distanceTo(hit.intersect) + 1) : distance;
    for (let d = 0; d < end; d += 0.25) if (!bot.blockAt(from.plus(direction.scaled(d)))) { unknown = true; break; }
    return hit;
  } };
  const seen = position.distanceTo(entity.position) <= range && positionExposed(rays, { ...bot.entity, position },
    { id: entity.id, attack: "projectile", position: entity.position, width: entity.width, height: entity.height });
  return unknown ? null : !!seen;
}

/** The wall occupies one block at x = wallX; the shooter and body must be on opposite sides. */
export function resumeLeeCovered(bot: Bot, shooter: Entity | undefined, position: Vec3, wallX: number): boolean {
  return !!shooter && heldByBlockAt(liveBlockReader(bot), position) === true && shooter.position.x < wallX && position.x - bot.entity.width / 2 >= wallX + 1 &&
    resumeExposed(bot, shooter, position, Infinity) === false;
}

export function pairResumeReceipts(receipts: readonly ResumeReceipt[]) {
  const spans: { start: number; end: number; response: string; requestId: number | null }[] = [];
  let pending: ResumeReceipt | undefined;
  for (const receipt of receipts) {
    if (receipt.source !== "hostile_reflex") continue;
    if (receipt.kind === "claim") {
      if (pending) throw new Error("invalid evidence: duplicate hostile claim");
      pending = receipt;
    } else if (receipt.kind === "outcome") {
      if (!pending || pending.response !== receipt.response) throw new Error("invalid evidence: unmatched hostile outcome");
      spans.push({ start: pending.seq, end: receipt.seq, response: pending.response, requestId: pending.requestId });
      pending = undefined;
    }
  }
  if (pending) spans.push({ start: pending.seq, end: Infinity, response: pending.response, requestId: pending.requestId });
  return spans;
}

export function judgeResume(samples: readonly { seq: number; exposed: boolean | null }[],
  receipts: readonly { start: number; end: number; response: string; outcome: string; basis: string | null; requestId: number | null; shooterId: number | null }[],
  outputs: { mode: "detour" | "no-cover"; status: string; error: string; nextStatus: string; requestId: number;
    shooterId: number; endpointCovered: boolean; nextMoved: boolean; nextArrived: boolean; deaths: number; cutoff: number }) {
  const separation = receipts.find(receipt => receipt.end <= outputs.cutoff && receipt.response === "evade" && receipt.outcome === "safe_separation" && receipt.basis === "cover" &&
    receipt.requestId === outputs.requestId && receipt.shooterId === outputs.shooterId);
  const judged = separation ? samples.filter(sample => sample.seq > separation.end && sample.seq <= outputs.cutoff &&
    !receipts.some(receipt => sample.seq >= receipt.start && sample.seq <= receipt.end)) : [];
  const exposed = judged.filter(sample => sample.exposed === true).length;
  const correct = outputs.mode === "detour" ? outputs.status === "succeeded" :
    outputs.status === "failed" && outputs.error.includes("[COVER_ROUTE_REFUSED]");
  const known = judged.every(sample => sample.exposed !== null);
  return { passed: !!separation && known && exposed === 0 && (outputs.mode !== "detour" || judged.length > 0) && correct &&
    outputs.endpointCovered && outputs.nextStatus === "succeeded" && outputs.nextMoved && outputs.nextArrived && outputs.deaths === 0,
    reason: separation ? known ? "judged" : "invalid evidence" : "not exercised",
    evades: receipts.filter(receipt => receipt.response === "evade" && receipt.requestId === outputs.requestId).length, exposed, judged: judged.length };
}

/** Listen before the order, and keep movement and receipt observations in one sequence. */
export function observeResumeFlight(context: ScenarioContext, shooter: () => number | undefined, range: number,
  onReceipt: (receipt: SurvivalReceipt, sequence: number) => void = () => {},
  onSample: (sample: { seq: number; age: number; exposed: boolean | null }) => void = () => {}) {
  if (!context.onSurvivalReceipt) throw new Error("invalid evidence: no survival receipt observer");
  const samples: { seq: number; age: number; exposed: boolean | null }[] = [];
  const receipts: { seq: number; age: number; receipt: SurvivalReceipt }[] = [];
  const navigation: { seq: number; age: number; event: NavigationEvent; requestId?: number | null; owner?: string | null }[] = [];
  let sequence = 0;
  let previousAge = -1;
  let sampling = true;
  let closed = false;
  let owner: string | null = null;
  const sample = () => {
    const entity = context.bot.entities[shooter() ?? -1];
    const exposed = owner !== null && owner !== "navigate" ? null : resumeExposed(context.bot, entity, context.bot.entity.position, range);
    const observed = { seq: ++sequence, age: context.bot.time.age, exposed };
    if (sampling) samples.push(observed);
    onSample(observed);
  };
  const time = () => { if (context.bot.time.age !== previousAge) { previousAge = context.bot.time.age; sample(); } };
  const unsubscribe = context.onSurvivalReceipt((receipt) => {
    receipts.push({ seq: ++sequence, age: context.bot.time.age, receipt });
    if (receipt.source === "body") owner = receipt.status.owner.current;
    onReceipt(receipt, sequence);
  });
  let unsubscribeNavigation: (() => void) | undefined;
  try {
    unsubscribeNavigation = context.onNavigationEvent?.((event, owner) => { navigation.push({ seq: ++sequence, age: context.bot.time.age, event,
      requestId: owner?.requestId, owner: owner?.current }); });
    context.bot.on("time", time);
    context.bot.on("move", sample);
    context.bot.on("forcedMove", sample);
  } catch (error) {
    try { unsubscribe(); } finally { try { unsubscribeNavigation?.(); } finally { context.bot.off("time", time); context.bot.off("move", sample); context.bot.off("forcedMove", sample); } }
    throw error;
  }
  return {
    samples, receipts, navigation, hasNavigation: !!context.onNavigationEvent,
    cutoff: () => { sample(); sampling = false; return sequence; },
    close: () => {
      if (closed) return;
      closed = true;
      try { unsubscribe(); } finally { try { unsubscribeNavigation?.(); } finally { context.bot.off("time", time); context.bot.off("move", sample); context.bot.off("forcedMove", sample); } }
    },
  };
}


