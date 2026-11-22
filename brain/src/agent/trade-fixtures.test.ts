// Helpers shared by the trade tests of this folder: a trading runtime, Theo's offer, an agent whose order rolls are scripted.
import type { Agent, AgentOptions } from "../agent.ts";
import type { BrainEvent } from "../brain-log.ts";
import { recall } from "../memory.ts";
import type { Persona } from "../persona.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { TradeBoard } from "../relations/board.ts";
import { FakeRuntime, testPersona, until } from "../testing.ts";
import { agentFor, others, say, talkOptions } from "./agent-fixtures.test.ts";

export const MIN = 60_000;
export const ACCEPT = { spoken_to: ["Ayla"], asks: "", language: "English", say: "Deal.", route: "talk", request: "", trade: { action: "accept", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "me" } };

/** A runtime with Theo two blocks away and 10 bread carried, for the trade tests. */
export function tradingRuntime(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bread", count: 10 }], players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] };
  return runtime;
}

/** The relation notes of the runtime, newest first, read back the way a restart does. */
export function savedRelations(runtime: FakeRuntime) {
  return recall(runtime.notes.map((note) => note.context).reverse(), { places: 8, lately: 5, farms: 4, times: 3 }).relations;
}

/** The objectives the agent took on, as `<requester or own>: <text>`, from its journal. */
export const takenObjectives = (events: BrainEvent[]): string[] => events.flatMap((event) => (event.kind === "objective" && event.event === "taken" ? [`${event.requester ?? "own"}: ${event.text}`] : []));

/** An agent whose first impression of everyone is `rated` and whose rolls on an order come out as `rolls` in turn (the last one repeats); `rolled.count` is how often it was asked. */
export function moodyAgent(t: Parameters<typeof agentFor>[0], runtime: FakeRuntime, rated: number, rolls: number | number[], persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const logs: string[] = [];
  const events: BrainEvent[] = [];
  const rolled = { count: 0 };
  const scripted = [rolls].flat();
  const { settings } = testPersona();
  const settingsRated = { ...settings, relations: { ...settings.relations, temperament: { ...settings.relations.temperament, firstImpression: rated } } };
  const built = agentFor(t, runtime, { settings: settingsRated, ...persona }, { obeyRandom: () => scripted[Math.min(rolled.count++, scripted.length - 1)]!, log: (line) => logs.push(line), journal: (event) => events.push(event), ...options });
  return { ...built, logs, events, rolled };
}

export const GIVE_STEPS = [{ step: { skill: "give_item", player: "Theo", item: "bread", count: 5 } }, { done: "Theo has the bread" }] as const;
/** Preferences make the chat tier answer `work` (`LlmMind` keeps it only then): the reading an order is let through a trade on. */
export const PREFS = { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } as const;
export const THEO_OFFER = { id: "Theo-Ayla-1", proposer: "Theo", partner: "Ayla", give: [{ item: "iron_ingot", count: 5 }], get: [{ item: "bread", count: 5 }], first: "me" as const, postedAt: 1 };

// Spec 2026-11-08-trading-p2-fixes D1-D2 (plan Task 1.2): an order the model read as an activity is taken during a trade; a give inside it is guarded at its step.
export const BUILD_ORDER = { say: "On it.", route: "act", request: "build a small shelter right here first", work: "building" };

/** Ayla with preferences (so the chat tier's `work` is kept) over a runtime with Theo near; Theo's offer is on the board unless `offer` is false. */
export function duringTrade(t: Parameters<typeof agentFor>[0], o: { readonly rated?: number; readonly roll?: number; readonly offer?: boolean; readonly goal?: string } = {}) {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  if (o.offer !== false) board.post(THEO_OFFER);
  return { runtime, board, ...moodyAgent(t, runtime, o.rated ?? 0, o.roll ?? 0, { preferences: PREFS, ...(o.goal !== undefined && { goal: o.goal }) }, { tradeBoard: board }) };
}

export const ACCEPT_THEO = { ...ACCEPT, spoken_to: ["Ayla"], say: "Deal!", trade: { ...ACCEPT.trade, first: "them" } };

/** Ayla with the trade of `ACCEPT_THEO` agreed (Theo pays first, so only a wait stands on the stack); the id of that trade. */
export async function withAgreedTrade(t: Parameters<typeof agentFor>[0]) {
  const runtime = tradingRuntime();
  const built = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  built.chat.reply(ACCEPT_THEO);
  await built.agent.handle(say("Theo", "Ayla, take the deal"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "agreed");
  const relations = (built.agent as unknown as { relations: AgentRelations }).relations;
  return { runtime, ...built, relations, id: relations.book.trades()[0]!.id };
}

/** Ayla (bread, Theo 2 blocks away) whose own `get_items` for 3 iron_ingot ends failed: the goal tier is asked again with trading in reach. */
export async function failedIronObjective(t: Parameters<typeof agentFor>[0], extra: Partial<AgentOptions> = {}, theoX = 30, nearby: FakeRuntime["snapshot"]["players"] = []) {
  // Theo is out of the opening distance: no chance opening takes the talk before the routine does.
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: theoX, y: 64, z: 0 } }, ...nearby] };
  runtime.durations.navigate = 5;
  const events: BrainEvent[] = [];
  const built = agentFor(t, runtime, { goal: "Forge an iron kit." }, talkOptions({ journal: (event) => events.push(event), otherAgents: others("Theo"), random: () => 0, ...extra }));
  built.planner.reply({ objective: "get 3 iron_ingot" });
  built.action.reply({ step: { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] } }, { give_up: "no iron anywhere near" });
  return { runtime, events, ...built };
}

/** A runtime with Vex (another agent) `x` blocks away and Theo (a player) 200 away; the log lines of the agent. */
export function chatFromFarAgent(t: Parameters<typeof agentFor>[0], vexX: number) {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: vexX, y: 64, z: 0 } }, { username: "Theo", position: { x: 200, y: 64, z: 0 } }] };
  const events: BrainEvent[] = [];
  const logs: string[] = [];
  return { runtime, events, logs, ...agentFor(t, runtime, { preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } }, talkOptions({ journal: (event) => events.push(event), log: (line) => logs.push(line) })) };
}
export const ORDER = { spoken_to: ["Ayla"], asks: "", language: "English", say: "On my way.", route: "act", request: "bring 5 iron_ingot to Vex", work: "trading" };

/** The trade as the agent holds it now (the note save waits behind a running foreground action, the book does not). */
export const heldTrade = (agent: Agent) => (agent as unknown as { relations: AgentRelations }).relations.book.trades().at(-1);
