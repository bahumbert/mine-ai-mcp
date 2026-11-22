// Tests of how a flood of chat lines is read as one message, stops inside a flood and the speaker budget.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { SpeakerBudget } from "../speaker-budget.ts";
import { FakeRuntime, testPersona, until } from "../testing.ts";
import { clockedAgentFor, clockedJournaledAgent, clockUntil, floodSettings, journaledAgent, say, talk } from "./agent-fixtures.test.ts";

test("a flood is read as one message of its newest lines, and the journal counts the rest", async (t) => {
  const runtime = new FakeRuntime();
  const { chat, events } = journaledAgent(t, runtime, { settings: floodSettings(3) });
  chat.reply({ spoken_to: ["Ayla"], say: "Slow down!", route: "talk", request: "" });
  runtime.inbox.push(...Array.from({ length: 10 }, (_, at) => say("Steve", `l${at}`)));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 1);
  const request = chat.requests[0]?.[1]?.content ?? "";
  assert.match(request, /"l7 l8 l9"/u);
  assert.match(request, /\(7 earlier lines from Steve were not read/u);
  assert.deepEqual(events.filter((event) => event.kind === "chat").map((event) => [event.lines, event.dropped]), [[3, 7]]);
});

test("a stop at the end of a flood is read and stops the speaker's order", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = journaledAgent(t, runtime, { settings: floodSettings(3) });
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "collect some wood"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Stopping.", route: "stop", request: "" });
  runtime.inbox.push(...Array.from({ length: 8 }, (_, at) => say("Steve", `spam ${at}`)), say("Steve", "Ayla stop"));
  await until(() => runtime.cancelled.length === 1);
  assert.equal(agent.activity, "idle");
  assert.match(chat.requests.at(-1)?.[1]?.content ?? "", /Ayla stop"/u);
});

test("a complaint routed stop stops the speaker's order and takes none; an order after it is taken", async (t) => {
  // Live run 13: "you're destroying someone else's house" was taken on as a levelling order; a stop that carried a
  // guessed request would have been promoted to one by the agent (spec 2026-11-18-complaint-not-order C4).
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, events } = journaledAgent(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], type: "request", say: "On it.", route: "act", request: "collect 16 oak_log", starts_now: true });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "Ayla, collect some wood"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  const objectivesBefore = events.filter((event) => event.kind === "objective").length;
  chat.reply({ spoken_to: ["Ayla"], type: "complaint", say: "Sorry", route: "stop", request: "repair the house" });
  await agent.handle(say("Steve", "Ayla, you're destroying someone else's house"));
  await until(() => runtime.cancelled.length === 1);
  assert.equal(agent.activity, "idle");
  assert.equal(events.filter((event) => event.kind === "objective").length, objectivesBefore, "no objective from the complaint");
  assert.deepEqual(events.filter((event) => event.kind === "chat").map((event) => event.kind === "chat" ? [event.route, event.type] : null), [["act", "request"], ["stop", "complaint"]]);
  chat.reply({ spoken_to: ["Ayla"], type: "request", say: "On it", route: "act", request: "get Steve 3 dirt", starts_now: true });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 3 } });
  await agent.handle(say("Steve", "Ayla, get me 3 dirt"));
  await until(() => runtime.submitted.filter((call) => call.tool === "collect_block").length === 2);
  assert.equal(events.filter((event) => event.kind === "objective").length, objectivesBefore + 1, "the order after it is taken");
});

test("a stop typed request with an empty request takes no order", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, events } = journaledAgent(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], type: "request", say: "On it.", route: "act", request: "collect 16 oak_log", starts_now: true });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "Ayla, collect some wood"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  const objectivesBefore = events.filter((event) => event.kind === "objective").length;
  chat.reply({ spoken_to: ["Ayla"], type: "request", say: "Stopping.", route: "stop", request: "" });
  await agent.handle(say("Steve", "Ayla, stop it"));
  await until(() => runtime.cancelled.length === 1);
  assert.equal(agent.activity, "idle");
  assert.equal(events.filter((event) => event.kind === "objective").length, objectivesBefore);
});

/** Settings for the speaker-budget tests: a 20 ms burst window, so each pushed line is a message of its own once read. */
function budgetSettings() {
  return { ...testPersona().settings, chatBurstMs: 20 };
}

test("a second player is answered while the first floods", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 2, y: 64, z: 0 } }, { username: "Ann", position: { x: 3, y: 64, z: 0 } }] };
  const speakerBudget = new SpeakerBudget({ perMinute: 6, burst: 2 });
  const { chat } = journaledAgent(t, runtime, { settings: budgetSettings() }, { speakerBudget });
  chat.reply(talk("S1"), talk("S2"), talk("A1"), talk("S3"));
  runtime.inbox.push(say("Steve", "Ayla one"));
  await until(() => runtime.said.length === 1);
  runtime.inbox.push(say("Steve", "Ayla two"));
  await until(() => runtime.said.length === 2);
  runtime.inbox.push(say("Steve", "Ayla three"), say("Ann", "Ayla hello"));
  await until(() => runtime.said.includes("A1"));
  const fromSteve = chat.requests.filter((request) => /New message: Steve/u.test(request[1]?.content ?? ""));
  assert.equal(fromSteve.length, 2, "Steve's third message waits for a token; Ann's is read first");
  assert.ok(speakerBudget.waitMs("Steve") > 0);
});

