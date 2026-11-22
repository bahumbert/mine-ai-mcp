// Tests of what a talking player's early payment is credited from (the yield of a finished step is the bot's own, a late gain after a step ended).
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import type { Step } from "../actions.ts";
import type { Agent } from "../agent.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { FakeRuntime } from "../testing.ts";
import { agentFor, clockUntil, onClock, say } from "./agent-fixtures.test.ts";
import { ACCEPT, chatFromFarAgent, heldTrade, ORDER, takenObjectives, tradingRuntime } from "./trade-fixtures.test.ts";

/** A step of the agent's run by hand (B1): it starts, its yield lands in the inventory and it ends in one turn, so no look sees the step running. */
async function stepEndingBetweenLooks(clock: FakeClock, agent: Agent, runtime: FakeRuntime, step: Step, gained: { name: string; count: number }[]): Promise<void> {
  const inside = agent as unknown as { relations: AgentRelations; startStep(work: object, controller: AbortController, step: Step): void; endStep(work: object): void };
  const answers: string[] = [];
  const look = inside.relations.look.bind(inside.relations);
  inside.relations.look = (...args) => { const answer = look(...args); answers.push(answer); return answer; };
  const work = { step: null };
  inside.startStep(work, new AbortController(), step);
  await clockUntil(clock, () => answers.includes("ticked")); // a tick read the inventory before the yield landed
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, ...gained] };
  inside.endStep(work);
  answers.length = 0;
  await clock.advance(2_000, 2_000); // past the 2 s watch throttle of a window alone, in one slice: the look after it is the first one counted
  await clockUntil(clock, () => answers.includes("ticked"));
  await clockUntil(clock, () => !(inside.relations as unknown as { looking: boolean }).looking);
}

test("B1: what a finished step yielded is not kept as a talking player's early payment", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const lines: string[] = [];
  const { agent } = agentFor(t, runtime, {}, { log: (line) => lines.push(line) });
  (agent as unknown as { relations: AgentRelations }).relations.trades.heardLine("Theo", Date.now(), 2);
  await stepEndingBetweenLooks(clock, agent, runtime, { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, [{ name: "iron_ingot", count: 3 }]);
  assert.ok(!lines.some((line) => line.includes("picked up while a player talked")), lines.join("\n"));
}));

test("B1: a trade agreed after a step ended does not count the step's yield as their payment", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "agreed");
  await stepEndingBetweenLooks(clock, agent, runtime, { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, [{ name: "iron_ingot", count: 3 }]);
  assert.equal(heldTrade(agent)?.state, "agreed");
  assert.deepEqual(heldTrade(agent)?.received, []);
}));

test("B1: in the same tick a real payment of another item is credited and the step's yield is not", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them", get: [{ item: "iron_ingot", count: 5 }, { item: "oak_log", count: 2 }] } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot and 2 oak_log for your 5 bread, you after me?"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "agreed");
  await stepEndingBetweenLooks(clock, agent, runtime, { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, [{ name: "iron_ingot", count: 3 }, { name: "oak_log", count: 2 }]);
  assert.deepEqual(heldTrade(agent)?.received, [{ item: "oak_log", count: 2 }]);
}));

test("B1: the next look carries the yields of a step that ended since the last one, and the set is cleared once a look has seen them", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent } = agentFor(t, runtime);
  const inside = agent as unknown as { relations: AgentRelations; startStep(work: object, controller: AbortController, step: Step): void; endStep(work: object): void };
  const seen: string[][] = [];
  const look = inside.relations.look.bind(inside.relations);
  inside.relations.look = (yields, onStack, signal) => { seen.push([...yields]); return look(yields, onStack, signal); };
  const work = { step: null };
  inside.startStep(work, new AbortController(), { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] });
  inside.endStep(work);
  seen.length = 0;
  await clockUntil(clock, () => seen.length >= 3);
  assert.deepEqual(seen[0], ["iron_ingot"], "the first look after the step still knows its yield");
  assert.deepEqual(seen[2], [], "an idle look cleared the set");
}));

