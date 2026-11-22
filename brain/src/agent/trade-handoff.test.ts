// Tests of the trade hand-off and of chat lines that carry a trade: work resumes after a hand-off, gifts, refused trades, relations off, a trade line takes no order.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrainEvent } from "../brain-log.ts";
import { FakeRuntime, movedClocks, testPersona, until } from "../testing.ts";
import { agentFor, bodyCalls, say, steveAt } from "./agent-fixtures.test.ts";
import { ACCEPT, MIN, savedRelations, takenObjectives, tradingRuntime } from "./trade-fixtures.test.ts";

test("work resumes after a trade hand-off", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await until(() => events.some((event) => event.kind === "trade" && event.event === "gave"), 4_000);
  const trade = savedRelations(runtime)[0]?.trades[0];
  assert.deepEqual([trade?.state, trade?.first], ["i_gave", "me"]);
  // I paid first: the agent waits for their side, which ends when Theo pays; then the earlier objective resumes.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => action.requests.length === 2, 4_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log/u, "the earlier objective's next step is asked for");
  assert.equal(runtime.cancelled.length, 1, "its running step was set aside for the give");
  assert.deepEqual(events.filter((event) => event.kind === "trade").map((event) => event.event).slice(0, 2), ["agreed", "gave"]);
  await until(() => agent.activity === "idle");
});

test("shelter keeps the trade due: a stop during the give drops the hand-off, the trade stays open and is given later, then broken at its deadline", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.drop_item = 100_000;
  const { agent, chat } = agentFor(t, runtime);
  const time = movedClocks(t);
  chat.reply(ACCEPT, { say: "Okay.", route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await agent.handle(say("Steve", "Ayla, stop"));
  await until(() => runtime.cancelled.length === 1);
  await sleep(100);
  assert.equal(agent.activity, "idle");
  assert.deepEqual([savedRelations(runtime)[0]?.trades[0]?.state, savedRelations(runtime)[0]?.trades[0]?.gaveAt], ["agreed", null], "the trade is still due");
  delete runtime.durations.drop_item;
  time.offset = 31_000;
  await sleep(300);
  assert.equal(savedRelations(runtime)[0]?.trades[0]?.state, "i_gave", "taken again later and given");
  time.offset += 11 * MIN;
  await sleep(300);
  const broken = savedRelations(runtime)[0]?.trades[0];
  assert.deepEqual([broken?.state, broken?.brokenBy], ["broken", "them"]);
  time.restore();
});

test("a player's give_item request outside a trade is unchanged, and keeps no relation", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  action.reply({ step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } }, { done: "Steve has 2 dirt" });
  await agent.handle(say("Steve", "could you give me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(bodyCalls(runtime), ["navigate", "drop_item"]);
  assert.deepEqual(savedRelations(runtime), []);
});

test("a trade the checks refuse goes back to the chat tier once with the reason and is then not made", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  const unaffordable = { ...ACCEPT, say: "Deal, all my iron!", trade: { ...ACCEPT.trade, give: [{ item: "iron_ingot", count: 5 }], get: [{ item: "bread", count: 1 }] } };
  chat.reply(unaffordable, { ...ACCEPT, say: "Sorry, I have none.", trade: undefined });
  await agent.handle(say("Theo", "Ayla, bread for iron?"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 2);
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Your relations:\nHow you feel about someone shows[^\n]*\nYou have not dealt with Theo before;/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /you carry 0 iron_ingot, not 5/u);
  assert.deepEqual(runtime.said, ["Sorry, I have none."]);
  assert.deepEqual(savedRelations(runtime), []);
});

test("relations off: no relation block, no trade paragraph, no trade", async (t) => {
  const runtime = tradingRuntime();
  const persona = testPersona();
  const { agent, chat } = agentFor(t, runtime, { settings: { ...persona.settings, relations: { ...persona.settings.relations, enabled: false } } });
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.said.length === 1);
  assert.doesNotMatch(chat.requests[0]?.[0]?.content ?? "", /"trade"/u);
  assert.doesNotMatch(chat.requests[0]?.[1]?.content ?? "", /Your relations/u);
  await sleep(100);
  assert.deepEqual(bodyCalls(runtime), []);
  assert.deepEqual(savedRelations(runtime), []);
});

const TRADE_AND_ORDER = { ...ACCEPT, route: "act", request: "give Theo 5 bread" };

