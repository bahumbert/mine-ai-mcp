// Tests of the guard on a give inside a taken order during a trade, and of hand-off ordering on the stack.
import assert from "node:assert/strict";
import test from "node:test";
import type { BrainEvent } from "../brain-log.ts";
import { until } from "../testing.ts";
import { say } from "./agent-fixtures.test.ts";
import { ACCEPT, BUILD_ORDER, GIVE_STEPS, PREFS, THEO_OFFER, duringTrade, moodyAgent, savedRelations, takenObjectives, tradingRuntime, withAgreedTrade, ACCEPT_THEO } from "./trade-fixtures.test.ts";

const GUARDED = /^\[GIVE_OUTSIDE_TRADE\] not given: Theo and I have trade Theo-Ayla-1 open; its hand-off is how items move between us$/u;
const stepEvents = (events: BrainEvent[]) => events.flatMap((event) => (event.kind === "step" ? [event] : []));
const finishedEvents = (events: BrainEvent[]) => events.flatMap((event) => (event.kind === "objective" && event.event === "finished" ? [event] : []));

// Spec D7: the repeat of a trade done while the model answered, whether the checks accept it (the bag still holds the items: site 3 in `handle`) or refuse it (the items are gone: after the first refusal, `resendRefusedTrade`).
for (const [bag, carried] of [["still held", true], ["gone, so the checks refuse it", false]] as const) {
  test(`a build line re-accepting a trade that ended while the model answered is taken with no mark, its items ${bag}`, async (t) => {
    const { runtime, agent, chat, action, events, logs, relations, id } = await withAgreedTrade(t);
    const release = chat.hold();
    chat.reply({ ...ACCEPT_THEO, ...BUILD_ORDER });
    action.reply(...GIVE_STEPS);
    const handling = agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
    await until(() => chat.requests.length === 2);
    // The hand-off finished while the model thought: the line's accept now repeats a trade that is done.
    await relations.book.update("Theo", (r) => ({ ...r, trades: r.trades.map((trade) => ({ ...trade, state: "done" as const, endedAt: Date.now() })) }));
    if (!carried) runtime.snapshot = { ...runtime.snapshot, inventory: [] };
    release();
    await handling;
    assert.equal(chat.requests.length, 2, "nothing is sent back");
    assert.ok(takenObjectives(events).includes("Theo: build a small shelter right here first"), takenObjectives(events).join("\n"));
    assert.ok(logs.some((line) => line.includes(`restates ${id} (done)`)), logs.join("\n"));
    assert.ok(!logs.some((line) => line.includes("came to nothing") || line.startsWith("not taken:")), logs.join("\n"));
    await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  });
}

