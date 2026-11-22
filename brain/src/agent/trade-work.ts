// The own-goal work that talks and trades: a hand-off of a trade, a chat with a partner, a trade routine, and what the goal draw knows of trading.
import { activityChances, availableActivities, drawTwo, type ActivityChance } from "../activity-draw.ts";
import type { Activity } from "../activities.ts";
import type { Body } from "../body.ts";
import { BodyDown } from "../body-down.ts";
import { pickPartner, socialise, type SocialiseDeps } from "../conversation/socialise.ts";
import type { ConversationController } from "../conversation/controller.ts";
import { withMaterialsKept } from "../gathering/gather-materials.ts";
import { elapsedSince, monotonicNow } from "../monotonic-clock.ts";
import type { OpportunityFacts } from "../opportunities.ts";
import { personaSkills } from "../persona.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { describeHandoff, handoffKey, type Handoff } from "../relations/handoff.ts";
import { heldKinds } from "../relations/items.ts";
import type { OwnWork } from "../relations/own-work.ts";
import { agreedDetail, heardNeeds, partnersInReach, TradeAsks, tradeNeedsFacts, tradePlan, tradeRoutine, tradingShare, withTrading, withoutRefusedTrading } from "../relations/trading.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import { lastOfPlay, minutesByActivity, minutesByPurpose } from "../time-spent.ts";
import type { AgentMemory } from "./agent-memory.ts";
import type { AgentOptions } from "../agent.ts";
import type { Work } from "./work.ts";

/** A player heard this recently (ms) can be gone and chat with. */
const PARTNER_HEARD_MS = 10 * 60_000;
/** A step shorter than this is not worth a memory note (it still counts until the brain stops). */
const MIN_RECORDED_MS = 5_000;

/** What the talking and trading work reads from the agent it belongs to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
export interface TradeWorkHost {
  readonly options: AgentOptions;
  readonly body: Body;
  readonly memory: AgentMemory;
  readonly stack: Work[];
  readonly talks: ConversationController | null;
  readonly relations: AgentRelations | null;
  readonly own: OwnWork;
  readonly asks: TradeAsks;
  /** When this agent started (wall clock): the window of trading's share of the time begins here, so a restart starts it again. */
  startedAt(): number;
  /** When each player (lower case) last said anything. */
  readonly lastHeard: ReadonlyMap<string, number>;
  readonly state: { readonly onlineNames: readonly string[] };
  /** Its last own objective, when it failed. */
  lastFailed(): { readonly objective: string; readonly reason: string } | null;
  activity(): string;
  runSignal(): AbortSignal;
  journalState(step: string | null): void;
  finish(work: Work, outcome: "done" | "failed", detail: string): void;
}

/** Who it could go and chat with: the other agents and the players heard in the last {@link PARTNER_HEARD_MS}, not itself. */
export function partners(host: TradeWorkHost): string[] {
  if (host.talks === null) return [];
  const self = host.options.persona.username.toLowerCase();
  const heard = [...host.lastHeard].filter(([, at]) => elapsedSince(at) <= PARTNER_HEARD_MS).map(([name]) => host.state.onlineNames.find((online) => online.toLowerCase() === name) ?? name);
  const seen = new Set<string>([self]);
  return [...host.options.otherAgents.names(), ...heard].filter((name) => {
    if (seen.has(name.toLowerCase())) return false;
    seen.add(name.toLowerCase());
    return true;
  });
}

/** How far a partner is sought for a trade: `relations.seekReach`, never beyond what a line carries (the talk range) so the routine can call them. */
function seekReach(host: TradeWorkHost): number {
  const { persona, localizedChat } = host.options;
  return Math.min(persona.settings.relations.seekReach, localizedChat?.range ?? persona.settings.conversation.stayingDistance);
}

/** What the goal draw is given: the chances, the two drawn, and what the opportunities know of trading. */
export interface GoalDraw {
  readonly chances: readonly ActivityChance[];
  readonly drawn: readonly Activity[];
  readonly trading: Pick<OpportunityFacts, "tradeNeeds" | "heardNeeds">;
  readonly time: ReturnType<typeof minutesByActivity>;
}