/** A relations tick the throttle lets through, run to its end (A2): returns once the tick that started has finished. */
function ticksOnce(clock: FakeClock, agent: Agent): { next(): Promise<void> } {
  const inside = agent as unknown as { relations: AgentRelations };
  const answers: string[] = [];
  const look = inside.relations.look.bind(inside.relations);
  inside.relations.look = (...args) => { const answer = look(...args); answers.push(answer); return answer; };
  return {
    async next(): Promise<void> {
      answers.length = 0;
      await clock.advance(2_000, 2_000); // past the 2 s watch throttle of a window alone, in one slice: the look after it is the first one counted
      await clockUntil(clock, () => answers.includes("ticked"));
      await clockUntil(clock, () => !(inside.relations as unknown as { looking: boolean }).looking);
    },
  };
}

test("A2: a sapling a step knocked loose and picked up after the first tick is not kept for the talking player; one tick later a gain is", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const lines: string[] = [];
  const { agent } = agentFor(t, runtime, {}, { log: (line) => lines.push(line) });
  const inside = agent as unknown as { relations: AgentRelations; startStep(work: object, controller: AbortController, step: Step): void; endStep(work: object): void };
  inside.relations.trades.heardLine("Theo", Date.now(), 2); // no trade owes saplings
  const ticks = ticksOnce(clock, agent);
  const work = { step: null };
  inside.startStep(work, new AbortController(), { skill: "collect_block", block: "oak_log", count: 3 });
  await ticks.next(); // the baseline, during the step
  inside.endStep(work);
  await ticks.next(); // the first tick past the step's end: nothing yet
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "oak_sapling", count: 1 }] };
  await ticks.next(); // the second: the sapling lands
  assert.ok(!lines.some((line) => line.includes("picked up while a player talked")), lines.join("\n"));
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "apple", count: 1 }] };
  await ticks.next(); // the third: the window is over
  assert.ok(lines.some((line) => line.includes("apple") && line.includes("picked up while a player talked")), lines.join("\n"));
}));

test("A2: a tick whose status() failed does not use up the window of a step's late gain", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const lines: string[] = [];
  const { agent } = agentFor(t, runtime, {}, { log: (line) => lines.push(line) });
  const inside = agent as unknown as { relations: AgentRelations; startStep(work: object, controller: AbortController, step: Step): void; endStep(work: object): void };
  inside.relations.trades.heardLine("Theo", Date.now(), 2);
  const ticks = ticksOnce(clock, agent);
  const work = { step: null };
  inside.startStep(work, new AbortController(), { skill: "collect_block", block: "oak_log", count: 3 });
  await ticks.next();
  inside.endStep(work);
  await ticks.next();
  const status = runtime.status.bind(runtime);
  runtime.status = () => Promise.reject(new Error("status down"));
  await ticks.next(); // fails before it counted: no baseline, no credit
  runtime.status = status;
  await ticks.next(); // sets the baseline again
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "oak_sapling", count: 1 }] };
  await ticks.next(); // the first counted tick after the failure: the window is still there
  assert.ok(!lines.some((line) => line.includes("picked up while a player talked")), lines.join("\n"));
}));

/** A trade agreed with Theo for these items, then a collect_block of oak_log started and ended by hand, the first tick after it seen (A2). */
async function tradeOwingThenStepEnded(clock: FakeClock, agent: Agent, chat: ReturnType<typeof agentFor>["chat"], get: { item: string; count: number }[]): Promise<void> {
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them", get } });
  await agent.handle(say("Theo", "Ayla, a deal for your 5 bread, you after me?"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "agreed");
  const inside = agent as unknown as { startStep(work: object, controller: AbortController, step: Step): void; endStep(work: object): void };
  const work = { step: null };
  inside.startStep(work, new AbortController(), { skill: "collect_block", block: "oak_log", count: 3 });
  await clock.advance(700);
  inside.endStep(work);
  await clock.advance(700);
}

test("A2: a trade that owes saplings is credited the sapling that lands after the bot's own step ended, as before", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  await tradeOwingThenStepEnded(clock, agent, chat, [{ item: "oak_sapling", count: 1 }]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "oak_sapling", count: 1 }] };
  await clockUntil(clock, () => heldTrade(agent)?.received.some((r) => r.item === "oak_sapling") === true);
  assert.notEqual(heldTrade(agent)?.state, "broken");
}));

