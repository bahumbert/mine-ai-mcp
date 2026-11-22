// Tests of the trading routine: an objective that trades, refusals pausing trading, retaken hand-offs, two bots of one brain, the share of time spent trading.
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../agent.ts";
import type { BrainEvent } from "../brain-log.ts";
import { ConversationBudget, type ConversationController } from "../conversation/controller.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { TradeBoard } from "../relations/board.ts";
import type { TradeAsks } from "../relations/trading.ts";
import { FakeRuntime } from "../testing.ts";
import { agentFor, clockUntil, onClock, others, say, talkOptions } from "./agent-fixtures.test.ts";
import { ACCEPT, failedIronObjective, MIN, savedRelations, tradingRuntime } from "./trade-fixtures.test.ts";

test("a failed own get_items objective draws trading and shows the trade-needs line to the next goal call", onClock(async (clock, t) => {
  const { planner } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await clockUntil(clock, () => planner.requests.length >= 2);
  const prompt = JSON.stringify(planner.requests[1]);
  assert.match(prompt, /feel most like [^.]*trading items with someone/u);
  assert.match(prompt, /trade for iron_ingot you could not get: ask Theo what they would want for it \(you carry 10 bread\)/u);
}));

test("without anyone to trade with, a failed objective draws no trading", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const built = agentFor(t, runtime, { goal: "Forge an iron kit." }, { random: () => 0 });
  built.planner.reply({ objective: "get 3 iron_ingot" });
  built.action.reply({ step: { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] } }, { give_up: "no iron anywhere near" });
  built.planner.reply({ objective: "gather wood" });
  await clockUntil(clock, () => built.planner.requests.length >= 2);
  assert.doesNotMatch(JSON.stringify(built.planner.requests[1]), /trading items with someone|trade for/u);
}));

test("a trading objective runs the routine: no work-tier call, a trade step in the journal, done on an agreed trade", onClock(async (clock, t) => {
  const { runtime, events, agent, chat, action, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for 5 iron ingots", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" }, ACCEPT, { gist: "Agreed bread for iron." }, { gist: "Agreed bread for iron." });
  await clockUntil(clock, () => agent.conversation?.kind === "social");
  assert.equal(action.requests.length, 2, "the trading objective asked the work tier nothing");
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  // The hand-off sets the routine aside; it resumes with the talk still on and follows until the talk ends.
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "drop_item"));
  await clock.advance(100);
  // I paid first: the hand-off is followed by a wait for their side, which ends when Theo pays.
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }], inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  (agent as unknown as { talks: ConversationController }).talks.end("out_of_range");
  await clockUntil(clock, () => events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo") && event.outcome === "done"));
  const rows = events.filter((event) => event.kind === "step" && event.objective.startsWith("trade Theo"));
  const row = rows.at(-1);
  assert.equal(rows.length, 1, "F9: set aside for the hand-off, then ended done on resume: no second trade step");
  assert.deepEqual(row?.kind === "step" && row.input, { skill: "trade", partner: "Theo" });
  const finished = events.find((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo"));
  assert.match(String(finished?.kind === "objective" && finished.detail), /^agreed with Theo: 5 bread for 5 iron_ingot/u);
  assert.equal(action.requests.length, 2);
  assert.ok(runtime.submitted.some((call) => call.tool === "drop_item"), "the hand-off ran");
}));

test("a goal reply \"for\": \"trading iron_ingot\" runs the trade routine, not a work-tier step", onClock(async (clock, t) => {
  const { agent, action, planner, chat } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo to trade me 3 iron_ingot for some of my bread", for: "trading iron_ingot" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" });
  await clockUntil(clock, () => agent.conversation?.kind === "social");
  assert.equal(action.requests.length, 2, "the objective asked the work tier nothing");
}));

test("a trading objective that ends refused is not asked again: the next goal call is not a trade ask to that partner", onClock(async (clock, t) => {
  const { events, agent, chat, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for 3 iron ingots", for: "trading" }, { objective: "gather wood" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, want to swap for iron?" }, { gist: "He said no." });
  await clockUntil(clock, () => agent.conversation?.kind === "social");
  (agent as unknown as { talks: ConversationController }).talks.end("out_of_range");
  await clockUntil(clock, () => planner.requests.length >= 3);
  assert.ok(events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo") && event.outcome === "failed"));
  const situation = planner.requests[2]?.[1]?.content ?? "";
  assert.doesNotMatch(situation, /feel most like.*trading|trade for iron_ingot/u);
}));

