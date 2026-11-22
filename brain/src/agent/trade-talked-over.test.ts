// Tests of accepts talked over, hand-offs already given or broken meanwhile, and a payment-first wait.
import assert from "node:assert/strict";
import test from "node:test";
import type { BrainEvent } from "../brain-log.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { TradeBoard } from "../relations/board.ts";
import type { Handoff } from "../relations/handoff.ts";
import { until } from "../testing.ts";
import { agentFor, heardOnce, others, say, talkOptions, toAyla } from "./agent-fixtures.test.ts";
import { ACCEPT, ACCEPT_THEO, THEO_OFFER, moodyAgent, takenObjectives, tradingRuntime } from "./trade-fixtures.test.ts";

/** Ayla talking with the bot Theo, whose offer of 5 iron_ingot for 5 bread is on the board: his next line is held back in the model while he talks again, so her reply to it is talked over. */
async function talkedOverByTheo(t: Parameters<typeof agentFor>[0], reply: Record<string, unknown>, meanwhile: (board: TradeBoard) => void = () => undefined, speaker = "Theo") {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  const built = moodyAgent(t, runtime, 0, 0, {}, talkOptions({ tradeBoard: board, otherAgents: others(speaker) }));
  built.chat.reply({ ...toAyla, say: "Hi." });
  await built.agent.handle(say(speaker, "Ayla, got a minute?"));
  board.post({ ...THEO_OFFER, proposer: speaker, id: `${speaker}-Ayla-1` });
  const release = built.chat.hold();
  built.chat.reply(reply);
  const line = say(speaker, "Ayla, take the deal", false);
  const handling = built.agent.handle(line, heardOnce(line));
  await until(() => built.chat.requests.length === 2);
  (built.agent as unknown as { inbox: { push(message: ReturnType<typeof say>): void } }).inbox.push(say(speaker, "and quickly", false));
  meanwhile(board);
  release();
  await handling;
  const relations = (built.agent as unknown as { relations: AgentRelations }).relations;
  return { ...built, runtime, board, trades: relations.book.get(speaker)?.trades ?? [] };
}

test("a talked-over accept of a bot's offer is kept: the trade is agreed, the line is not spoken", async (t) => {
  const { runtime, logs, trades } = await talkedOverByTheo(t, ACCEPT_THEO);
  assert.deepEqual(trades.map((trade) => [trade.id, trade.state]), [["Theo-Ayla-1", "agreed"]]);
  assert.ok(logs.includes("  superseded: the line is dropped, its trade accept is kept"), logs.join("\n"));
  assert.deepEqual(runtime.said, ["Hi."]);
});

test("a talked-over accept restating the agreed trade while the bot's second offer stands opens no second trade", async (t) => {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  const { agent, chat, logs } = moodyAgent(t, runtime, 0, 0, {}, talkOptions({ tradeBoard: board, otherAgents: others("Theo") }));
  chat.reply({ ...toAyla, say: "Hi." });
  await agent.handle(say("Theo", "Ayla, got a minute?"));
  board.post(THEO_OFFER);
  chat.reply(ACCEPT_THEO);
  await agent.handle(say("Theo", "Ayla, take the deal", false));
  const relations = (agent as unknown as { relations: AgentRelations }).relations;
  await until(() => relations.book.trades().some((trade) => trade.state === "agreed"));
  // Theo posts the same offer again; his next line is talked over, and her accept of it restates the trade she already agreed.
  board.post({ ...THEO_OFFER, id: "Theo-Ayla-2", postedAt: 2 });
  const release = chat.hold();
  chat.reply(ACCEPT_THEO);
  const line = say("Theo", "Ayla, take it too", false);
  const handling = agent.handle(line, heardOnce(line));
  await until(() => chat.requests.length === 3);
  (agent as unknown as { inbox: { push(message: ReturnType<typeof say>): void } }).inbox.push(say("Theo", "and quickly", false));
  release();
  await handling;
  assert.ok(logs.some((entry) => entry.startsWith("  superseded:")), logs.join("\n"));
  assert.ok(logs.some((entry) => entry.includes("restates Theo-Ayla-1 (agreed)")), "the resend step took the trade off before the superseded path saw it");
  assert.deepEqual(relations.book.trades().map((trade) => [trade.id, trade.state]), [["Theo-Ayla-1", "agreed"]], "exactly one agreed trade");
});

test("a talked-over accept is refused when the offer was withdrawn or replaced meanwhile", async (t) => {
  const withdrawn = await talkedOverByTheo(t, ACCEPT_THEO, (board) => board.withdraw("Theo-Ayla-1"));
  assert.deepEqual(withdrawn.trades, []);
  const replaced = await talkedOverByTheo(t, ACCEPT_THEO, (board) => { board.withdraw("Theo-Ayla-1"); board.post({ ...THEO_OFFER, id: "Theo-Ayla-2", postedAt: 2 }); });
  assert.deepEqual(replaced.trades, []);
  assert.ok(!replaced.logs.some((line) => line.includes("is kept")), "the newer offer is read next, the old accept is not applied to it");
});

