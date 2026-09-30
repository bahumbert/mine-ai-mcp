import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "./agent.ts";
import { INSTANT_TYPING } from "./body.ts";
import { FakeRuntime, scriptedMind, SMALL_MEDIEVAL_HOUSE, testPersona, until } from "./testing.ts";
import { planFollowStep } from "./skills.ts";

function steveAt(x: number) {
  return { username: "Steve", position: { x, y: 64, z: 0 } };
}

function agentFor(runtime: FakeRuntime, stance: "companion" | "rival" = "companion") {
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona({ stance }), runtime, mind: tiers.mind, otherAgents: ["Vex"], log: () => undefined, typing: INSTANT_TYPING });
  return { agent, ...tiers };
}

function say(username: string, message: string) {
  return { username, channel: "chat" as const, message, addressed: false };
}

test("follow planning holds when close, moves when far, and reports a lost player", () => {
  const snapshot = new FakeRuntime().snapshot;
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(3)] }, "steve", 3), { kind: "hold" });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(10)] }, "Steve", 3), { kind: "move", target: { x: 10, y: 64, z: 0 } });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [{ username: "Steve", position: null }] }, "Steve", 3), { kind: "lost" });
});

test("a free-form request is acknowledged, mapped to skills by the action tier, and stopped in plain words", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(20)] };
  runtime.durations.navigate = 10_000;
  const { agent, chat, action } = agentFor(runtime);
  chat.reply({ say: "Right behind you!", route: "act", request: "follow Steve" });
  action.reply({ steps: [{ skill: "follow_player", player: "Steve" }] });

  await agent.handle(say("Steve", "hey, tag along with me"));
  await until(() => runtime.submitted.some((call) => call.tool === "navigate"));
  assert.equal(agent.activity, "follow Steve at 3 blocks");
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "navigate")?.input, { x: 20, y: 64, z: 0, range: 3 });
  assert.match(action.requests[0]?.[1]?.content ?? "", /Request from Steve: "follow Steve"/u);

  chat.reply({ say: "Okay, I'll wait here.", route: "stop", request: "" });
  await agent.handle(say("Steve", "that's enough for now"));
  assert.equal(agent.activity, "idle");
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Right behind you!", "Okay, I'll wait here."]);
  await until(() => runtime.cancelled.length === 1);
});

test("chatting while working is answered at once and the work goes on", async () => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 200;
  const { agent, chat, action } = agentFor(runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 10 oak_log" }, { say: "Chopping away!", route: "talk", request: "" }, { say: "Done!" });
  action.reply({ steps: [{ skill: "collect_block", block: "oak_log", count: 10 }] });
  await agent.handle(say("Steve", "get me 10 logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Steve", "how is it going?"));
  await until(() => runtime.said.length === 2);
  assert.equal(agent.activity, "collect 10 oak_log");
  assert.deepEqual(runtime.cancelled, []);
  await until(() => runtime.said.length === 3, 5_000);
  assert.deepEqual(runtime.said, ["On it.", "Chopping away!", "Done!"]);
});

test("a finished task is reported in character", async () => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(runtime);
  chat.reply({ say: "Sure.", route: "act", request: "collect 4 dirt" }, { say: "Got your dirt!" });
  action.reply({ steps: [{ skill: "collect_block", block: "dirt", count: 4 }] });
  await agent.handle({ username: "Steve", channel: "whisper", message: "could u dig a bit of dirt, like 4", addressed: false });
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "collect_block")?.input, { block_name: "dirt", count: 4 });
  assert.deepEqual(runtime.said, ["Sure.", "Got your dirt!"]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /is finished: collected 4 dirt/u);
});

test("a bigger job escalates to the planner, says it needs thinking, and runs the plan in order", async () => {
  const runtime = new FakeRuntime();
  const { agent, chat, action, planner } = agentFor(runtime);
  chat.reply({ say: "On it.", route: "act", request: "make a crafting_table" }, { say: "Hmm, I need logs first, let me think." }, { say: "Here's your table." });
  action.reply({ escalate: "needs logs first" });
  planner.reply({ steps: [{ skill: "collect_block", block: "oak_log", count: 1 }, { skill: "craft_item", item: "crafting_table" }] });
  await agent.handle(say("Steve", "Ayla can you make a crafting table"));
  await until(() => runtime.said.length === 3);
  assert.deepEqual(runtime.said, ["On it.", "Hmm, I need logs first, let me think.", "Here's your table."]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /harder than it first looked \(needs logs first\)/u);
  assert.deepEqual(runtime.submitted.filter((call) => call.tool !== "send_message").map((call) => call.tool), ["collect_block", "craft_item"]);
  assert.deepEqual(runtime.submitted.find((call) => call.tool === "craft_item")?.input, { items: [{ item_name: "crafting_table", count: 1 }] });
});

test("an impossible request is explained, not attempted", async () => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(runtime);
  chat.reply({ say: "Hmm, let me see.", route: "act", request: "build Steve a castle" }, { say: "Castles are beyond me for now!" });
  action.reply({ impossible: "no building skill" });
  await agent.handle(say("Steve", "build me a castle"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["send_message", "send_message"]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /failed: cannot do that: no building skill/u);
});

test("a rival turns requests into words: the action tier is never asked", async () => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(runtime, "rival");
  chat.reply({ say: "Follow you? Dream on.", route: "act", request: "follow Steve" });
  await agent.handle(say("Steve", "follow me"));
  await until(() => runtime.said.length === 1);
  assert.deepEqual(runtime.submitted.map((call) => call.tool), ["send_message"]);
  assert.equal(action.requests.length, 0);
  assert.equal(agent.activity, "idle");
});

test("a house the agent built becomes a known place, with its roof, for the next requests", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL_HOUSE, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
  const { agent, chat, action } = agentFor(runtime);
  chat.reply({ say: "Sure.", route: "act", request: "build Steve a small house" }, { say: "Done!" });
  action.reply({ steps: [{ skill: "build" }] });
  await agent.handle(say("Steve", "build me a house"));
  await until(() => runtime.said.length === 2);
  assert.match(action.requests[0]?.[1]?.content ?? "", /- Places you know: none\./u);

  chat.reply({ say: "Up I go.", route: "act", request: "go to the roof of the house" }, { say: "Nice view." });
  action.reply({ steps: [{ skill: "go_to", x: -4, y: 70, z: 0 }] });
  await agent.handle(say("Steve", "go to the roof"));
  await until(() => runtime.said.length === 4);
  const places = "- Places you know: the small medieval house you built for Steve (door -2 64 0 facing east; stand on its roof at -4 70 0).";
  assert.ok((chat.requests[2]?.[1]?.content ?? "").includes(places), "the chat tier knows it");
  assert.ok((action.requests[1]?.[1]?.content ?? "").includes(places), "the action tier knows it");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate").at(-1)?.input, { x: -4, y: 70, z: 0, range: 1 });
});

test("other agents are not heard, and the chat tier may decide a message is not for us", async () => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(runtime);
  await agent.handle(say("Vex", "Ayla come here"));
  assert.equal(chat.requests.length, 0);
  chat.reply({ say: "", route: "ignore", request: "" }, { say: "Hello Steve.", route: "talk", request: "" });
  await agent.handle(say("Alex", "anyone want to trade"));
  await agent.handle(say("Steve", "hi there"));
  await until(() => runtime.said.length === 1);
  assert.deepEqual(runtime.said, ["Hello Steve."]);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Alex: "anyone want to trade"/u);
});