test("F7: a trading objective naming only carried items asks Theo for the need instead of failing 'already carry'", onClock(async (clock, t) => {
  const { events, agent, action, planner, chat } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo to trade me 1 bread for some of my bread", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" });
  await clockUntil(clock, () => agent.conversation?.kind === "social");
  assert.equal(action.requests.length, 2, "the routine ran: no work-tier call");
  assert.ok(!events.some((event) => event.kind === "objective" && event.event === "finished" && /already carry/u.test(event.detail ?? "")));
  assert.ok((agent as unknown as { asks: TradeAsks }).asks.needs.current(monotonicNow(), []).includes("iron_ingot"));
}));

test("F7: a second trading objective that fails before any ask pauses trading: the next goal call draws none though a need is set, until a new need", onClock(async (clock, t) => {
  const { events, agent, planner } = await failedIronObjective(t);
  const asks = (agent as unknown as { asks: TradeAsks }).asks;
  await clockUntil(clock, () => planner.requests.length >= 2);
  asks.failedFast(monotonicNow() - 60_000);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u, "one fast failure: trading is still drawn");
  // The need is gone when the objective is planned (the memory ran out): "already carry bread" fails at once.
  asks.needs.drop("iron_ingot");
  planner.reply({ objective: "ask Theo to trade me bread", for: "trading" });
  await clockUntil(clock, () => events.some((event) => event.kind === "objective" && event.event === "finished" && /already carry bread/u.test(event.detail ?? "")));
  await clockUntil(clock, () => planner.requests.length >= 3);
  assert.equal(asks.paused(monotonicNow()), true);
  asks.needs.set(["iron_ingot"], monotonicNow());
  planner.reply({ objective: "gather wood" });
  await clockUntil(clock, () => planner.requests.length >= 4);
  assert.doesNotMatch(JSON.stringify(planner.requests[3]), /trading items with someone|trade for/u, "paused: no trading though a need is set");
  asks.failed(["bucket"], [], monotonicNow());
  assert.equal(asks.paused(monotonicNow()), false, "a new need ends the pause");
}));

test("an order during a trading objective aborts the routine and runs", onClock(async (clock, t) => {
  const { agent, chat, action, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for iron ingots", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "long", say: "Theo! Walk with me?" }, { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true }, { gist: "An order came." });
  action.reply({ done: "got the dirt" });
  await clockUntil(clock, () => agent.conversation?.kind === "social");
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await clockUntil(clock, () => action.requests.length >= 3);
  assert.match(action.requests[2]?.[1]?.content ?? "", /Objective \(asked by Steve\): "collect 5 dirt"/u);
}));

test("every partner refused lately: the next goal call draws no trading, though a need is set", onClock(async (clock, t) => {
  const { agent, planner } = await failedIronObjective(t);
  (agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], monotonicNow() - 60_000);
  planner.reply({ objective: "gather wood" });
  await clockUntil(clock, () => planner.requests.length >= 2);
  assert.doesNotMatch(JSON.stringify(planner.requests[1]), /trading items with someone|trade for/u);
}));

test("one partner of two refused lately: trading is still drawn for the other", onClock(async (clock, t) => {
  const { agent, planner } = await failedIronObjective(t, { otherAgents: others("Theo", "Bruno") }, 30, [{ username: "Bruno", position: { x: 20, y: 64, z: 0 } }]);
  (agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], monotonicNow() - 60_000);
  planner.reply({ objective: "ask Bruno for iron", for: "trading" });
  await clockUntil(clock, () => planner.requests.length >= 2);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u);
}));

test("a refusal older than 10 minutes, or a miss that is not yet a refusal, leaves trading drawn", onClock(async (clock, t) => {
  const old = await failedIronObjective(t);
  (old.agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], monotonicNow() - 10 * 60_000 - 1);
  old.planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await clockUntil(clock, () => old.planner.requests.length >= 2);
  assert.match(JSON.stringify(old.planner.requests[1]), /trading items with someone/u);
  const missed = await failedIronObjective(t);
  (missed.agent as unknown as { asks: TradeAsks }).asks.refused.missed("Theo", ["bread"], monotonicNow());
  missed.planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await clockUntil(clock, () => missed.planner.requests.length >= 2);
  assert.match(JSON.stringify(missed.planner.requests[1]), /trading items with someone/u);
}));

test("a hand-off the partner did not take is retaken and done once the partner takes it (s1d, bug A)", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "bread", count: 5 }];
  runtime.dropOutcomes.push(
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0 } },
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: true, collectedCount: 5 } },
  );
  const { agent, chat } = agentFor(t, runtime);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "pick_up_items"));
  await clock.advance(200);
  assert.equal(savedRelations(runtime)[0]?.trades[0]?.state, "agreed", "not taken: the trade is still due, no gave row");
  await clock.advance(31_000);
  await clockUntil(clock, () => savedRelations(runtime)[0]?.trades[0]?.state === "i_gave");
  assert.equal(runtime.submitted.filter((call) => call.tool === "drop_item").length, 2);
}));