test("an order whose accept was refused carries the mark: its give to the requester fails with nothing open", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, action, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  // 50 bread are offered, 10 carried: the checks refuse the proposal twice, no trade opens, the building order is taken.
  const unaffordable = { ...BUILD_ORDER, trade: { action: "propose", give: [{ item: "bread", count: 50 }], get: [{ item: "iron_ingot", count: 5 }], first: "me" } };
  chat.reply(unaffordable, unaffordable);
  action.reply(GIVE_STEPS[0], { give_up: "the trade came to nothing" });
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => stepEvents(events).length > 0);
  assert.equal(stepEvents(events)[0]?.detail, "[GIVE_OUTSIDE_TRADE] not given: the trade Theo spoke of with this order came to nothing; a give outside a trade is no part of it");
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("another player's order is not guarded: Steve's give to Theo runs while Theo's offer stands", async (t) => {
  const { agent, chat, action, runtime } = duringTrade(t);
  chat.reply({ say: "On it.", route: "act", request: "give Theo 5 bread", work: "none" });
  action.reply(...GIVE_STEPS);
  await agent.handle(say("Steve", "Ayla, give Theo 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("s3p: a walk order during a trade is taken", async (t) => {
  const { agent, chat, action, events, logs } = duringTrade(t);
  chat.reply({ say: "Coming.", route: "act", request: "come to me", work: "travelling" });
  action.reply({ done: "I am there" });
  await agent.handle(say("Theo", "Ayla, come to me"));
  assert.deepEqual(takenObjectives(events), ["Theo: come to me"]);
  assert.ok(logs.some((line) => line.startsWith("taken during trade Theo-Ayla-1 with Theo: its gives to Theo wait for the trade's hand-off")), logs.join("\n"));
});

test("a give inside a taken build order is refused at its step, nothing is tossed", async (t) => {
  const { agent, chat, action, runtime, events } = duringTrade(t);
  chat.reply(BUILD_ORDER);
  action.reply(GIVE_STEPS[0], { give_up: "the trade goes first" });
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => stepEvents(events).length > 0);
  const [step] = stepEvents(events);
  assert.equal(step?.outcome, "failed");
  assert.match(step?.detail ?? "", GUARDED);
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"), "nothing tossed");
  assert.ok(!events.some((event) => event.kind === "state" && (event.step ?? "").includes("give 5 bread to Theo")), "the refused give is never shown as running");
});

test("the step names the requester in another case: the guard still refuses", async (t) => {
  const { agent, chat, action, runtime, events } = duringTrade(t);
  chat.reply(BUILD_ORDER);
  action.reply({ step: { skill: "give_item", player: "theo", item: "bread", count: 5 } }, { give_up: "the trade goes first" });
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => stepEvents(events).length > 0);
  assert.match(stepEvents(events)[0]?.detail ?? "", GUARDED);
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("a give the agreed trade owes runs inside a taken order", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, action } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  // Theo pays first: the trade is agreed with my 5 bread still owed, and my hand-off only waits for his side.
  chat.reply(ACCEPT_THEO, BUILD_ORDER);
  action.reply(GIVE_STEPS[0], { done: "built and given" });
  await agent.handle(say("Theo", "Ayla, take the deal"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "agreed");
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("an order taken after a cancel carries no mark: its later give step runs", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat, action, events, logs } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  chat.reply(ACCEPT_THEO, { ...ACCEPT_THEO, ...BUILD_ORDER, trade: { ...ACCEPT_THEO.trade, action: "cancel" } });
  action.reply(GIVE_STEPS[0], { done: "built and given" });
  await agent.handle(say("Theo", "Ayla, take the deal"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "agreed");
  await agent.handle(say("Theo", "Ayla, forget the trade and build a small shelter right here first"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.ok(takenObjectives(events).includes("Theo: build a small shelter right here first"));
  assert.ok(!logs.some((line) => line.includes("came to nothing")), logs.join("\n"));
});

test("an order taken during a trade ends after its refused give", async (t) => {
  const { agent, chat, action, events } = duringTrade(t);
  chat.reply(BUILD_ORDER);
  action.reply(GIVE_STEPS[0], GIVE_STEPS[0], GIVE_STEPS[0]);
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => finishedEvents(events).length === 1);
  const [ended] = finishedEvents(events);
  assert.equal(ended?.outcome, "failed");
  assert.match(ended?.detail ?? "", /failed the same way 3 times/u);
});

test("a refused give is not remembered as an earlier failure: the next order's same give runs on the first try", async (t) => {
  const { agent, chat, action, runtime, board, events } = duringTrade(t);
  // The second reply tells the requester how the first order ended.
  chat.reply(BUILD_ORDER, { say: "I could not give it." }, { ...BUILD_ORDER, request: "build a hut" });
  action.reply(GIVE_STEPS[0], GIVE_STEPS[0], GIVE_STEPS[0]);
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => finishedEvents(events).length === 1);
  board.withdraw("Theo-Ayla-1");
  action.reply(...GIVE_STEPS);
  const before = action.requests.length;
  await agent.handle(say("Theo", "Ayla, build a hut"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.doesNotMatch(action.requests[before]?.map((turn) => turn.content).join("\n") ?? "", /failed lately/u);
});

test("a guarded give keeps the rule-2 refusals of another step", async (t) => {
  const { agent, chat, action, runtime, events } = duringTrade(t);
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const CRAFT = { step: { skill: "craft_item", item: "cooked_beef", count: 3 } };
  chat.reply({ say: "Okay!", route: "act", request: "cook 3 beef" }, { say: "No recipe." }, BUILD_ORDER);
  // Steve's order fails the craft twice and ends refused; Theo's build is refused twice, a guarded give comes between, the third refusal ends it.
  action.reply(CRAFT, CRAFT, CRAFT, CRAFT, CRAFT);
  await agent.handle(say("Steve", "cook me 3 beef"));
  await until(() => finishedEvents(events).length === 1);
  action.reply(CRAFT, GIVE_STEPS[0], CRAFT, CRAFT);
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => finishedEvents(events).length === 2);
  assert.match(finishedEvents(events)[1]?.detail ?? "", /was refused 3 times/u, "the guarded give did not restart the count");
  assert.ok(stepEvents(events).some((step) => GUARDED.test(step.detail)));
});

test("a later order queued behind another is guarded at its step", async (t) => {
  const { agent, chat, action, runtime, board, events } = duringTrade(t, { offer: false });
  runtime.durations.collect_block = 100_000;
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, GIVE_STEPS[0], { give_up: "the trade goes first" });
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...BUILD_ORDER, route: "later" }, { say: "Stopping.", route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, build a small shelter right here first when you can"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "queued"));
  board.post(THEO_OFFER);
  await agent.handle(say("Steve", "Ayla, stop"));
  await until(() => stepEvents(events).some((step) => GUARDED.test(step.detail)));
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"));
});

test("a stop carrying a build request during a trade stops and takes the request", async (t) => {
  const { agent, chat, action, planner, runtime, events } = duringTrade(t, { goal: "build yourself a base" });
  runtime.durations.collect_block = 100_000;
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { give_up: "stopped" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Stopping.", route: "stop", request: "build a small shelter", work: "building" });
  await agent.handle(say("Theo", "Ayla, stop and build a small shelter"));
  await until(() => runtime.cancelled.length >= 1);
  assert.ok(takenObjectives(events).includes("Theo: build a small shelter"), takenObjectives(events).join("\n"));
});

test("an open trade and a roll that says no refuse an activity order with the roll's line", async (t) => {
  const { agent, chat, events, logs } = duringTrade(t, { rated: -8, roll: 0.99 });
  chat.reply(BUILD_ORDER);
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.includes(`not taken: Theo rated -8, chance 27 %, rolled no (${JSON.stringify(BUILD_ORDER.request)})`), logs.join("\n"));
});

// Plan 2026-11-08-trading-p2-fixes Task 1.3 (spec D3, D3b): the partner's give hand-off comes before the order it let through.
const COLLECT_LOGS = { step: { skill: "collect_block", block: "oak_log", count: 16 } };
const HANDOFF_GIVE = "hand over 5 bread to Theo (trade)";
const queuedEvents = (events: BrainEvent[]) => events.flatMap((event) => (event.kind === "objective" && event.event === "queued" ? [event.text] : []));

test("a build order taken while the trade's give hand-off runs waits below it", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.drop_item = 800;
  const { agent, chat, action, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  chat.reply(ACCEPT, BUILD_ORDER);
  action.reply({ done: "built" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  assert.deepEqual(queuedEvents(events), [BUILD_ORDER.request], "queued below the give");
  assert.ok(!takenObjectives(events).includes(`Theo: ${BUILD_ORDER.request}`), "not on top");
  await until(() => finishedEvents(events).some((event) => event.text === BUILD_ORDER.request));
  assert.equal(runtime.cancelled.length, 0, "the give was never aborted");
});

test("a hand-off due while the partner's build order runs goes on top and the build resumes", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  const propose = { ...ACCEPT, trade: { ...ACCEPT.trade, action: "propose" } };
  chat.reply(propose, BUILD_ORDER, ACCEPT);
  action.reply(COLLECT_LOGS, { done: "built" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "proposed");
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, deal"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.ok(runtime.cancelled.length >= 1, "the build's step was set aside for the give");
  const taken = takenObjectives(events);
  assert.ok(taken.indexOf(`own: ${HANDOFF_GIVE}`) > taken.indexOf(`Theo: ${BUILD_ORDER.request}`), taken.join("\n"));
  // Theo pays: the trade ends done, and the build, resumed, answers done.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "done", 4_000);
  await until(() => finishedEvents(events).some((event) => event.text === BUILD_ORDER.request && event.outcome === "done"), 4_000);
});

test("another player's running order still keeps a hand-off below it", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, events } = moodyAgent(t, runtime, 0, 0, { preferences: PREFS });
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" }, ACCEPT);
  action.reply(COLLECT_LOGS);
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => queuedEvents(events).includes(HANDOFF_GIVE));
  assert.equal(runtime.cancelled.length, 0, "Steve's step runs on");
});

test("the taken objective event says the trade it was let through during", async (t) => {
  const { agent, chat, action, events } = duringTrade(t);
  chat.reply(BUILD_ORDER);
  action.reply({ done: "built" });
  await agent.handle(say("Theo", "Ayla, can you build a small shelter right here first?"));
  const taken = events.find((event) => event.kind === "objective" && event.event === "taken");
  assert.equal(taken?.kind === "objective" && taken.duringTrade, "Theo-Ayla-1");
});
