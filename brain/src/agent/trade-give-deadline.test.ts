// Tests of the tosses of a give and its deadline (a partner who never takes the give, a give waiting behind a player's order).
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { FakeRuntime, movedClocks, until } from "../testing.ts";
import { agentFor, say, steveAt } from "./agent-fixtures.test.ts";
import { ACCEPT, heldTrade, MIN, tradingRuntime } from "./trade-fixtures.test.ts";

/** A toss nobody takes: it lies on the ground again for the pick-back. */
const untaken = (runtime: FakeRuntime) => ({ status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0, settled: true }, effect: () => { runtime.groundItems = [{ item: "bread", count: 5 }]; } }) as const;
const dropCount = (runtime: FakeRuntime): number => runtime.submitted.filter((call) => call.tool === "drop_item").length;

test("D1: a partner who never takes the give gets exactly 2 tosses in 15 min, the trade ends broken by me, and the own objective then runs to its end with no abort", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  runtime.simulateInventory = true;
  runtime.dropOutcomes.push(untaken(runtime), untaken(runtime));
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  const time = movedClocks(t);
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { step: { skill: "collect_block", block: "oak_log", count: 16 } }, { step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "pick_up_items"), 4_000);
  await sleep(200);
  assert.equal(heldTrade(agent)?.state, "agreed", "one try is not the end");
  time.offset = 31_000;
  await until(() => heldTrade(agent)?.state === "broken", 4_000);
  assert.deepEqual([heldTrade(agent)?.brokenBy, heldTrade(agent)?.note], ["me", "Theo did not take 5 bread (2 tries); I kept them"]);
  const aborted = runtime.cancelled.length;
  delete runtime.durations.collect_block;
  time.offset += 15 * MIN;
  await until(() => runtime.submitted.filter((call) => call.tool === "collect_block").length >= 3, 4_000);
  await sleep(300);
  assert.equal(dropCount(runtime), 2, "no third toss in 15 min");
  assert.equal(runtime.cancelled.length, aborted, "the next step of the own objective was never aborted");
  time.restore();
});

test("T7: a give coming due during a player's order waits below it: the order's step is not aborted, and the give runs after the order", async (t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, ACCEPT);
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => heldTrade(agent)?.state === "agreed", 4_000);
  await sleep(300);
  assert.equal(dropCount(runtime), 0, "the give waits");
  assert.equal(runtime.cancelled.length, 0, "the order's step runs on");
  const stack = (agent as unknown as { stack: { objective: { handoff?: unknown } }[] }).stack;
  assert.equal(stack.at(-1)?.objective.handoff, undefined, "the order is on top");
  assert.ok(stack.some((work) => work.objective.handoff !== undefined), "the hand-off is on the stack, below it");
});

test("T7: the give queued behind a player's order runs once the order ends", async (t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  runtime.durations.collect_block = 40;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, ACCEPT);
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => dropCount(runtime) === 1, 6_000);
  assert.equal(runtime.cancelled.length, 0, "the order was never aborted");
  assert.ok(runtime.submitted.findIndex((call) => call.tool === "drop_item") > runtime.submitted.findIndex((call) => call.tool === "collect_block"));
  await until(() => heldTrade(agent)?.state === "i_gave", 4_000);
});

test("T7 + D2: a give that waited behind a long order past the deadline ends broken by me, with the order undisturbed", async (t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime);
  const time = movedClocks(t);
  chat.reply({ say: "On it.", route: "act", request: "collect 5 dirt" }, { ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 5 } }, { done: "got the dirt" });
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => heldTrade(agent)?.state === "agreed", 4_000);
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => heldTrade(agent)?.state === "they_gave", 4_000);
  time.offset += 11 * MIN;
  await until(() => heldTrade(agent)?.state === "broken", 4_000);
  assert.deepEqual([heldTrade(agent)?.brokenBy, heldTrade(agent)?.note], ["me", "could not hand over 5 bread within 10 min"]);
  assert.equal(dropCount(runtime), 0);
  assert.equal(runtime.cancelled.length, 0, "the order's step was never aborted");
  chat.reply({ say: "Stopped.", route: "stop", request: "" });
  await agent.handle(say("Steve", "Ayla, stop"));
  await until(() => agent.activity === "idle", 4_000);
  await sleep(200);
  assert.equal(dropCount(runtime), 0, "the ended trade is never handed over");
  assert.equal(heldTrade(agent)?.state, "broken");
  time.restore();
});