test("a held speaker's stop is read at the next token", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const speakerBudget = new SpeakerBudget({ perMinute: 6, burst: 1 });
  const { agent, chat, action, events, stop: stopAgent } = clockedJournaledAgent(clock, runtime, { settings: budgetSettings() }, { speakerBudget });
  try {
    chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" }, talk("Hi!"));
    action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
    await agent.handle(say("Steve", "collect some wood"));
    await clockUntil(clock, () => runtime.submitted.some((call) => call.tool === "collect_block"));
    runtime.inbox.push(say("Steve", "Ayla hello"));
    await clockUntil(clock, () => runtime.said.includes("Hi!"));
    assert.equal(speakerBudget.tryTake("Steve"), false, "the line spent Steve's only token");
    const before = chat.requests.length;
    chat.reply({ say: "Stopping.", route: "stop", request: "" });
    runtime.inbox.push(say("Steve", "Ayla stop"));
    await clock.advance(150);
    assert.equal(chat.requests.length, before, "the stop is held: no token");
    assert.equal(runtime.cancelled.length, 0);
    await clock.advance(10_000);
    await clockUntil(clock, () => runtime.cancelled.length === 1);
    assert.equal(agent.activity, "idle");
    const stop = events.find((event) => event.kind === "chat" && event.text === "Ayla stop");
    assert.ok(stop?.kind === "chat" && (stop.heldMs ?? 0) >= 1_000, "the journal says how long the stop was held");
  } finally {
    await stopAgent();
  }
});

test("three agents on one budget spend one token per handed-out message", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const speakerBudget = new SpeakerBudget({ perMinute: 1, burst: 3 });
  const bots = [1, 2, 3].map(() => {
    const runtime = new FakeRuntime();
    const built = clockedAgentFor(clock, runtime, { settings: budgetSettings() }, { speakerBudget });
    built.chat.reply(talk("Hi!"), talk("Again!"));
    return { runtime, chat: built.chat, stop: built.stop };
  });
  try {
    const whisper = (message: string) => ({ username: "Steve", channel: "whisper" as const, message, addressed: true });
    for (const bot of bots) {
      bot.runtime.inbox.push(whisper("first"));
      await clockUntil(clock, () => bot.runtime.said.length === 1);
    }
    for (const bot of bots) bot.runtime.inbox.push(whisper("second"));
    await clock.advance(150);
    assert.deepEqual(bots.map((bot) => bot.chat.requests.length), [1, 1, 1], "the second lines wait: the brain's budget for Steve is spent");
    assert.ok(speakerBudget.waitMs("Steve") > 0);
  } finally {
    for (const bot of bots) await bot.stop();
  }
});

test("lines refused before the model give their token back", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 2, y: 64, z: 0 } }, { username: "Ann", position: { x: 3, y: 64, z: 0 } }] };
  const speakerBudget = new SpeakerBudget({ perMinute: 6, burst: 2 });
  const { chat, stop } = clockedJournaledAgent(clock, runtime, { listensTo: ["Ann"], settings: budgetSettings() }, { speakerBudget });
  try {
    for (let at = 0; at < 5; at += 1) {
      runtime.inbox.push(say("Steve", `Ayla ${at}`));
      await clockUntil(clock, () => runtime.inbox.length === 0);
      await clock.advance(30);
    }
    assert.equal(chat.requests.length, 0, "she does not listen to Steve");
    assert.equal(speakerBudget.waitMs("Steve"), 0);
    assert.equal(speakerBudget.tryTake("Steve") && speakerBudget.tryTake("Steve"), true, "both tokens are still there");
  } finally {
    await stop();
  }
});

test("a line the chat tier leaves alone without asking the model gives its token back", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: { x: 2, y: 64, z: 0 } }, { username: "Ann", position: { x: 3, y: 64, z: 0 } }] };
  const speakerBudget = new SpeakerBudget({ perMinute: 6, burst: 1 });
  const { chat, stop } = clockedJournaledAgent(clock, runtime, { settings: budgetSettings() }, { speakerBudget });
  try {
    for (let at = 0; at < 3; at += 1) {
      runtime.inbox.push(say("Steve", `Ann, come here ${at}`, false));
      await clockUntil(clock, () => runtime.inbox.length === 0);
      await clock.advance(30);
    }
    assert.equal(chat.requests.length, 0, "a line between two other players is left alone without the model");
    assert.equal(speakerBudget.tryTake("Steve"), true, "its token came back each time");
  } finally {
    await stop();
  }
});

test("a retry after ModelUnavailable takes no second token", async (t) => {
  const runtime = new FakeRuntime();
  const speakerBudget = new SpeakerBudget({ perMinute: 6, burst: 2 });
  const { chat } = journaledAgent(t, runtime, { settings: budgetSettings() }, { speakerBudget });
  chat.unavailable(1).reply(talk("Here."));
  runtime.inbox.push(say("Steve", "Ayla hello"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 2, "the failed call, then the call that answered");
  assert.equal(speakerBudget.waitMs("Steve"), 0);
  assert.equal(speakerBudget.tryTake("Steve"), true, "one token was spent, one is left");
  assert.equal(speakerBudget.tryTake("Steve"), false);
});