test("a talked-over decline of a bot's offer is kept; a propose is dropped", async (t) => {
  const declined = await talkedOverByTheo(t, { ...ACCEPT_THEO, trade: { ...ACCEPT.trade, action: "decline" } });
  assert.ok(declined.logs.includes("  superseded: the line is dropped, its trade decline is kept"), declined.logs.join("\n"));
  assert.equal(declined.board.offerFrom("Theo", "Ayla"), undefined, "the offer was declined");
  const proposed = await talkedOverByTheo(t, { ...ACCEPT_THEO, trade: { ...ACCEPT.trade, action: "propose" } });
  assert.deepEqual(proposed.trades, []);
});

test("a talked-over accept from a player is dropped as before", async (t) => {
  const runtime = tradingRuntime();
  const board = new TradeBoard();
  board.post(THEO_OFFER);
  const { agent, chat } = moodyAgent(t, runtime, 0, 0, {}, { tradeBoard: board });
  chat.reply(ACCEPT_THEO);
  const line = say("Theo", "Ayla, take the deal");
  (agent as unknown as { inbox: { push(message: ReturnType<typeof say>): void } }).inbox.push(say("Theo", "and quickly"));
  await agent.handle(line, heardOnce(line));
  assert.deepEqual((agent as unknown as { relations: AgentRelations }).relations.book.get("Theo")?.trades ?? [], []);
});

test("a hand-off already given ends done without a give and the previous objective resumes", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations; takeHandoff(h: Handoff): void };
  await until(() => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  const id = inside.relations.book.trades()[0]!.id;
  // The give was made by another objective while the hand-off was waiting on the stack.
  await inside.relations.trades.gaveOutside("Theo", "bread", 5);
  inside.takeHandoff({ kind: "give", tradeId: id, partner: "Theo", items: [{ item: "bread", count: 5 }] });
  await until(() => action.requests.length === 2, 4_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log/u, "the objective below takes its next step");
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"), "no give_item call");
  const finished = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("hand over") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(finished, [["done", "already handed over"]]);
});

test("a queued give for a trade broken meanwhile ends failed, naming the trade over, without a give, and the previous objective resumes (review 2026-10-24, 4)", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations; takeHandoff(h: Handoff): void };
  await until(() => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  const id = inside.relations.book.trades()[0]!.id;
  // The deadline broke the trade while the give waited behind a long order.
  await inside.relations.book.update("Theo", (r) => ({ ...r, trades: r.trades.map((trade) => ({ ...trade, state: "broken" as const })) }));
  inside.takeHandoff({ kind: "give", tradeId: id, partner: "Theo", items: [{ item: "bread", count: 5 }] });
  await until(() => action.requests.length === 2, 4_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log/u, "the objective below takes its next step");
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"), "no give_item call");
  const finished = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("hand over") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(finished, [["failed", "the trade with Theo is over (broken): nothing given"]]);
});

test("a queued give for a trade that ended done meanwhile (given outside the hand-off) ends done 'already handed over', never 'nothing given'", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations; takeHandoff(h: Handoff): void };
  await until(() => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  const id = inside.relations.book.trades()[0]!.id;
  // They paid, then another objective's give_item paid my side: the trade is done before the queued give runs.
  await inside.relations.book.update("Theo", (r) => ({ ...r, trades: r.trades.map((trade) => ({ ...trade, state: "done" as const, gaveAt: 1 })) }));
  inside.takeHandoff({ kind: "give", tradeId: id, partner: "Theo", items: [{ item: "bread", count: 5 }] });
  await until(() => action.requests.length === 2, 4_000);
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"), "no give_item call");
  const finished = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("hand over") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(finished, [["done", "already handed over"]]);
});

test("an agreed trade where they pay first sets the own objective aside for a wait; the payment ends it, the give follows and the objective resumes", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await until(() => takenObjectives(events).includes("own: wait for Theo to give their side (trade)"), 4_000);
  assert.ok(runtime.cancelled.length >= 1, "the own step was aborted for the wait");
  const finishedWait = () => events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("wait for Theo"));
  assert.equal(finishedWait(), false, "the wait runs while nothing arrives");
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
  await until(finishedWait, 4_000);
  const waits = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("wait for Theo") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(waits, [["done", "they gave"]]);
  await until(() => action.requests.length >= 2, 4_000);
  assert.match(action.requests.at(-1)?.[1]?.content ?? "", /collect 16 oak_log/u, "the own objective resumes after the wait");
});

test("a stop during the wait for their side drops it: the trade stays open and the wait is not on the stack", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await until(() => takenObjectives(events).includes("own: wait for Theo to give their side (trade)"), 4_000);
  const inside = agent as unknown as { relations: AgentRelations; stack: { objective: { handoff?: Handoff } }[] };
  chat.reply({ spoken_to: ["Ayla"], asks: "", language: "English", say: "Okay.", route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, stop that"));
  await until(() => inside.stack.every((work) => work.objective.handoff === undefined), 4_000);
  assert.equal(inside.relations.book.trades()[0]?.state, "agreed", "the trade stays open");
  assert.equal(inside.relations.trades.awaits(inside.relations.book.trades()[0]!.id), true);
});
