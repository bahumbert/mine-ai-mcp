// Tests of orders a roll or an open trade refuses: mood rolls, orders during a trade not taken, the line re-stating the agreed trade.
import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { TradeBoard } from "../relations/board.ts";
import { testPersona, until } from "../testing.ts";
import { others, say, talkOptions, toAyla } from "./agent-fixtures.test.ts";
import { ACCEPT, ACCEPT_THEO, BUILD_ORDER, duringTrade, GIVE_STEPS, moodyAgent, PREFS, savedRelations, takenObjectives, THEO_OFFER, tradingRuntime, withAgreedTrade } from "./trade-fixtures.test.ts";

const GIVE_ORDER = { say: "Fine.", route: "act", request: "give Theo 5 bread" };

test("an order the roll turns down is not taken: the model is told before it answers, the log has the chance and the request", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, logs, events } = moodyAgent(t, runtime, -8, 0.5);
  chat.reply(GIVE_ORDER);
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  assert.match(chat.requests[0]?.[1]?.content ?? "", /You don't feel like doing what Theo asks right now \(you rate them -8\)\./u);
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes("not taken: Theo rated -8, chance 27 %, rolled no (\"give Theo 5 bread\")"), logs.join("\n"));
  assert.deepEqual(runtime.said, ["Fine."], "the spoken line stays");
});

test("an order the roll lets through is taken, and the model is told nothing", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, action, events } = moodyAgent(t, runtime, -8, 0.1);
  chat.reply(GIVE_ORDER);
  action.reply(...GIVE_STEPS);
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.doesNotMatch(chat.requests[0]?.[1]?.content ?? "", /You don't feel like/u);
  assert.deepEqual(takenObjectives(events), ["Theo: give Theo 5 bread"]);
});

test("three identical orders from a refused speaker: one roll, three 'not taken', the own work goes on", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner, logs, events, rolled } = moodyAgent(t, runtime, -8, 0.5, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply(GIVE_ORDER, GIVE_ORDER, GIVE_ORDER);
  for (let i = 0; i < 3; i++) await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  assert.equal(logs.filter((line) => line.startsWith("not taken: Theo rated -8")).length, 3);
  assert.equal(rolled.count, 1, "repeating the request does not roll again");
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(events.some((event) => event.kind === "objective" && event.event === "own" && event.text === "collect 16 oak_log"), "the own objective started");
  assert.equal(runtime.cancelled.length, 0, "the own step runs on");
});

test("a later order refused by the roll is not queued behind the order being worked", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  // Steve's roll lets him through (0.1 < 27 %), Theo's does not.
  const { agent, chat, action, events } = moodyAgent(t, runtime, -8, [0.1, 0.5]);
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Later.", route: "later", request: "give Theo 5 bread" });
  await agent.handle(say("Theo", "Ayla, give me 5 bread when you can"));
  assert.deepEqual(takenObjectives(events), ["Steve: collect 16 oak_log"]);
  assert.ok(!events.some((event) => event.kind === "objective" && event.event === "queued"), "not queued either");
});

test("a stop with a request from a refused speaker still stops, and the request is not taken", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner, events, logs } = moodyAgent(t, runtime, -8, 0.5, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Stopping.", route: "stop", request: "give Theo 5 bread" });
  await agent.handle(say("Theo", "Ayla, stop and give me 5 bread"));
  await until(() => runtime.cancelled.length >= 1);
  assert.ok(!takenObjectives(events).some((line) => line.startsWith("Theo:")));
  assert.ok(logs.some((line) => line.startsWith("not taken: Theo rated -8")));
});

test("with relations off the order is taken as before: no roll, no mood line", async (t) => {
  const runtime = tradingRuntime();
  const { settings } = testPersona();
  const { agent, chat, action, events, rolled } = moodyAgent(t, runtime, -8, 0.99, { settings: { ...settings, relations: { ...settings.relations, enabled: false } } });
  chat.reply(GIVE_ORDER);
  action.reply(...GIVE_STEPS);
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual([takenObjectives(events), rolled.count], [["Theo: give Theo 5 bread"], 0]);
});

test("an order from a speaker whose offer is on the board is not taken, whatever the line's work; taken again once the offer is gone", async (t) => {
  // s3h: Theo's line had no trade, no purpose, and only Ayla's proposal on the board; he gave 18 cobblestone outside the trade.
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  board.post(THEO_OFFER);
  const { agent, chat, action, events, logs } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS }, { tradeBoard: board });
  chat.reply({ ...GIVE_ORDER, work: "none" }, { ...GIVE_ORDER, work: "none" });
  action.reply(...GIVE_STEPS);
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes("not taken: Theo and I have trade Theo-Ayla-1 open; its hand-off is how items move (\"give Theo 5 bread\")"), logs.join("\n"));
  board.withdraw("Theo-Ayla-1");
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), ["Theo: give Theo 5 bread"]);
});

test("an order from a speaker with an open trade of mine is not taken", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, logs, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  chat.reply({ ...ACCEPT, route: "talk", trade: { ...ACCEPT.trade, action: "propose", first: "them" } }, { ...GIVE_ORDER, work: "none" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "proposed");
  await agent.handle(say("Theo", "Ayla, give me 5 bread now"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.some((line) => line.startsWith("not taken: Theo and I have trade ")), logs.join("\n"));
});

test("an order from a speaker is taken again once my trade with them ended", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, action, events } = moodyAgent(t, runtime, 0, 0);
  chat.reply({ ...ACCEPT, route: "talk", trade: { ...ACCEPT.trade, action: "propose", first: "them" } }, GIVE_ORDER, { ...ACCEPT, route: "talk", trade: { ...ACCEPT.trade, action: "cancel" } }, GIVE_ORDER);
  action.reply(...GIVE_STEPS);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "proposed");
  await agent.handle(say("Theo", "Ayla, give me 5 bread now"));
  await agent.handle(say("Theo", "Ayla, forget the trade"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "cancelled");
  await agent.handle(say("Theo", "Ayla, give me 5 bread now"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), ["Theo: give Theo 5 bread"]);
});