test("A2: a partner's payment of the step's own target item that a trade owes is credited by a later tick, so the trade is not broken", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  await tradeOwingThenStepEnded(clock, agent, chat, [{ item: "oak_log", count: 2 }]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "oak_log", count: 2 }] };
  await clockUntil(clock, () => heldTrade(agent)?.received.some((r) => r.item === "oak_log" && r.count === 2) === true);
  assert.notEqual(heldTrade(agent)?.state, "broken");
}));

test("T4: a by-product of a step the step was not out to get is not kept as a talking player's early payment", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const lines: string[] = [];
  const { agent } = agentFor(t, runtime, {}, { log: (line) => lines.push(line) });
  (agent as unknown as { relations: AgentRelations }).relations.trades.heardLine("Theo", Date.now(), 2);
  await stepEndingBetweenLooks(clock, agent, runtime, { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] }, [{ name: "cobblestone", count: 8 }]);
  assert.ok(!lines.some((line) => line.includes("picked up while a player talked")), lines.join("\n"));
}));

test("T4: while a hand-off runs, and on the first look after it, the bot's gains are its own", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent } = agentFor(t, runtime);
  const inside = agent as unknown as { relations: AgentRelations; handoffStep(work: object, h: unknown): Promise<void> };
  const seen: (boolean | undefined)[] = [];
  const look = inside.relations.look.bind(inside.relations);
  inside.relations.look = (yields, onStack, signal, ownWork) => { seen.push(ownWork); return look(yields, onStack, signal, ownWork); };
  let release = (): void => undefined;
  inside.relations.runHandoff = () => new Promise((resolve) => { release = () => resolve({ outcome: "done", detail: "gave" }); });
  const work = { step: null, objective: {} };
  const running = inside.handoffStep(work, { kind: "give", tradeId: "x", partner: "Theo", items: [] });
  await clockUntil(clock, () => seen.includes(true));
  release();
  await clock.settle(running, 10_000);
  const after = (agent as unknown as { own: { active(): boolean } }).own.active();
  assert.equal(after, true, "the first look after the hand-off still counts its gains as own");
}));

const PROPOSE_VEX = { ...ORDER, trade: { action: "propose", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "me" } };

test("A1: a trade errand whose reply came after the partner walked out of reach is not taken: the order is checked on the world after the model call", onClock(async (clock, t) => {
  const { runtime, events, logs, agent, chat } = chatFromFarAgent(t, 10);
  chat.reply(PROPOSE_VEX, ORDER);
  const release = chat.hold();
  const handling = agent.handle(say("Vex", "Ayla, come to me and trade iron"));
  await clockUntil(clock, () => chat.requests.length === 1);
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 200, y: 64, z: 0 } }] };
  release();
  await clock.settle(handling, 10_000);
  await clock.advance(50);
  assert.ok(logs.some((line) => line.includes("trade refused: Vex is too far away to trade with (200 blocks away)")), logs.join("\n"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.some((line) => line.startsWith("not taken: Vex is too far away to trade with")), logs.join("\n"));
}));

test("A1: a payment tossed during the model call is credited by the next tick: the baseline of an accepted trade stays the bag before the call", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  const release = chat.hold();
  const handling = agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await clockUntil(clock, () => chat.requests.length === 1);
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  release();
  await clock.settle(handling, 10_000);
  await clockUntil(clock, () => heldTrade(agent)?.received.some((r) => r.item === "iron_ingot" && r.count === 5) === true);
  assert.notEqual(heldTrade(agent)?.state, "broken");
}));
