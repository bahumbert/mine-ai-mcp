import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "./agent.ts";
import { INSTANT_TYPING } from "./body.ts";
import type { Persona } from "./persona.ts";
import { memoryNote, recall } from "./memory.ts";
import { FakeRuntime, scriptedMind, SMALL_MEDIEVAL_HOUSE, testPersona, until } from "./testing.ts";
import { planFollowStep } from "./skills.ts";

function steveAt(x: number) {
  return { username: "Steve", position: { x, y: 64, z: 0 } };
}

/** A running agent (chat handling and work loop) over a fake runtime; stopped when the test ends. */
function agentFor(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}) {
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: ["Vex"], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, ...tiers };
}

function say(username: string, message: string) {
  return { username, channel: "chat" as const, message, addressed: false };
}

function bodyCalls(runtime: FakeRuntime): string[] {
  return runtime.submitted.filter((call) => call.tool !== "send_message").map((call) => call.tool);
}

test("follow planning holds when close, moves when far, and reports a lost player", () => {
  const snapshot = new FakeRuntime().snapshot;
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(3)] }, "steve", 3), { kind: "hold" });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(10)] }, "Steve", 3), { kind: "move", target: { x: 10, y: 64, z: 0 } });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [{ username: "Steve", position: null }] }, "Steve", 3), { kind: "lost" });
});

test("a request becomes an objective worked out one step at a time, each step seeing what the last ones did", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  action.reply(
    { thought: "I carry no dirt.", step: { skill: "collect_block", block: "dirt", count: 2 } },
    { step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } },
    { done: "Steve has 2 dirt" },
  );
  await agent.handle(say("Steve", "could you give me a bit of dirt, 2 is enough"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Sure.", "Here you go!"]);
  assert.deepEqual(bodyCalls(runtime), ["collect_block", "navigate", "drop_item"]);
  assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "give Steve 2 dirt"\n\nSteps so far: none yet\./u);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u);
  assert.match(action.requests[2]?.[1]?.content ?? "", /2\. give 2 dirt to Steve -> done: gave 2 dirt to Steve/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /\("give Steve 2 dirt"\) is done: Steve has 2 dirt/u);
  assert.equal(agent.activity, "idle");
});

test("a failed step is shown to the model, which may give up and say why in character", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "No birch around here, sorry!" });
  action.reply({ step: { skill: "collect_block", block: "birch_log", count: 5 } }, { give_up: "there is no birch_log nearby" });
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 5 birch_log -> failed: \[NO_LOADED_MATCHING_TARGETS\]/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /You stopped working on "collect 5 birch_log": there is no birch_log nearby/u);
});

test("the same step failing the same way several times in a row ends the objective instead of looping", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "I can't find any birch, sorry!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect, collect, collect);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 3);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 5 birch_log failed the same way 3 times in a row: \[NO_LOADED_MATCHING_TARGETS\]/u);
  assert.equal(action.requests.length, 3);
});

test("chatting while working is answered at once and the work goes on", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 200;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 10 oak_log" }, { say: "Chopping away!", route: "talk", request: "" }, { say: "Done!" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 10 } }, { done: "collected 10 oak_log" });
  await agent.handle(say("Steve", "get me 10 logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Steve", "how is it going?"));
  await until(() => runtime.said.length === 2);
  assert.equal(agent.activity, "\"collect 10 oak_log\" (for Steve)");
  assert.deepEqual(runtime.cancelled, []);
  await until(() => runtime.said.length === 3, 5_000);
  assert.deepEqual(runtime.said, ["On it.", "Chopping away!", "Done!"]);
});