test("a partly taken hand-off credits the taken part: the retake gives only what is left", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "bread", count: 3 }];
  runtime.dropOutcomes.push(
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 2 } },
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 3 }], recipient: { collected: true, collectedCount: 3 } },
  );
  const { agent, chat } = agentFor(t, runtime);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "pick_up_items"));
  await clock.advance(200);
  await clock.advance(31_000);
  await clockUntil(clock, () => savedRelations(runtime)[0]?.trades[0]?.state === "i_gave");
  const counts = runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => (call.input.items as { count: number }[])[0]?.count);
  assert.deepEqual(counts, [5, 3]);
}));

test("an outside give_item the partner did not pick up is not counted toward the trade (s1d, bug A)", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0 } });
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } }, { say: "Sure.", route: "act", request: "give Theo 5 bread" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations };
  await clockUntil(clock, () => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  action.reply({ step: { skill: "give_item", player: "Theo", item: "bread", count: 5 } }, { done: "left it" });
  await agent.handle(say("Steve", "Ayla, give Theo 5 bread"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "drop_item"));
  await clock.advance(300);
  assert.equal(inside.relations.book.trades()[0]?.gaveAt, null, "left at the feet, never taken: not a give");
  assert.deepEqual(inside.relations.trades.leftToGive(inside.relations.book.trades()[0]!.id), [{ item: "bread", count: 5 }]);
}));

const sideOf = (item: string, count: number) => [{ item, count }];

/** Moves what one runtime drops to a named player into the other's inventory, and relays each line one says to the other. */
function linkAgents(a: { name: string; runtime: FakeRuntime; agent: Agent }, b: { name: string; runtime: FakeRuntime; agent: Agent }, t: { after(fn: () => Promise<void>): void }): void {
  const seen = new Map<FakeRuntime, number>();
  const move = (from: typeof a, to: typeof b): void => {
    const calls = from.runtime.submitted;
    for (let i = seen.get(from.runtime) ?? 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (call.tool === "send_message") void to.agent.handle(say(from.name, String(call.input.message)));
      if (call.tool !== "drop_item") continue;
      for (const { item_name: item, count } of call.input.items as { item_name: string; count: number }[]) {
        const give = (inventory: readonly { name: string; count: number }[], by: number) => [...inventory.filter((s) => s.name !== item), { name: item, count: (inventory.find((s) => s.name === item)?.count ?? 0) + by }];
        from.runtime.snapshot = { ...from.runtime.snapshot, inventory: give(from.runtime.snapshot.inventory, -count) };
        to.runtime.snapshot = { ...to.runtime.snapshot, inventory: give(to.runtime.snapshot.inventory, count) };
      }
    }
    seen.set(from.runtime, calls.length);
  };
  const timer = setInterval(() => { move(a, b); move(b, a); }, 10);
  t.after(async () => clearInterval(timer));
}

