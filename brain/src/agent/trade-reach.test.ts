// Tests of the reach of a trade: a speaker 200 blocks away is not gone to, the reach reason goes back to the chat tier once.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { until } from "../testing.ts";
import { agentFor, say } from "./agent-fixtures.test.ts";
import { ACCEPT, chatFromFarAgent, failedIronObjective, ORDER, savedRelations, takenObjectives, tradingRuntime } from "./trade-fixtures.test.ts";

test("F10: with Theo 200 blocks away a failed objective draws no trading and shows no trade-needs line; at 10 blocks it does", async (t) => {
  const far = await failedIronObjective(t, {}, 200);
  far.planner.reply({ objective: "gather wood" });
  await until(() => far.planner.requests.length >= 2, 4_000);
  assert.doesNotMatch(JSON.stringify(far.planner.requests[1]), /trading items with someone|trade for/u);
  assert.ok(!far.runtime.submitted.some((call) => call.tool === "navigate"), "no walk toward the far partner");
  const near = await failedIronObjective(t, {}, 10);
  near.planner.reply({ objective: "gather wood" });
  await until(() => near.planner.requests.length >= 2, 4_000);
  assert.match(JSON.stringify(near.planner.requests[1]), /trade for iron_ingot you could not get: ask Theo/u);
});

test("F10: an order to trade from an agent 200 blocks away is not taken, and the log says why", async (t) => {
  const { events, logs, agent, chat } = chatFromFarAgent(t, 200);
  chat.reply(ORDER);
  await agent.handle(say("Vex", "Ayla, come to me and trade iron"));
  await sleep(50);
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.some((line) => line.startsWith('not taken: Vex is too far away to trade with ("bring 5 iron_ingot to Vex")')), logs.join("\n"));
});

test("F10: the same order from an agent 10 blocks away is taken as today", async (t) => {
  const { events, agent, chat } = chatFromFarAgent(t, 10);
  chat.reply(ORDER);
  await agent.handle(say("Vex", "Ayla, come to me and trade iron"));
  await until(() => takenObjectives(events).length > 0);
  assert.deepEqual(takenObjectives(events), ["Vex: bring 5 iron_ingot to Vex"]);
});

test("F10: a player 200 blocks away is still obeyed for a trading order, and an agent far away for any other purpose", async (t) => {
  const player = chatFromFarAgent(t, 200);
  player.chat.reply({ ...ORDER, request: "give Theo 5 bread" });
  await player.agent.handle(say("Theo", "Ayla, give me 5 bread"));
  await until(() => takenObjectives(player.events).length > 0);
  assert.deepEqual(takenObjectives(player.events), ["Theo: give Theo 5 bread"]);
  const building = chatFromFarAgent(t, 200);
  building.chat.reply({ ...ORDER, request: "build a hut", work: "building" });
  await building.agent.handle(say("Vex", "Ayla, build a hut"));
  await until(() => takenObjectives(building.events).length > 0);
  assert.deepEqual(takenObjectives(building.events), ["Vex: build a hut"]);
});

test("F10: the chat input tells the model an agent speaker out of reach cannot be gone to; not for one in reach, not for a player", async (t) => {
  const far = chatFromFarAgent(t, 200);
  far.chat.reply({ ...ORDER, route: "talk" });
  await far.agent.handle(say("Vex", "Ayla, trade iron?"));
  assert.match(far.chat.requests[0]?.[1]?.content ?? "", /Vex is too far away to trade with \(200 blocks away\): do not offer to go to them; they can come to you\./u);
  const near = chatFromFarAgent(t, 10);
  near.chat.reply({ ...ORDER, route: "talk" });
  await near.agent.handle(say("Vex", "Ayla, trade iron?"));
  assert.doesNotMatch(near.chat.requests[0]?.[1]?.content ?? "", /too far away to trade/u);
  const player = chatFromFarAgent(t, 10);
  player.chat.reply({ ...ORDER, route: "talk" });
  await player.agent.handle(say("Theo", "Ayla, trade iron?"));
  assert.doesNotMatch(player.chat.requests[0]?.[1]?.content ?? "", /too far away to trade/u);
  const unseen = chatFromFarAgent(t, 10);
  unseen.runtime.snapshot = { ...unseen.runtime.snapshot, players: [] };
  unseen.chat.reply({ ...ORDER, route: "talk" });
  await unseen.agent.handle(say("Vex", "Ayla, trade iron?"));
  assert.match(unseen.chat.requests[0]?.[1]?.content ?? "", /Vex is too far away to trade with \(out of sight\)/u);
});

test("F10: a trade with a speaker 200 blocks away goes back to the chat tier once with the reach reason and is then not made", async (t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 200, y: 64, z: 0 } }] };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply(ACCEPT, { ...ACCEPT, say: "Come to me, then.", trade: undefined });
  await agent.handle(say("Theo", "Ayla, bread for iron?"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Theo is too far away to trade with \(200 blocks away\): no trade from here; say they can come to you/u);
  assert.deepEqual(runtime.said, ["Come to me, then."]);
  assert.deepEqual(savedRelations(runtime), []);
});

test("F10: a second reach refusal records no trade", async (t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [] };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply(ACCEPT, { ...ACCEPT, say: "Deal anyway." });
  await agent.handle(say("Theo", "Ayla, bread for iron?"));
  await until(() => runtime.said.length === 1);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Theo is too far away to trade with \(out of sight\)/u);
  assert.deepEqual(savedRelations(runtime), []);
});
