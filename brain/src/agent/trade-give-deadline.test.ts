// Tests of the tosses of a give and its deadline (a partner who never takes the give, a give waiting behind a player's order).
import assert from "node:assert/strict";
import test from "node:test";
import { FakeRuntime } from "../testing.ts";
import { agentFor, clockUntil, onClock, say, steveAt } from "./agent-fixtures.test.ts";
import { ACCEPT, heldTrade, MIN, tradingRuntime } from "./trade-fixtures.test.ts";

/** A toss nobody takes: it lies on the ground again for the pick-back. */
const untaken = (runtime: FakeRuntime) => ({ status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0, settled: true }, effect: () => { runtime.groundItems = [{ item: "bread", count: 5 }]; } }) as const;
const dropCount = (runtime: FakeRuntime): number => runtime.submitted.filter((call) => call.tool === "drop_item").length;

test("D1: a partner who never takes the give gets exactly 2 tosses in 15 min, the trade ends broken by me, and the own objective then runs to its end with no abort", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  runtime.simulateInventory = true;
  runtime.dropOutcomes.push(untaken(runtime), untaken(runtime));
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { step: { skill: "collect_block", block: "oak_log", count: 16 } }, { step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "pick_up_items"));
  await clock.advance(200);
  assert.equal(heldTrade(agent)?.state, "agreed", "one try is not the end");
  await clock.advance(31_000);
  await clockUntil(clock, () => heldTrade(agent)?.state === "broken");
  assert.deepEqual([heldTrade(agent)?.brokenBy, heldTrade(agent)?.note], ["me", "Theo did not take 5 bread (2 tries); I kept them"]);
  const aborted = runtime.cancelled.length;
  delete runtime.durations.collect_block;
  clock.stepWallClock(15 * MIN);
  await clock.advance(5);
  await clockUntil(clock, () => runtime.submitted.filter((call) => call.tool === "collect_block").length >= 3);
  await clock.advance(300);
  assert.equal(dropCount(runtime), 2, "no third toss in 15 min");
  assert.equal(runtime.cancelled.length, aborted, "the next step of the own objective was never aborted");
}));

test("T7: a give coming due during a player's order waits below it: the order's step is not aborted, and the give runs after the order", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, ACCEPT);
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "agreed");
  await clock.advance(300);
  assert.equal(dropCount(runtime), 0, "the give waits");
  assert.equal(runtime.cancelled.length, 0, "the order's step runs on");
  const stack = (agent as unknown as { stack: { objective: { handoff?: unknown } }[] }).stack;
  assert.equal(stack.at(-1)?.objective.handoff, undefined, "the order is on top");
  assert.ok(stack.some((work) => work.objective.handoff !== undefined), "the hand-off is on the stack, below it");
}));

test("T7: the give queued behind a player's order runs once the order ends", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  runtime.durations.collect_block = 40;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, ACCEPT);
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => dropCount(runtime) === 1);
  assert.equal(runtime.cancelled.length, 0, "the order was never aborted");
  assert.ok(runtime.submitted.findIndex((call) => call.tool === "drop_item") > runtime.submitted.findIndex((call) => call.tool === "collect_block"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "i_gave");
}));

test("T7 + D2: a give that waited behind a long order past the deadline ends broken by me, with the order undisturbed", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  // The order must outlast the 11 min step (durations count waits, not clock ms; 10 million waits cannot end inside it): the give must be broken while it still waits behind the order.
  runtime.durations.collect_block = 10_000_000;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, { ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await clockUntil(clock, () => heldTrade(agent)?.state === "agreed");
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await clockUntil(clock, () => heldTrade(agent)?.state === "they_gave");
  clock.stepWallClock(11 * MIN);
  await clock.advance(5);
  await clockUntil(clock, () => heldTrade(agent)?.state === "broken");
  assert.deepEqual([heldTrade(agent)?.brokenBy, heldTrade(agent)?.note], ["me", "could not hand over 5 bread within 10 min"]);
  assert.equal(dropCount(runtime), 0);
  assert.equal(runtime.cancelled.length, 0, "the order's step was never aborted");
  chat.reply({ say: "Stopped.", route: "stop", request: "" });
  await agent.handle(say("Steve", "Ayla, stop"));
  await clockUntil(clock, () => agent.activity === "idle");
  await clock.advance(200);
  assert.equal(dropCount(runtime), 0, "the ended trade is never handed over");
  assert.equal(heldTrade(agent)?.state, "broken");
}));