test("two bots of one brain: the trading routine waits for its turn, opens, and both records hold the proposer's terms and reach done", onClock(async (clock, t) => {
  const budget = new ConversationBudget(1);
  budget.tryTake();
  const board = new TradeBoard();
  const aylaLog: string[] = [];
  const ayla = await failedIronObjective(t, { tradeBoard: board, conversations: { budget, modelFree: () => true }, random: () => 1, log: (line) => aylaLog.push(line) });
  ayla.runtime.snapshot = { ...ayla.runtime.snapshot, players: [{ username: "Theo", position: { x: 3, y: 64, z: 0 } }] };
  const theoRuntime = new FakeRuntime();
  theoRuntime.snapshot = { ...theoRuntime.snapshot, inventory: [{ name: "iron_ingot", count: 10 }], players: [{ username: "Ayla", position: { x: 3, y: 64, z: 0 } }] };
  const theo = agentFor(t, theoRuntime, { id: "theo", username: "Theo" }, talkOptions({ tradeBoard: board, conversations: { budget, modelFree: () => true }, otherAgents: others("Ayla"), random: () => 1 }));
  linkAgents({ name: "Ayla", runtime: ayla.runtime, agent: ayla.agent }, { name: "Theo", runtime: theoRuntime, agent: theo.agent }, t);
  const words = { spoken_to: ["Ayla"], asks: "", language: "English", route: "talk", request: "" };
  ayla.planner.reply({ objective: "trade Theo for 4 iron ingots", for: "trading" });
  ayla.chat.reply(
    { open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" },
    { ...words, spoken_to: ["Theo"], say: "Theo, 4 iron_ingot for 4 bread?", trade: { action: "propose", give: sideOf("bread", 4), get: sideOf("iron_ingot", 4), first: "me" } },
    { gist: "Agreed bread for iron." }, { gist: "Agreed bread for iron." },
  );
  theo.chat.reply(
    { ...words, say: "What would you give?" },
    { ...words, say: "Deal.", trade: { action: "accept", give: sideOf("iron_ingot", 1), get: sideOf("bread", 1), first: "them" } },
    { gist: "Agreed iron for bread." }, { gist: "Agreed iron for bread." },
  );
  // The toss Theo takes, as a runtime that names its recipient answers (a toss that names none is unconfirmed for a partner of this brain).
  ayla.runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 4 }], recipient: { collected: true, collectedCount: 4, settled: true } });
  theoRuntime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "iron_ingot", dropped: 4 }], recipient: { collected: true, collectedCount: 4, settled: true } });
  await clockUntil(clock, () => aylaLog.some((line) => line === "trading: trade with Theo"));
  await clock.advance(150);
  assert.equal(ayla.agent.conversation, null, "the cap is full: the routine waits, no talk yet");
  assert.ok(!ayla.events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo")), "the trade objective is still waiting for its turn, not failed");
  budget.give();
  const trades = (runtime: FakeRuntime, partner: string) => savedRelations(runtime).find((r) => r.partner === partner)?.trades[0];
  await clockUntil(clock, () => trades(theoRuntime, "Ayla")?.state === "done" && trades(ayla.runtime, "Theo")?.state === "done");
  const [mine, theirs] = [trades(ayla.runtime, "Theo")!, trades(theoRuntime, "Ayla")!];
  assert.equal(mine.id, theirs.id, "one trade, one id");
  assert.deepEqual([mine.give, mine.get, theirs.give, theirs.get], [sideOf("bread", 4), sideOf("iron_ingot", 4), sideOf("iron_ingot", 4), sideOf("bread", 4)], "Ayla's terms on both sides");
}));

type ShareInside = { startedAt: number; memory: { times: { activity: string; purpose: string; ended: string; minutes: number }[] } };
/** The agent has been up `sinceStart` minutes and spent `minutes` of them on trading steps that ended `endedAgo` minutes ago. */
function tradedFor(agent: Agent, sinceStart: number, minutes: number, endedAgo = 0): void {
  const inside = agent as unknown as ShareInside;
  inside.startedAt = Date.now() - sinceStart * MIN;
  inside.memory.times.push({ activity: "trading", purpose: "trading", ended: new Date(Date.now() - endedAgo * MIN).toISOString(), minutes });
}
const ownDrawn = (events: BrainEvent[]) => events.flatMap((event) => (event.kind === "objective" && event.event === "own" ? [event.drawn ?? []] : []));

test("F9: 16 min of trading in the 30 min since the start: the next goal call draws no trading though a need is set; time passing without trading brings it back", onClock(async (clock, t) => {
  const { events, agent, planner } = await failedIronObjective(t);
  tradedFor(agent, 30, 16);
  planner.reply({ objective: "gather wood" });
  await clockUntil(clock, () => planner.requests.length >= 2);
  assert.doesNotMatch(String(planner.requests[1]?.[1]?.content), /feel most like[^.]*trading|trade for/u);
  assert.ok(ownDrawn(events).every((drawn) => !drawn.includes("trading")), "the journal's drawn has no trading");
  // Edge 4: the wall clock moves, no step runs; the trading minutes fall out of the hour.
  clock.stepWallClock(61 * MIN);
  (agent as unknown as { asks: TradeAsks }).asks.needs.set(["iron_ingot"], monotonicNow());
  planner.reply({ objective: "gather wood again" });
  await clockUntil(clock, () => planner.requests.length >= 3);
  assert.match(String(planner.requests[2]?.[1]?.content), /feel most like[^.]*trading/u, "trading capped, then drawn again");
}));

test("F9: 3 min after the start, all of it trading: no ceiling yet, trading is forced as today", onClock(async (clock, t) => {
  const { agent, planner } = await failedIronObjective(t);
  tradedFor(agent, 3, 3);
  planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await clockUntil(clock, () => planner.requests.length >= 2);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u);
}));

test("F9: while trading is capped a partner's proposal in chat is still answered, agreed and handed off", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, { random: () => 0 });
  tradedFor(agent, 30, 16);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.equal((agent as unknown as { relations: AgentRelations }).relations.book.trades().length, 1, "the trade was made");
}));