/** The activities the goal tier is shown and the two drawn by their chances (spec 2026-10-09-activity-draw), with trading drawn only when a partner can be asked. */
export function drawGoal(host: TradeWorkHost, snapshot: BotSnapshot): GoalDraw {
  const { persona } = host.options;
  const hour = lastOfPlay(host.memory.times);
  const time = minutesByActivity(hour);
  // What it feels like doing now (spec 2026-10-09-activity-draw): two activities drawn by their chances, which count
  // the hour's time spent *for* each, not the kind of work the body did.
  const spent = new Map(minutesByPurpose(hour).map(({ activity, minutes }) => [activity, minutes]));
  // Trading is not drawn while every partner refused lately: it would only fail "no one to trade with".
  // Nor while it has taken its share of the time since the agent started (relations/trading.ts `MAX_SHARE`).
  const share = tradingShare(hour, Date.now(), host.startedAt());
  // Nor while no partner is seen within `relations.seekReach` blocks (the talk range): the routine walks to or calls a partner that near.
  const inReach = partnersInReach(partners(host), snapshot, seekReach(host));
  const available = withoutRefusedTrading(availableActivities(personaSkills(persona), snapshot, partners(host)), partners(host), host.asks, monotonicNow(), share, inReach);
  const chances = activityChances(available, persona.preferences, persona.settings.feelingMultipliers, (activity) => spent.get(activity) ?? 0);
  // Getting an item failed lately: trading takes the second place while someone has not refused it yet.
  host.asks.dropRefused(partners(host), monotonicNow());
  const needs = host.asks.needs.current(monotonicNow(), snapshot.inventory);
  // A partner in reach said it needs something she carries: a trade to offer, trading takes the second place for it too.
  const heard = heardNeeds(host.relations?.book.records() ?? [], snapshot.inventory, { now: monotonicNow(), wallNow: Date.now() }, persona.settings.relations.offersForgetMinutes, { asks: host.asks, partners: inReach });
  const drawn = withTrading(drawTwo(chances, host.options.random ?? Math.random), available, needs, share, heard.length);
  const tradeNeeds = needs.length > 0 && drawn.includes("trading") ? tradeNeedsFacts(needs, inReach, host.asks, snapshot.inventory, monotonicNow()) : undefined;
  return { chances, drawn, time, trading: { ...(tradeNeeds !== undefined && { tradeNeeds }), ...(heard.length > 0 && drawn.includes("trading") && { heardNeeds: heard }) } };
}

/** The relations' look at the bag: what the steps and hand-offs explain is told, a tick that counted one moved the window. */
export function tickRelations(host: TradeWorkHost, signal: AbortSignal): void {
  host.own.advance(host.relations?.countedTicks() ?? 0);
  const handoffs = new Set(host.stack.flatMap((work) => work.objective.handoff === undefined ? [] : [handoffKey(work.objective.handoff)]));
  const answer = host.relations?.look(host.own.yields(), handoffs, signal, host.own.active());
  // An idle controller counts no gain; a tick that counted one moved the window (advance above), so a tick that failed does not use it up.
  if (answer === "idle") host.own.idle();
  else if (answer === "ticked") host.own.handedOver();
}

/** The step of a hand-off objective: the routine in relations/handoff.ts; a stop or a shelter drops it and the trade stays due. */
export async function handoffStep(host: TradeWorkHost, work: Work, h: Handoff): Promise<void> {
  const { runtime, persona } = host.options;
  const controller = new AbortController();
  work.step = controller;
  host.own.startOwnWork();
  host.journalState(describeHandoff(h));
  let end = { outcome: "dropped", detail: "" };
  try {
    // The walk to the partner places no scaffold block a trade owes all of, the handed-over kind included.
    const held = [...heldKinds(host.relations!.trades.owed(), (await runtime.status()).inventory)];
    end = await withMaterialsKept(runtime, held, () => host.relations!.runHandoff(h, { runtime, body: host.body, signal: AbortSignal.any([controller.signal, host.runSignal()]), self: persona.username }));
  } finally {
    work.step = null;
    host.journalState(null);
    host.own.endOwnWork();
  }
  if (end.outcome !== "dropped") host.finish(work, end.outcome === "done" ? "done" : "failed", end.detail);
  // A wait that a give or a collect set aside stays below it and resumes; any other dropped hand-off leaves the stack.
  else if (host.stack.includes(work) && !(h.kind === "await" && host.stack.at(-1) !== work)) host.stack.splice(host.stack.indexOf(work), 1);
}

/**
 * The step of a `socialising` objective of its own: the code routine in conversation/socialise.ts (like the night
 * shelter, no work-tier call). An order that takes the body aborts it, and the objective ends.
 */