test("an accept decided on the main path closes only the offer it read: replaced while the model thought, it is refused", async (t) => {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  const built = moodyAgent(t, runtime, 0, 0, {}, talkOptions({ tradeBoard: board, otherAgents: others("Theo") }));
  built.chat.reply({ ...toAyla, say: "Hi." });
  await built.agent.handle(say("Theo", "Ayla, got a minute?"));
  board.post(THEO_OFFER);
  const release = built.chat.hold();
  built.chat.reply(ACCEPT_THEO);
  const handling = built.agent.handle(say("Theo", "Ayla, take the deal", false));
  await until(() => built.chat.requests.length === 2);
  board.withdraw("Theo-Ayla-1");
  board.post({ ...THEO_OFFER, id: "Theo-Ayla-2", postedAt: 2 });
  release();
  await handling;
  assert.deepEqual((built.agent as unknown as { relations: AgentRelations }).relations.book.get("Theo")?.trades ?? [], []);
  assert.ok(built.logs.some((line) => line.includes("offer changed since I read it (Theo-Ayla-1 -> Theo-Ayla-2)")), built.logs.join("\n"));
});

test("an order whose trade the checks dropped is not taken (the line's trade came to nothing)", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, logs, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  // 50 bread are offered, 10 carried: the checks refuse the proposal, and again when the model restates it.
  const unaffordable = { ...GIVE_ORDER, work: "none", trade: { action: "propose", give: [{ item: "bread", count: 50 }], get: [{ item: "iron_ingot", count: 5 }], first: "me" } };
  chat.reply(unaffordable, unaffordable);
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes("not taken: the line's trade with Theo came to nothing (\"give Theo 5 bread\")"), logs.join("\n"));
});

const NOT_TAKEN_OPEN = (request: string) => `not taken: Theo and I have trade Theo-Ayla-1 open; its hand-off is how items move (${JSON.stringify(request)})`;

test("a narration of the partner's act is not taken during a trade", async (t) => {
  const { agent, chat, events, logs } = duringTrade(t);
  chat.reply({ say: "Fine.", route: "act", request: "Ayla gives Lena bread", work: "none" });
  await agent.handle(say("Theo", "Ayla gives Lena bread"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes(NOT_TAKEN_OPEN("Ayla gives Lena bread")), logs.join("\n"));
});

test("a trade errand during a trade is not taken", async (t) => {
  const { agent, chat, events, logs } = duringTrade(t);
  chat.reply({ say: "Fine.", route: "act", request: "trade with Lena", work: "trading" });
  await agent.handle(say("Theo", "Ayla, go trade with Lena"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes(NOT_TAKEN_OPEN("trade with Lena")), logs.join("\n"));
});

test("an order with no work during a trade is not taken: a persona with no preferences keeps the refusal", async (t) => {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  board.post(THEO_OFFER);
  const { agent, chat, events, logs } = moodyAgent(t, runtime, 0, 0, {}, { tradeBoard: board });
  chat.reply(BUILD_ORDER);
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes(NOT_TAKEN_OPEN(BUILD_ORDER.request)), logs.join("\n"));
});

test("s3s: a build order whose line re-states the agreed trade is taken during the trade, with no mark", async (t) => {
  const { agent, chat, action, events, logs, id } = await withAgreedTrade(t);
  // One reply for the build line: its accept re-states the agreed trade, so nothing is sent back.
  chat.reply({ ...ACCEPT_THEO, ...BUILD_ORDER });
  action.reply({ give_up: "test" });
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  assert.ok(takenObjectives(events).includes("Theo: build a small shelter right here first"), takenObjectives(events).join("\n"));
  assert.ok(logs.some((line) => line.startsWith(`taken during trade ${id} with Theo`)), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("came to nothing")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("not taken:")), logs.join("\n"));
  const taken = events.find((event) => event.kind === "objective" && event.event === "taken" && event.requester === "Theo");
  assert.equal(taken?.kind === "objective" && taken.duringTrade, id, "the journal says which trade it was let through");
  assert.equal(chat.requests.length, 2, "one chat call per line");
});

test("a give order whose line re-states the agreed trade is refused with the open-trade line", async (t) => {
  const { agent, chat, events, logs, id } = await withAgreedTrade(t);
  chat.reply({ ...ACCEPT_THEO, ...GIVE_ORDER, work: "none" });
  await agent.handle(say("Theo", "Ayla, give me 5 bread"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes(`not taken: Theo and I have trade ${id} open; its hand-off is how items move (${JSON.stringify(GIVE_ORDER.request)})`), logs.join("\n"));
  assert.ok(!logs.some((line) => line.includes("came to nothing")), logs.join("\n"));
});

test("a talk line re-stating the agreed trade leaves the trade as it is", async (t) => {
  const { agent, chat, relations, id } = await withAgreedTrade(t);
  chat.reply({ ...ACCEPT_THEO, route: "talk" });
  await agent.handle(say("Theo", "Ayla, remember, 5 iron_ingot for your 5 bread"));
  assert.deepEqual(relations.book.trades().map((trade) => [trade.id, trade.state]), [[id, "agreed"]]);
  assert.equal(chat.requests.length, 2, "one chat call for that line");
});
