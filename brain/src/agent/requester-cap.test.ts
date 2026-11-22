// Tests of the per-requester open-order cap and of the open orders told to the chat tier.
import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "../agent.ts";
import type { BrainEvent } from "../brain-log.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { Handoff } from "../relations/handoff.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { agentFor, others, say, talk } from "./agent-fixtures.test.ts";

/** An agent that is not running (no work loop): the orders it takes stay on its stack, so a test counts them. */
function agentAtRest(runtime: FakeRuntime, openOrdersPerRequester = 2) {
  const events: BrainEvent[] = [];
  const logs: string[] = [];
  const tiers = scriptedMind();
  const base = testPersona().settings;
  const persona = testPersona({ settings: { ...base, chat: { ...base.chat, openOrdersPerRequester } } });
  const agent = new Agent({ persona, runtime, mind: tiers.mind, otherAgents: others(), log: (line) => logs.push(line), typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0, journal: (event) => events.push(event) });
  const inside = agent as unknown as { openOrdersOf(name: string): number; takeHandoff(h: Handoff): void };
  return { agent, events, logs, openOrdersOf: (name: string) => inside.openOrdersOf(name), takeHandoff: (h: Handoff) => inside.takeHandoff(h), ...tiers };
}

/** The agent holds two of Steve's requests (one taken, one queued behind it). */
async function holdingTwoOf(steve: ReturnType<typeof agentAtRest>) {
  steve.chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" }, { say: "After that.", route: "later", request: "collect 5 sand" });
  await steve.agent.handle(say("Steve", "get me 16 logs"));
  await steve.agent.handle(say("Steve", "then 5 sand"));
}

test("a requester at the cap gets no new order, and the refusal is journaled", async () => {
  const runtime = new FakeRuntime();
  const bot = agentAtRest(runtime);
  await holdingTwoOf(bot);
  assert.equal(bot.openOrdersOf("Steve"), 2);
  // At the cap the first act reply is sent back; the model repeats it, so the agent refuses the order.
  const again = { say: "Sure!", route: "act", request: "collect 3 dirt", starts_now: true };
  bot.chat.reply(again, again);
  await bot.agent.handle(say("Steve", "and 3 dirt"));
  assert.equal(bot.chat.requests.length, 4, "two calls for the line: the act reply and its send-back");
  assert.equal(bot.openOrdersOf("Steve"), 2, "no third order");
  assert.deepEqual(bot.events.filter((event) => event.kind === "order_refused"), [{ kind: "order_refused", speaker: "Steve", text: "collect 3 dirt", reason: "open_orders", open: 2, max: 2 }]);
  assert.ok(bot.logs.includes("not taken: Steve already holds 2 requests (max 2)"), bot.logs.join("\n"));
  assert.equal(bot.chat.requests.at(-1)?.[1]?.content.includes("A new request from them cannot be taken on"), true, "the chat tier was told");
});

test("another player's order is taken while one requester is at the cap", async () => {
  const bot = agentAtRest(new FakeRuntime());
  await holdingTwoOf(bot);
  bot.chat.reply({ say: "Sure, Ann!", route: "act", request: "collect 3 dirt for Ann" });
  await bot.agent.handle(say("Ann", "3 dirt please"));
  assert.equal(bot.openOrdersOf("Ann"), 1);
  assert.equal(bot.openOrdersOf("Steve"), 2);
  assert.deepEqual(bot.events.filter((event) => event.kind === "order_refused"), []);
});

test("a stop with a request frees the cap first", async () => {
  const bot = agentAtRest(new FakeRuntime());
  await holdingTwoOf(bot);
  bot.chat.reply({ say: "Stopping, then dirt.", route: "stop", request: "collect 3 dirt" });
  await bot.agent.handle(say("Steve", "stop all that, 3 dirt instead"));
  assert.equal(bot.openOrdersOf("Steve"), 1, "the old orders ended, the new one is taken");
  assert.deepEqual(bot.events.filter((event) => event.kind === "order_refused"), []);
});

test("hand-offs never count toward a requester's cap", async () => {
  const bot = agentAtRest(new FakeRuntime(), 1);
  bot.takeHandoff({ kind: "give", tradeId: "t1", partner: "Steve", items: [{ item: "bread", count: 5 }] });
  assert.equal(bot.openOrdersOf("Steve"), 0, "a hand-off for Steve is no request of Steve's");
  bot.chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  await bot.agent.handle(say("Steve", "get me 16 logs"));
  assert.equal(bot.openOrdersOf("Steve"), 1);
  assert.deepEqual(bot.events.filter((event) => event.kind === "order_refused"), []);
});

test("the chat tier is told the speaker's open orders", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" }, talk("Still on it."));
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "get me 16 logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Steve", "Ayla, how is it going?"));
  assert.doesNotMatch(chat.requests[0]?.[1]?.content ?? "", /You hold/u, "no request held yet");
  assert.match(chat.requests[1]?.[1]?.content ?? "", /You hold 1 of Steve's requests \(the most you take from one player is 3\)\./u);
});