export async function socialiseStep(host: TradeWorkHost, work: Work): Promise<void> {
  if (host.talks === null) return host.finish(work, "failed", "conversations are off");
  const snapshot = await host.options.runtime.status();
  const partner = pickPartner(work.objective.text, partners(host), snapshot);
  if (partner === null) return host.finish(work, "failed", "nobody to talk to");
  const openFacts = { activity: host.activity(), lately: [...host.memory.lately], lastFailed: host.lastFailed() };
  return routineStep(host, work, "socialising", `chat with ${partner}`, { skill: "socialise", partner }, (base) => socialise({ ...base, partner, openFacts }));
}

/** The step of a `trading` objective of its own: relations/trading.ts asks a partner for the items it lacks. */
export async function tradeStep(host: TradeWorkHost, work: Work): Promise<void> {
  const trades = host.relations?.trades;
  if (host.talks === null || trades === undefined) return host.finish(work, "failed", "trading is off");
  // A trade agreed since the objective began (the talk's hand-off interrupted this step) met it: no second talk.
  const agreed = trades.agreedSince(work.startedAt);
  if (agreed !== null) {
    host.asks.resume();
    return host.finish(work, "done", agreedDetail(agreed.partner, agreed));
  }
  const snapshot = await host.options.runtime.status();
  const others = partners(host);
  const inReach = partnersInReach(others, snapshot, seekReach(host));
  const heard = heardNeeds(host.relations?.book.records() ?? [], snapshot.inventory, { now: monotonicNow(), wallNow: Date.now() }, host.options.persona.settings.relations.offersForgetMinutes, { asks: host.asks, partners: inReach });
  const plan = tradePlan(work.objective.text, host.asks.needs.current(monotonicNow(), snapshot.inventory), others, host.asks, snapshot, monotonicNow(), { inReach, heard });
  if ("failed" in plan) {
    // It failed before any ask: after two in a row trading is not drawn for a while.
    host.asks.failedFast(monotonicNow());
    return host.finish(work, "failed", plan.failed);
  }
  const { want, partner, offer } = plan;
  // What it asks for is what the chat calls of the talk are told it lacks.
  for (const item of want) work.wanted.add(item);
  const openFacts = { activity: host.activity(), lately: [...host.memory.lately], lastFailed: host.lastFailed() };
  return routineStep(host, work, "trading", `trade with ${partner}`, { skill: "trade", partner }, (base) => tradeRoutine({ ...base, partner, want, ...(offer !== undefined && { offer }), asks: host.asks, trades, openFacts }));
}

/** Runs a conversation routine as the objective's step: journals it, counts its time for `activity`, ends the objective with its result. */
async function routineStep(host: TradeWorkHost, work: Work, activity: "socialising" | "trading", label: string, input: Record<string, string>, run: (base: Omit<SocialiseDeps, "partner" | "openFacts"> & { readonly sinceMonotonic: number }) => Promise<SkillResult>): Promise<void> {
  const { persona, runtime, log } = host.options;
  const talks = host.talks!;
  const controller = new AbortController();
  work.step = controller;
  log(`${activity}: ${label}`);
  host.journalState(label);
  const started = monotonicNow();
  const signal = AbortSignal.any([controller.signal, host.runSignal()]);
  const talkRange = host.options.localizedChat?.range ?? persona.settings.conversation.stayingDistance;
  let result: SkillResult;
  try {
    result = await run({
      runtime,
      signal,
      talks,
      since: work.startedAt, sinceMonotonic: work.startedAtMonotonic,
      context: { runtime, body: host.body, signal, self: persona.username },
      limits: { openingDistance: persona.settings.conversation.openingDistance, talkRange, maxMinutes: persona.settings.conversation.maxMinutes },
    });
  } catch (error) {
    // A body the supervisor keeps down is no failed conversation: the work loop waits for it.
    if (error instanceof BodyDown) throw error;
    result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
  } finally {
    work.step = null;
  }
  const ms = elapsedSince(started);
  const outcome = result.status === "stopped" ? "interrupted" : result.status;
  const detail = result.status === "stopped" ? "an order came first" : result.detail;
  host.memory.spent({ activity, purpose: activity, ended: new Date().toISOString(), minutes: ms / 60_000 }, ms >= MIN_RECORDED_MS);
  host.options.journal?.({ kind: "step", objective: work.objective.text, requester: null, step: label, input, thought: "", outcome, detail, ms, activity, purpose: activity });
  host.journalState(null);
  log(`  -> ${label}: ${outcome}: ${detail}`);
  // Set aside (a member's favour, a night) it stays on the stack and runs again; stopped and removed, it ends here.
  if (result.status === "stopped" && host.stack.includes(work) && !host.runSignal().aborted) return;
  host.finish(work, result.status === "done" ? "done" : "failed", detail);
}