test("an order sets the character's own goal aside; it resumes afterwards, knowing it was interrupted", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log for my base" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  assert.match(agent.activity, /"collect 16 oak_log for my base" \(your own goal\)/u);

  chat.reply({ say: "Coming!", route: "act", request: "come to Steve" }, { say: "Here I am." });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } }, { done: "I am next to Steve" }, { done: "enough wood for now" });
  await agent.handle(say("Steve", "come here please"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.cancelled.length, 1, "the collection was set aside");
  assert.match(action.requests[1]?.[1]?.content ?? "", /Set aside until this one ends: "collect 16 oak_log for my base"/u);
  await until(() => action.requests.length === 4);
  const resumed = action.requests[3]?.[1]?.content ?? "";
  assert.match(resumed, /Objective \(your own goal\): "collect 16 oak_log for my base"/u);
  assert.match(resumed, /1\. collect 16 oak_log -> interrupted/u);
});

test("a request taken on for later waits until the work for another player ends", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3), { username: "Bob", position: { x: 5, y: 64, z: 0 } }] };
  runtime.durations.collect_block = 300;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log for Steve" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "get me 16 logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));

  chat.reply({ say: "Right after Steve's logs!", route: "later", request: "come to Bob" }, { say: "Done, Steve!" }, { say: "Here I am, Bob." });
  action.reply({ done: "collected 16 oak_log" }, { step: { skill: "go_to_player", player: "Bob" } }, { done: "I am next to Bob" });
  await agent.handle(say("Bob", "come here when you can"));
  assert.deepEqual(runtime.cancelled, [], "the collection goes on");
  assert.match(agent.activity, /"collect 16 oak_log for Steve" \(for Steve\); set aside: "come to Bob"/u);
  await until(() => action.requests.length >= 3, 5_000);
  assert.match(action.requests[2]?.[1]?.content ?? "", /Objective \(asked by Bob\): "come to Bob"/u);
});

test("a player's request never waits behind the character's own goal, even when the model said later", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log for my base" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));

  chat.reply({ say: "Right after these logs!", route: "later", request: "come to Steve" });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } });
  await agent.handle(say("Steve", "come here please"));
  await until(() => runtime.cancelled.length === 1 && action.requests.length >= 2);
  const next = action.requests[1]?.[1]?.content ?? "";
  assert.match(next, /Objective \(asked by Steve\): "come to Steve"/u);
  assert.match(next, /Set aside until this one ends: "collect 16 oak_log for my base"/u);
});

test("stop ends everything, its own goal included, and it rests before going back to that goal", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base", settings: { ...testPersona().settings, restAfterStopSeconds: 60 } });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Okay, I'll take a break.", route: "stop", request: "" });
  await agent.handle(say("Steve", "stop, take a break"));
  await until(() => runtime.cancelled.length === 1);
  assert.equal(agent.activity, "idle");
  await sleep(300);
  assert.equal(planner.requests.length, 1, "no new own objective while resting");
});

test("a house the agent built becomes a known place, with its roof, for what comes next", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL_HOUSE, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "build Steve a small house" }, { say: "Done!" });
  action.reply({ step: { skill: "build" } }, { done: "built the house" });
  await agent.handle(say("Steve", "build me a house"));
  await until(() => runtime.said.length === 2);
  assert.match(action.requests[0]?.[1]?.content ?? "", /- Places you know: none\./u);

  chat.reply({ say: "Up I go.", route: "act", request: "go to the roof of the house" }, { say: "Nice view." });
  action.reply({ step: { skill: "go_to", x: -4, y: 70, z: 0 } }, { done: "on the roof" });
  await agent.handle(say("Steve", "go to the roof"));
  await until(() => runtime.said.length === 4);
  const places = "- Places you know: the small medieval house you built for Steve (door -2 64 0 facing east; stand on its roof at -4 70 0).";
  assert.ok((chat.requests[2]?.[1]?.content ?? "").includes(places), "the chat tier knows it");
  assert.ok((action.requests[2]?.[1]?.content ?? "").includes(places), "the work tier knows it");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate").at(-1)?.input, { x: -4, y: 70, z: 0, range: 1 });
  assert.ok(runtime.notes.some((note) => note.context.startsWith("brain memory: place ")), "saved as a memory note");
});

