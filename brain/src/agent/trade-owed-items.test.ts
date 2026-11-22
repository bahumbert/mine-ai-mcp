// Tests of items a trade owes (crafts, junk hints, scaffold blocks and the night shelter leave them alone).
import assert from "node:assert/strict";
import test from "node:test";
import type { FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { FakeRuntime } from "../testing.ts";
import { agentFor, clockUntil, onClock, say, steveAt, type Scope } from "./agent-fixtures.test.ts";
import { ACCEPT, savedRelations, tradingRuntime } from "./trade-fixtures.test.ts";

/** An agent with a trade agreed and not yet given (the give is stopped midway): what `give` owes Theo is owed until the pay-back clock retakes it. */
async function agentOwing(clock: FakeClock, t: Scope, runtime: FakeRuntime, give: { item: string; count: number }) {
  runtime.durations.drop_item = 100_000;
  const made = agentFor(t, runtime);
  const accept = { ...ACCEPT, trade: { ...ACCEPT.trade, give: [give] } };
  made.chat.reply(accept, { say: "Okay.", route: "stop", request: "" });
  await made.agent.handle(say("Theo", `Ayla, 5 iron_ingot for your ${give.count} ${give.item}?`));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "drop_item"));
  await made.agent.handle(say("Steve", "Ayla, stop"));
  await clockUntil(clock, () => runtime.cancelled.length === 1);
  await clock.advance(100);
  delete runtime.durations.drop_item;
  assert.equal(savedRelations(runtime)[0]?.trades[0]?.state, "agreed", "the trade is open and owes the item");
  return made;
}

test("a craft that took the bread a trade owes says how many are carried against how many are owed; a give to the partner says nothing", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.simulateInventory = true;
  runtime.recipes = { bread_pie: { makes: 1, needs: [{ item: "bread", count: 8 }] } };
  const { agent, chat, action } = await agentOwing(clock, t, runtime, { item: "bread", count: 5 });
  chat.reply({ say: "Okay!", route: "act", request: "make a bread pie" }, { say: "Done." });
  action.reply({ step: { skill: "craft_item", item: "bread_pie", count: 1 } }, { done: "made it" });
  await agent.handle(say("Steve", "Ayla, make a bread pie"));
  await clockUntil(clock, () => action.requests.length >= 2);
  assert.match(JSON.stringify(action.requests[1]), /you now carry 2 bread of the 5 you owe Theo \(trade\)/u);
}));

test("a give to the trade's partner is no use of what is owed: the record names no shortfall", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, steveAt(3)] };
  const { agent, chat, action } = await agentOwing(clock, t, runtime, { item: "bread", count: 5 });
  chat.reply({ say: "Okay!", route: "act", request: "give Theo 8 bread" }, { say: "Done." });
  action.reply({ step: { skill: "give_item", player: "Theo", item: "bread", count: 8 } }, { done: "given" });
  await agent.handle(say("Steve", "Ayla, give Theo 8 bread"));
  await clockUntil(clock, () => action.requests.length >= 2);
  assert.doesNotMatch(JSON.stringify(action.requests[1]), /you now carry/u);
}));

test("the junk hint of a full bag never names a kind whose every item a trade owes", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bread", count: 5 }, ...Array.from({ length: 14 }, (_, index) => ({ name: "snowball", count: index === 0 ? 8 : 16 })), { name: "stone_pickaxe", count: 1 }] };
  const { agent, chat, action } = await agentOwing(clock, t, runtime, { item: "bread", count: 5 });
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "Full, sorry." });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect);
  await agent.handle(say("Steve", "Ayla, get me some birch"));
  await clockUntil(clock, () => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /snowball \(14 slots\)/u);
  assert.doesNotMatch(prompt, /\d+ bread \(\d+ slots?\)/u);
}));

test("a step runs without the scaffold block a trade owes all of, and the list is back after", onClock(async (clock, t) => {
  const run = async (carry: number) => {
    const runtime = tradingRuntime();
    runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "cobblestone", count: carry }], policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["dirt", "cobblestone"] } };
    const { agent, chat, action } = await agentOwing(clock, t, runtime, { item: "cobblestone", count: 5 });
    runtime.scaffoldSettings.length = 0;
    chat.reply({ say: "Okay!", route: "act", request: "collect 1 birch_log" }, { say: "Done." });
    action.reply({ step: { skill: "collect_block", block: "birch_log", count: 1 } }, { done: "got it" });
    await agent.handle(say("Steve", "Ayla, get a birch log"));
    await clockUntil(clock, () => action.requests.length >= 2);
    return runtime.scaffoldSettings;
  };
  assert.deepEqual(await run(5), [["dirt"], ["dirt", "cobblestone"]]);
}));

test("a dig_shelter step roofs with the next kind when the dirt is all owed", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 4 }, { name: "cobblestone", count: 5 }] };
  const { agent, chat, action } = await agentOwing(clock, t, runtime, { item: "dirt", count: 4 });
  chat.reply({ say: "Okay!", route: "act", request: "dig in for the night" }, { say: "Done." });
  action.reply({ step: { skill: "dig_shelter" } }, { done: "dug in" });
  const dug = (input: Record<string, unknown>) => { if (input.operation === "dig") runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: Math.min(runtime.snapshot.position.y, Number(input.y)), z: 0 } }; };
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation === "place") runtime.snapshot = { ...runtime.snapshot, clock: { ...runtime.snapshot.clock!, phase: "day" } };
  };
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0, y: 64, z: 0 }, clock: { phase: "night", minutesUntilChange: 5 } };
  runtime.succeedEffects.navigate = (input) => { runtime.snapshot = { ...runtime.snapshot, position: { x: Number(input.x), y: Number(input.y), z: Number(input.z) } }; };
  await agent.handle(say("Steve", "Ayla, dig in for the night"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "raw_action" && call.input.operation === "place"));
  const places = runtime.submitted.filter((call) => call.tool === "raw_action" && call.input.operation === "place").map((call) => call.input.block_name);
  assert.deepEqual(places, ["cobblestone"], "the dirt is all owed: the next roof kind");
}));

test("the walk of a hand-off places no scaffold block the trade owes all of, and the list is back after", onClock(async (clock, t) => {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "cobblestone", count: 5 }], policy: { revision: "r1", digStraightDown: false, scaffoldBlocks: ["dirt", "cobblestone"] } };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, give: [{ item: "cobblestone", count: 5 }] } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 cobblestone?"));
  await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "drop_item"));
  await clockUntil(clock, () => agent.activity === "idle" || runtime.scaffoldSettings.length >= 2);
  assert.deepEqual(runtime.scaffoldSettings.slice(0, 2), [["dirt"], ["dirt", "cobblestone"]]);
}));