test("a trade line routed act takes no order", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply(TRADE_AND_ORDER);
  await agent.handle(say("Theo", "Ayla, give me 5 bread, I pay 5 iron_ingot right after"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  // I paid first: the agent now waits for their side, which ends when Theo pays.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => agent.activity === "idle", 4_000);
  assert.deepEqual(takenObjectives(events), ["own: hand over 5 bread to Theo (trade)", "own: wait for Theo to give their side (trade)"], "the give, then the wait for Theo");
});

// Plan 2026-11-07-gift-asked-for Task A (s3q 2026-11-07): a player asks for a gift and the model answers with a gift proposal.
const GIFT_ASKED = { say: "Of course!", route: "act" as const, request: "give me one bread", trade: { action: "propose" as const, give: [{ item: "bread", count: 1 }], get: [], first: "me" as const } };
const GIVE_ONE_BREAD = ["own: hand over 1 bread to Theo (trade)"];

test("A8: a player's ask for a gift, answered with a gift proposal routed act, is handed over (s3q case)", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const logs: string[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event), log: (line) => logs.push(line) });
  chat.reply(GIFT_ASKED);
  await agent.handle(say("Theo", "Ayla, could you give me one bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), GIVE_ONE_BREAD);
  assert.ok(!logs.some((line) => line.startsWith("not taken:")), logs.join("\n"));
});

test("A8b: the same gift answered with a later route (another player's order runs) is agreed: its give waits below the order", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  // "later" is a route only while the character works for someone else (llm-mind.ts: canWait), so an order runs first.
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...GIFT_ASKED, route: "later" });
  await agent.handle(say("Theo", "Ayla, could you give me one bread?"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "queued" && event.text === "hand over 1 bread to Theo (trade)"));
  // A hand-off exists only for an agreed trade: the queued give is the proof that the gift was agreed on this line.
  assert.deepEqual(takenObjectives(events), ["Steve: collect 16 oak_log"]);
  assert.equal(runtime.cancelled.length, 0, "the order's step runs on");
});

test("A8c: the same gift offered unasked (route talk) stays a proposal and gives nothing", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply({ ...GIFT_ASKED, route: "talk", request: "" });
  await agent.handle(say("Theo", "Ayla, I am hungry"));
  await until(() => events.some((event) => event.kind === "chat") && savedRelations(runtime)[0]?.trades[0]?.state === "proposed");
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("A8d: a stop carrying a request with an asked gift keeps the gift's give, idle or busy (spec D4)", async (t) => {
  for (const busy of [false, true]) {
    const runtime = tradingRuntime();
    runtime.durations.collect_block = 1_500;
    const events: BrainEvent[] = [];
    const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
    if (busy) {
      chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
      action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
      await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
      await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
    }
    chat.reply({ ...GIFT_ASKED, say: "Sure.", route: "stop" });
    await agent.handle(say("Theo", "Ayla, stop, and give me one bread"));
    // Busy: Steve's order is not Theo's to stop, so the give waits below it and runs when it ends (about 1.5 s).
    await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
    if (!busy) assert.deepEqual(takenObjectives(events), GIVE_ONE_BREAD);
  }
});

test("a later route with a trade takes no order", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  // "later" is a route only while the character works for someone else.
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...TRADE_AND_ORDER, route: "later" });
  await agent.handle(say("Theo", "Ayla, give me 5 bread, I pay 5 iron_ingot right after"));
  // Q1 (2026-10-24): the give waits below the player's order instead of interrupting it.
  await until(() => events.some((event) => event.kind === "objective" && event.event === "queued" && event.text === "hand over 5 bread to Theo (trade)"));
  assert.deepEqual(takenObjectives(events), ["Steve: collect 16 oak_log"]);
  assert.equal(runtime.cancelled.length, 0, "the order's step runs on");
});

test("a decline with act takes no order: the line carried a trade and none came of it", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply({ ...TRADE_AND_ORDER, trade: { action: "decline", give: [], get: [], first: "me" } });
  await agent.handle(say("Theo", "Ayla, never mind the trade, just give me 5 bread"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("a stop with a trade still stops", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, stop that, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.cancelled.length >= 1);
  assert.ok(!takenObjectives(events).some((line) => line.startsWith("Theo:")), "a stop takes no order");
});