test("memories an earlier run saved as notes come back: places, its own last objectives, an unfinished house", async (t) => {
  const runtime = new FakeRuntime();
  const house = { kind: "small medieval house", site: { door: { x: 5, y: 64, z: 5 }, facing: "north" as const }, part: 2 };
  runtime.notes = [
    memoryNote({ kind: "place", place: { name: "the old hut", detail: "door 1 64 1 facing south" } }),
    memoryNote({ kind: "place", place: { name: "the small medieval house you built for Steve", detail: "door -2 64 0 facing east" } }),
    memoryNote({ kind: "own_objective", outcome: "collect 16 oak_log: done (collected 16 oak_log)" }),
    memoryNote({ kind: "unfinished_house", house }),
    memoryNote({ kind: "unfinished_house", house: null }),
    memoryNote({ kind: "unfinished_house", house }),
  ];
  const { planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const prompt = planner.requests[0]?.[1]?.content ?? "";
  assert.match(prompt, /the old hut \(door 1 64 1 facing south\); the small medieval house you built for Steve/u);
  assert.match(prompt, /collect 16 oak_log: done/u);
  assert.equal(runtime.queries.length, 1);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5 }).unfinished, house);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5 }).places.map((place) => place.name), ["the small medieval house you built for Steve"]);
});

test("never digging straight down is set at start, and again after the runtime reset its policy", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, policy: { revision: "1", digStraightDown: true } };
  const { agent, chat, action } = agentFor(t, runtime);
  await until(() => runtime.digSettings.length === 1);
  assert.deepEqual(runtime.digSettings, [false]);
  // A death resets every override in the runtime.
  runtime.snapshot = { ...runtime.snapshot, policy: { revision: "7", digStraightDown: true } };
  chat.reply({ say: "Okay.", route: "act", request: "collect 1 dirt" }, { say: "Got it." });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 1 } }, { done: "collected 1 dirt" });
  await agent.handle(say("Steve", "a bit of dirt please"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.digSettings, [false, false]);
});

test("other agents are not heard, and the chat tier may decide a message is not for us", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime);
  await agent.handle(say("Vex", "Ayla come here"));
  assert.equal(chat.requests.length, 0);
  chat.reply({ say: "", route: "ignore", request: "" }, { say: "Hello Steve.", route: "talk", request: "" });
  await agent.handle(say("Alex", "anyone want to trade"));
  await agent.handle(say("Steve", "hi there"));
  await until(() => runtime.said.length === 1);
  assert.deepEqual(runtime.said, ["Hello Steve."]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Alex: "anyone want to trade"/u);
});

test("under an order, what it starts doing and why is given to the chat tier, which says it; its own goals stay silent", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "gather dirt", settings: { ...testPersona().settings, narrateEverySeconds: 0 } });
  chat.reply({ say: "Sure.", route: "act", request: "get 2 dirt" }, { say: "Digging a bit of dirt for you." }, { say: "Got it!" });
  action.reply({ step: { skill: "get_items", items: [{ item: "dirt", count: 2 }] } }, { done: "carrying 2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => runtime.said.length === 3);
  assert.deepEqual(runtime.said, ["Sure.", "Digging a bit of dirt for you.", "Got it!"]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /working on what you were asked \("get 2 dirt"\)\. Now you start gathering 2 dirt for getting 2 dirt\./u);

  // Its own goal: the same work, no line.
  planner.reply({ objective: "get 2 dirt" });
  action.reply({ step: { skill: "get_items", items: [{ item: "dirt", count: 2 }] } }, { done: "carrying 4 dirt" });
  await until(() => action.requests.length === 4);
  await sleep(50);
  assert.equal(chat.requests.length, 3, "no narration for its own goal");
});

test("no progress line is asked for within the budget after the reply that took the order on", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, narrateEverySeconds: 30 } });
  chat.reply({ say: "Sure.", route: "act", request: "get 2 dirt" }, { say: "Done!" });
  action.reply({ step: { skill: "get_items", items: [{ item: "dirt", count: 2 }] } }, { done: "carrying 2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Sure.", "Done!"], "within 30 s of the reply that took the order, nothing more is said");
});
