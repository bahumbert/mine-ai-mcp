import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentOptions } from "./agent.ts";
import { EveryoneLines } from "./everyone-lines.ts";
import { ConversationBudget, type ConversationController } from "./conversation/controller.ts";
import { INSTANT_TYPING } from "./body.ts";
import type { BrainEvent } from "./brain-log.ts";
import type { Persona } from "./persona.ts";
import { memoryNote, recall } from "./memory.ts";
import { FakeRuntime, scriptedMind, SMALL_MEDIEVAL_HOUSE, testPersona, until } from "./testing.ts";
import { planFollowStep } from "./skills.ts";
import type { AgentRelations } from "./relations/agent-relations.ts";
import { TradeBoard } from "./relations/board.ts";
import type { Handoff } from "./relations/handoff.ts";
import type { TradeAsks } from "./relations/trading.ts";

function steveAt(x: number) {
  return { username: "Steve", position: { x, y: 64, z: 0 } };
}

/** A running agent (chat handling and work loop) over a fake runtime; stopped when the test ends. */
function agentFor(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: ["Vex"], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, ...options });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, ...tiers };
}

/** A chat line; addressed to her (her name in it) unless said otherwise: only those start a conversation (owner rule). */
function say(username: string, message: string, addressed = true) {
  return { username, channel: "chat" as const, message, addressed };
}

/** Who each spoken line went to: a player's name for a whisper, undefined for public chat. */
function spokenTo(runtime: FakeRuntime): unknown[] {
  return runtime.submitted.filter((call) => call.tool === "send_message").map((call) => call.input.to);
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
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 5 birch_log -> failed: no birch_log within 64 blocks, and you know of none farther away: .*\[NO_LOADED_MATCHING_TARGETS\]/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /You stopped working on "collect 5 birch_log": there is no birch_log nearby/u);
});

test("the same step failing the same way several times in a row ends the objective instead of looping", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  // Two in a row: a step failed twice is refused from then on (one retry), so the guard is tried at its smallest.
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 2 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "I can't find any birch, sorry!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect, collect);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 5 birch_log failed the same way 2 times in a row: no birch_log within 64 blocks/u);
  assert.equal(action.requests.length, 2);
});

test("the same failure between other steps ends the objective too", async (t) => {
  // Live 2026-10-09: Ayla's farm in a cave failed "25 not tillable (air)" 20 times, each after a different step.
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  runtime.failures.craft_item = "[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: birch_thing.";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 2 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "I can't find any birch, sorry!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  const craft = { step: { skill: "craft_item", item: "birch_thing", count: 1 } };
  action.reply(collect, craft, collect, craft);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 3);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 5 birch_log failed the same way 2 times: no birch_log within 64 blocks/u);
});

test("the same step done again and again ends the objective as changing nothing only when the inventory stayed the same", async (t) => {
  const collect = { step: { skill: "collect_block", block: "cobblestone", count: 32 } };
  {
    // Live 2026-10-09: three "collected 32 cobblestone" in a row ended objectives although each gained items.
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "collect 96 cobblestone" }, { say: "Got them!" });
    action.reply(collect, collect, collect, collect, { done: "96 cobblestone collected" });
    await agent.handle(say("Steve", "get me 96 cobblestone"));
    await until(() => runtime.said.length === 2);
    // 4 calls: the second identical step goes back once ("just succeeded") and is sent again.
    assert.equal(action.requests.length, 4, "the objective ended after the third identical step that gained");
    assert.doesNotMatch(chat.requests[1]?.[1]?.content ?? "", /changed nothing/u);
    assert.match(chat.requests[1]?.[1]?.content ?? "", /the same step \(collect 32 cobblestone\) was done 3 times in a row and the objective is not reached/u);
  }
  {
    const runtime = new FakeRuntime();
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "collect 96 cobblestone" }, { say: "Nothing is happening, sorry!" });
    action.reply(collect, collect, collect, collect, collect);
    await agent.handle(say("Steve", "get me 96 cobblestone"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 4);
    assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 32 cobblestone changed nothing 3 times in a row: collected 32 cobblestone/u);
  }
});

test("the same successful step three times in a row ends the objective as failed (not reached); a failure or another step in between resets the count", async (t) => {
  // Live 2026-10-11 run 10: "collect 16 dirt" 60+ times under one own objective, each gaining.
  const dirt = { step: { skill: "collect_block", block: "dirt", count: 16 } };
  const sand = { step: { skill: "collect_block", block: "sand", count: 16 } };
  {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "dig dirt" }, { say: "Done!" });
    action.reply(dirt, dirt, dirt, dirt);
    await agent.handle(say("Steve", "dig dirt"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 4, "the model was not asked after the third step (the second went back once as just succeeded)");
    assert.match(chat.requests[1]?.[1]?.content ?? "", /the same step \(collect 16 dirt\) was done 3 times in a row and the objective is not reached/u);
    assert.doesNotMatch(chat.requests[1]?.[1]?.content ?? "", /changed nothing/u);
  }
  {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "dig dirt" }, { say: "Done!" });
    const submit = runtime.submit.bind(runtime);
    let collects = 0;
    runtime.submit = async (tool, input, ...rest) => {
      if (tool === "collect_block" && (collects += 1) === 2) runtime.failNext.collect_block = { error: "[NO_PATH] no route" };
      return submit(tool, input, ...rest);
    };
    action.reply(dirt, dirt, dirt, dirt, { done: "enough" });
    await agent.handle(say("Steve", "dig dirt"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 5, "done, failed, done: not ended");
  }
  {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "dig" }, { say: "Done!" });
    action.reply(dirt, sand, dirt, sand, { done: "enough" });
    await agent.handle(say("Steve", "dig"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 5, "two steps alternating: not ended");
  }
});

test("a drop that worked and is repeated ends the objective although the inventory changes in between", async (t) => {
  // Live 2026-10-10 run 7: drop, pick the items up again, drop... 26 times: the changing inventory counted as gaining.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "coal", count: 16 }] };
  let count = 16;
  for (let i = 0; i < 3; i++) {
    runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "coal", dropped: 16 }], effect: () => { count += 1; runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "coal", count }] }; } });
  }
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "make room" }, { say: "I keep dropping the same thing, sorry!" });
  const drop = { step: { skill: "drop_item", items: [{ item: "coal" }] } };
  action.reply(drop, drop, drop, drop, drop);
  await agent.handle(say("Steve", "make room"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 4);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /changed nothing 3 times in a row/u);
});

test("a step set aside for an order stays interrupted", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log for my base" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Coming!", route: "act", request: "come to Steve" }, { say: "Here I am." });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } }, { done: "I am next to Steve" }, { done: "enough wood for now" });
  await agent.handle(say("Steve", "come here please"));
  await until(() => action.requests.length === 4);
  const resumed = action.requests[3]?.[1]?.content ?? "";
  assert.match(resumed, /1\. collect 16 oak_log -> interrupted/u);
  });

test("one skill failing again and again, whichever way it is tried, ends the objective", async (t) => {
  // Live 2026-10-07: explore failed in every direction in turn for 12 minutes.
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded matching blocks.";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSkillFailuresInARow: 3 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect some wood" }, { say: "No wood around, sorry!" });
  action.reply(
    { step: { skill: "collect_block", block: "birch_log", count: 5 } },
    { step: { skill: "collect_block", block: "oak_log", count: 5 } },
    { step: { skill: "collect_block", block: "spruce_log", count: 5 } },
    { step: { skill: "collect_block", block: "acacia_log", count: 5 } },
  );
  await agent.handle(say("Steve", "get me some wood"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 3);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect block failed 3 times in a row, whichever way it was tried; the last: no spruce_log within 64 blocks/u);
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

test("whom she read a line as spoken to stays with it in the chat history, and her answer as spoken to the speaker", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Opus"], say: "", route: "ignore", request: "" }, { spoken_to: ["Ayla"], say: "Hello Steve!", route: "talk", request: "" }, { say: "Hi.", route: "talk", request: "" });
  await agent.handle(say("Steve", "Opus, teleport me"));
  await agent.handle(say("Steve", "hi Ayla"));
  await agent.handle(say("Steve", "how are you"));
  assert.match(chat.requests[2]?.[1]?.content ?? "", /Steve to Opus: "Opus, teleport me"\nSteve to [^:]+: "hi Ayla"\n[^\n]+ to Steve: "Hello Steve!"/u);
});

test("the brain's known names reach the chat tier, which tells her who a line calls", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime, { id: "vex", username: "Vex", displayName: "Vex" }, { knownNames: ["Opus"] });
  chat.reply({ spoken_to: ["Opus"], say: "", route: "ignore", request: "" });
  await agent.handle(say("Steve", "Opus, Vex is going through the Ocean without boat, you said you fixed that"));
  assert.match(chat.requests[0]?.[1]?.content ?? "", /This message calls Opus by name \(a name followed by a comma or colon\); it names you without calling you\./u);
});

test("a request she is already working on is not taken or queued again", async (t) => {
  // Live 2026-10-04: "thanks, no rush" while she fetched for Opus's house came back as "later" with the same request.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 300;
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log for Steve" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await agent.handle(say("Steve", "get me 16 logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "No rush, Steve!", route: "later", request: "Collect 16 oak_log for Steve." }, { say: "Sure!", route: "act", request: "collect 16 oak_log for Steve" });
  await agent.handle(say("Steve", "thanks, no rush"));
  await agent.handle(say("Steve", "you got it?"));
  assert.deepEqual(runtime.cancelled, [], "the collection goes on");
  assert.doesNotMatch(agent.activity, /set aside/u);
});

test("a player's request never waits behind the character's own goal: a \"later\" reply is sent back to be corrected", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log for my base" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));

  chat.reply({ say: "Right after these logs!", route: "later", request: "come to Steve" }, { say: "Coming!", route: "act", request: "come to Steve" });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } });
  await agent.handle(say("Steve", "come here please"));
  await until(() => runtime.cancelled.length === 1 && action.requests.length >= 2);
  const next = action.requests[1]?.[1]?.content ?? "";
  assert.match(next, /Objective \(asked by Steve\): "come to Steve"/u);
  assert.match(next, /Set aside until this one ends: "collect 16 oak_log for my base"/u);
  assert.equal(runtime.said[0], "Coming!");
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

test("her farms are places she knows, as they were at their last tend", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notes = [memoryNote({ kind: "farm", farm: { crop: "wheat_seeds", size: 9, centre: { x: 4, y: 63, z: 6 }, madeAt: "2026-10-02T20:00:00.000Z", tendedAt: "2026-10-02T20:00:00.000Z", state: { planted: 80, ripe: 0, empty: 0 } } })];
  const { planner } = agentFor(t, runtime, { goal: "live well" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  assert.match(planner.requests[0]?.[1]?.content ?? "", /your wheat_seeds farm \(9x9 around 4 63 6; 80 planted, 0 ripe, 0 empty when you last tended it, [^)]* ago; farming it again harvests what is ripe and replants it\)/u);
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
  // The memories, then its activity notes, to forget those older than its last hour of play.
  assert.equal(runtime.queries.length, 2);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5, farms: 4, times: 10 }).unfinished, house);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5, farms: 4, times: 10 }).places.map((place) => place.name), ["the small medieval house you built for Steve"]);
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

test("on its own goal, the chat tier is not offered \"later\"; working for someone, it is", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "gather logs" });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Hi!", route: "talk", request: "" });
  await agent.handle(say("Steve", "hi"));
  assert.doesNotMatch(chat.requests[0]?.[0]?.content ?? "", /"later" =/u);
});

test("the journal gets what it takes on, its stack, each step with its input and thought, and how it ended", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: [], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, journal: (event) => events.push(event) });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  tiers.chat.reply({ say: "Sure.", route: "act", request: "collect 2 dirt" }, { say: "Done!" });
  tiers.action.reply({ thought: "Dirt is right here.", step: { skill: "collect_block", block: "dirt", count: 2 } }, { done: "2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  assert.deepEqual(events.filter((event) => event.kind === "objective").map((event) => [event.event, event.text, event.requester]), [["taken", "collect 2 dirt", "Steve"], ["finished", "collect 2 dirt", "Steve"]]);
  const step = events.find((event) => event.kind === "step");
  assert.deepEqual(step && { ...step, ms: 0, times: step.kind === "step" ? step.times?.map((time) => time.activity) : undefined }, { kind: "step", objective: "collect 2 dirt", requester: "Steve", step: "collect 2 dirt", input: { skill: "collect_block", block: "dirt", count: 2 }, thought: "Dirt is right here.", outcome: "done", detail: "collected 2 dirt", ms: 0, activity: "digging", times: ["digging"], purpose: null });
  const states = events.filter((event) => event.kind === "state");
  assert.ok(states.some((state) => state.step === "collect 2 dirt" && state.stack.length === 1));
  assert.deepEqual(states.at(-1), { kind: "state", stack: [], step: null });
});

test("the goal tier sees what could use doing and how the last hour went, time recalled from an earlier run", async (t) => {
  const runtime = new FakeRuntime();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  runtime.notes = [
    memoryNote({ kind: "activity_time", time: { activity: "mining", ended: minutesAgo(90), minutes: 30 } }),
    memoryNote({ kind: "activity_time", time: { activity: "farming", ended: minutesAgo(20), minutes: 12 } }),
    memoryNote({ kind: "activity_time", time: { activity: "building", ended: minutesAgo(5), minutes: 4 } }),
  ];
  runtime.snapshot = { ...runtime.snapshot, food: 15, inventory: [{ name: "oak_log", count: 4 }, { name: "stone_pickaxe", count: 1, durability: { remaining: 5, maximum: 131 } }, { name: "wooden_sword", count: 1 }, { name: "wooden_axe", count: 1 }, { name: "red_bed", count: 1 }] };
  runtime.recipes = { spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] } };
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval", preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const [system, request] = [planner.requests[0]?.[0]?.content ?? "", planner.requests[0]?.[1]?.content ?? ""];
  assert.match(system, /You love farming and like building; you dislike fighting monsters and hate mining\./u);
  // The last hour of play, not of the clock: mining that ended 90 min ago is still in it (spec 2026-10-04).
  assert.match(request, /How you spent the last hour: mining 30 min, farming 12 min, building 4 min\./u);
  // The ones for the activities drawn come first (a random draw here), so the order is not asserted.
  assert.match(request, /Things that could use doing, by what they are for: \n- \(/u);
  assert.match(request, /- \(crafting\) your stone_pickaxe has 5 uses left/u);
  assert.match(request, /- \(farming, hunting, cooking\) you carry no food; your hunger is 15\/20/u);
  assert.match(request, /- \(building\) you have no house of your own yet/u);
  // A house's materials are for building; each says the work get_items would do for it: logs are cut, stairs crafted.
  assert.match(request, /- \(building\) a house of your own needs [^\n]*20 more oak_log \(cutting wood\)/u);
  assert.match(request, /- \(building\) a house of your own needs [^\n]*spruce_stairs[^\n]*\(crafting\)/u);
  assert.match(request, /- \(farming\) you have no farm yet/u);
});

test("each finished step counts towards its activity, for the next goal call", async (t) => {
  const runtime = new FakeRuntime();
  const { planner, action } = agentFor(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get some stone" }, { objective: "rest a while" });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 2 } }, { done: "got stone" });
  await until(() => planner.requests.length === 2);
  assert.match(planner.requests[1]?.[1]?.content ?? "", /How you spent the last hour: mining under a minute\./u);
  assert.match(planner.requests[0]?.[1]?.content ?? "", /How you spent the last hour: nothing yet\./u);
});

/** A running agent that also reports its journal. */
function journaledAgent(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const events: BrainEvent[] = [];
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: [], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, journal: (event) => events.push(event), ...options });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, events, ...tiers };
}

test("an own objective carries the purpose the goal tier gave; every step under it counts for it, its gathering included", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get logs for my house", for: "building" }, { objective: "rest", for: "none" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 2 } }, { done: "got logs" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.equal(own?.kind === "objective" ? own.purpose : "missing", "building");
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === "building" && step.activity === "woodcutting", "cut for building");
});

test("an objective that runs a house or farm step is for that work from then on, whatever the goal tier labelled it (run 11)", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get stone for my house", for: "mining" }, { objective: "rest", for: "none" });
  action.reply(
    { step: { skill: "collect_block", block: "stone", count: 1 } },
    { step: { skill: "improve_house" } },
    { step: { skill: "collect_block", block: "stone", count: 2 } },
    { done: "got stone" },
  );
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  assert.deepEqual(events.flatMap((event) => event.kind === "step" ? [event.purpose] : []), ["mining", "building", "building"]);
});

test("a goal reply with no usable \"for\" has no purpose", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get stone", for: "knitting" }, { objective: "rest" });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 1 } }, { done: "got stone" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.equal(own?.kind === "objective" ? own.purpose : "missing", null);
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === null);
});

test("a request's purpose is the work the chat tier named; \"none\" is no purpose", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, events, chat, action } = journaledAgent(t, runtime, { preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } });
  chat.reply({ work: "mining", say: "Ugh.", route: "act", request: "mine 2 stone" }, { say: "Done." }, { work: "none", say: "Sure.", route: "act", request: "say hi to Tom" }, { say: "Done." });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 2 } }, { done: "2 stone" }, { done: "said hi" });
  await agent.handle(say("Steve", "mine me 2 stone"));
  await until(() => events.filter((event) => event.kind === "objective" && event.event === "finished").length === 1);
  await agent.handle(say("Steve", "say hi to Tom"));
  await until(() => events.filter((event) => event.kind === "objective" && event.event === "finished").length === 2);
  assert.deepEqual(events.flatMap((event) => event.kind === "objective" && event.event === "taken" ? [[event.text, event.purpose]] : []), [["mine 2 stone", "mining"], ["say hi to Tom", null]]);
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === "mining");
});

const BUILDER = { loves: "building", likes: "farming", dislikes: "mob_combat", hates: "mining" } as const;

test("the goal call draws two activities by their chances and tells the goal tier; the journal keeps the draw", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", preferences: BUILDER }, { random: () => 0 });
  planner.reply({ objective: "build a house", for: "building" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  assert.match(planner.requests[0]?.[1]?.content ?? "", /Right now you feel most like building, or else farming\./u);
  assert.match(planner.requests[0]?.[0]?.content ?? "", /one of building, reshaping ground, farming, mining, cutting wood, digging out a cellar, a pond or a tunnel, foraging, exploring, crafting, cooking/u);
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  assert.deepEqual(own.drawn, ["building", "farming"]);
  assert.equal(own.purpose, "building");
  assert.equal(own.chances?.length, 5, "the top five");
  assert.deepEqual(own.chances?.slice(0, 2).map((entry) => entry.activity), ["building", "farming"]);
  assert.ok(own.chances?.every((entry, index, all) => index === 0 || all[index - 1]!.chance >= entry.chance));
});

test("an activity the last hour went to for is less likely, by purpose: cutting logs for a house counts against building", async (t) => {
  const runtime = new FakeRuntime();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  runtime.notes = [memoryNote({ kind: "activity_time", time: { activity: "woodcutting", purpose: "building", ended: minutesAgo(5), minutes: 30 } })];
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", preferences: BUILDER }, { random: () => 0 });
  planner.reply({ objective: "tend my farm", for: "farming" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  // Building: 2 × (1 − 30/60) = 1 against farming 1.5, so farming is now the likeliest; woodcutting itself was no choice.
  assert.deepEqual(own.drawn?.[0], "farming");
  const chance = (activity: string) => own.chances?.find((entry) => entry.activity === activity)?.chance ?? NaN;
  assert.ok(Math.abs(chance("building") / chance("farming") - 1 / 1.5) < 1e-9);
  // Ten available activities: building 1, farming 1.5, mining (hated) 0.3, seven neutral at 1 (woodcutting among them: the
  // logs were cut for building, so they did not count against it).
  assert.ok(Math.abs(chance("farming") - 1.5 / 9.8) < 1e-9);
});

test("only what a skill of the persona can do is drawn, and an animal in sight makes hunting available", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, mobs: [{ name: "cow", hostile: false, count: 2, distance: 9 }] };
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", skills: ["build", "hunt"] }, { random: () => 0 });
  planner.reply({ objective: "build" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  assert.deepEqual(own.chances?.map((entry) => entry.activity).sort(), ["building", "hunting"]);
});

test("three quick lines from one player are read together and answered once", async (t) => {
  const runtime = new FakeRuntime();
  const { chat, events } = journaledAgent(t, runtime, { settings: { ...testPersona().settings, chatBurstMs: 60 } });
  chat.reply({ spoken_to: ["Ayla"], say: "I'm here!", route: "talk", request: "" });
  runtime.inbox.push(say("Steve", "Ayla"), say("Steve", "are you there?"), say("Steve", "I need help"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 1);
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Steve says in chat, naming you: "Ayla are you there\? I need help"/u);
  assert.deepEqual(events.filter((event) => event.kind === "chat").map((event) => [event.lines, event.superseded]), [[3, false]]);
});

test("a line after the burst window is a message of its own", async (t) => {
  const runtime = new FakeRuntime();
  const { chat } = journaledAgent(t, runtime, { settings: { ...testPersona().settings, chatBurstMs: 30 } });
  chat.reply({ spoken_to: ["Ayla"], say: "One.", route: "talk", request: "" }, { spoken_to: ["Ayla"], say: "Two.", route: "talk", request: "" });
  runtime.inbox.push(say("Steve", "Ayla, first"));
  await until(() => runtime.said.length === 1);
  runtime.inbox.push(say("Steve", "Ayla, second"));
  await until(() => runtime.said.length === 2);
  assert.equal(chat.requests.length, 2);
});

test("a reply whose speaker said something since is dropped unspoken; the newest line is read with the older one in history", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, events } = journaledAgent(t, runtime);
  const release = chat.hold();
  chat.reply(
    { spoken_to: ["Ayla"], say: "On it!", route: "act", request: "build Steve a house" },
    { spoken_to: ["Ayla"], say: "Stopping.", route: "stop", request: "" },
  );
  runtime.inbox.push(say("Steve", "Ayla build a house"));
  await until(() => chat.requests.length === 1);
  runtime.inbox.push(say("Steve", "Ayla no wait, stop"));
  await sleep(40);
  release();
  await until(() => runtime.said.length === 1);
  // One answer, to the latest state: the stale "On it!" was never spoken and nothing was taken on.
  assert.deepEqual(runtime.said, ["Stopping."]);
  assert.equal(chat.requests.length, 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Steve to Ayla: "Ayla build a house"/u);
  assert.equal(agent.activity, "idle");
  assert.deepEqual(events.filter((event) => event.kind === "objective"), []);
  assert.deepEqual(events.filter((event) => event.kind === "chat").map((event) => [event.text, event.superseded]), [["Ayla build a house", true], ["Ayla no wait, stop", false]]);
});

test("a superseded stop still stops; only its line is dropped", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base", settings: { ...testPersona().settings, restAfterStopSeconds: 60 } });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  const release = chat.hold();
  chat.reply(
    { spoken_to: ["Ayla"], say: "Okay, stopping.", route: "stop", request: "" },
    { spoken_to: ["Ayla"], say: "Right.", route: "talk", request: "" },
  );
  runtime.inbox.push(say("Steve", "Ayla, stop"));
  await until(() => chat.requests.length === 1);
  runtime.inbox.push(say("Steve", "Ayla, please"));
  await sleep(40);
  release();
  await until(() => runtime.said.length === 1);
  await until(() => runtime.cancelled.length === 1);
  assert.deepEqual(runtime.said, ["Right."]);
  assert.equal(agent.activity, "idle");
  await sleep(300);
  assert.equal(planner.requests.length, 1, "no new own objective while resting");
});

test("another player's line does not supersede a reply", async (t) => {
  const runtime = new FakeRuntime();
  const { chat } = journaledAgent(t, runtime);
  const release = chat.hold();
  chat.reply({ spoken_to: ["Ayla"], say: "Hi Steve!", route: "talk", request: "" }, { spoken_to: ["Ayla"], say: "Hi Bob!", route: "talk", request: "" });
  runtime.inbox.push(say("Steve", "hi Ayla"));
  await until(() => chat.requests.length === 1);
  runtime.inbox.push(say("Bob", "hi Ayla"));
  await sleep(40);
  release();
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Hi Steve!", "Hi Bob!"]);
});

test("an order is stored with its speaker as requester; a stray \"for\" in the reply is ignored", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3), { username: "Bob", position: { x: 5, y: 64, z: 0 } }] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 2 dirt", for: "Bob" }, { say: "Done!" });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 2 } }, { done: "collected 2 dirt" });
  await agent.handle(say("Steve", "Ayla, get 2 dirt for Bob"));
  await until(() => action.requests.length >= 1);
  assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "collect 2 dirt"/u);
});

test("a whisper is answered by whisper, a public line in public chat", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], say: "Between us.", route: "talk", request: "" }, { spoken_to: ["Ayla"], say: "For everyone.", route: "talk", request: "" });
  await agent.handle({ username: "Steve", channel: "whisper", message: "psst", addressed: false });
  await agent.handle(say("Steve", "Ayla, hello"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Between us.", "For everyone."]);
  assert.deepEqual(spokenTo(runtime), ["Steve", undefined]);
});

test("an order given by whisper is narrated by whisper to the one who gave it; one given in public stays public", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Got it!" });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 2 } }, { done: "collected 2 dirt" });
  await agent.handle({ username: "Steve", channel: "whisper", message: "get me 2 dirt", addressed: false });
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["On it.", "Got it!"]);
  assert.deepEqual(spokenTo(runtime), ["Steve", "Steve"]);
  chat.reply({ spoken_to: ["Ayla"], say: "Sure.", route: "act", request: "collect 3 dirt" }, { say: "Done." });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 3 } }, { done: "collected 3 dirt" });
  await agent.handle(say("Steve", "Ayla, get 3 dirt"));
  await until(() => runtime.said.length === 4);
  assert.deepEqual(spokenTo(runtime), ["Steve", "Steve", undefined, undefined]);
});

/** Orders asking, one after the other, for a craft that has no recipe (live 2026-10-10: it failed in six objectives). */
function craftOrders(t: Parameters<typeof agentFor>[0]) {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const tiers = agentFor(t, runtime);
  let said = 0;
  const order = async (request: string, ...steps: object[]) => {
    const before = tiers.action.requests.length;
    tiers.chat.reply({ say: "Okay!", route: "act", request }, { say: "Can't, sorry." });
    tiers.action.reply(...steps);
    await tiers.agent.handle(say("Steve", request));
    said += 2;
    await until(() => runtime.said.length === said);
    return tiers.action.requests.slice(before).map((request) => request.at(-1)?.content ?? "");
  };
  return { order, runtime };
}

const CRAFT = { step: { skill: "craft_item", item: "cooked_beef", count: 3 } };

test("a step that failed once is shown to the work tier (its own objective only), and runs again", async (t) => {
  const { order } = craftOrders(t);
  const prompts = await order("cook 3 beef", CRAFT, CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(prompts[0] ?? "", /failed lately/u);
  assert.match(prompts[1] ?? "", /Steps that failed lately in this objective[^\n]*\n- craft 3 cooked_beef, 1 minute ago: \[ITEMS_NOT_CRAFTABLE\]/u);
  assert.equal(prompts.length, 3, "the second try ran, no send-back");
});

test("a step that failed twice is refused every time, for any objective, until the 30 minutes are over", async (t) => {
  let offset = 0;
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + offset);
  const { order } = craftOrders(t);
  await order("cook 3 beef", CRAFT, { give_up: "No recipe." });
  // Failed once for the first order: it runs (second failure); then refused, on every try, until the objective ends.
  const prompts = await order("make me cooked beef then", CRAFT, CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(prompts[0] ?? "", /failed lately/u, "another objective's failure is guarded by key, not shown");
  assert.match(prompts[1] ?? "", /- craft 3 cooked_beef, failed 2 times, the last 1 minute ago \(refused now\)/u);
  assert.match(prompts[2] ?? "", /"craft 3 cooked_beef" failed 2 times in the last 30 minutes.*refused: choose a different step, or give this objective up/u);
  assert.equal(prompts.length, 4, "refused at every try until the third refusal ended the objective");
  offset = 31 * 60_000;
  const later = await order("cook me 3 beef", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(later[0] ?? "", /failed lately/u);
  assert.equal(later.length, 2, "forgotten after 30 minutes: it ran");
});

test("a step refused three times ends the objective as failed; the count restarts when the step is allowed and runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  const ended = () => events.filter((event) => event.kind === "objective" && event.event === "finished");
  chat.reply({ say: "Okay!", route: "act", request: "cook 3 beef" }, { say: "No." });
  // Two failures, then the third send is refused three times in a row: the objective ends.
  action.reply(CRAFT, CRAFT, CRAFT, CRAFT, CRAFT);
  await agent.handle(say("Steve", "cook me 3 beef"));
  await until(() => ended().length === 1);
  const first = ended()[0];
  assert.equal(first?.kind === "objective" && first.outcome, "failed");
  assert.match(first?.kind === "objective" ? first.detail ?? "" : "", /^"craft 3 cooked_beef" was refused 3 times: it failed 2 times lately \(\[ITEMS_NOT_CRAFTABLE\][^)]*\) and nothing changed since$/u);
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, 2);
});

test("the refusal count of a step restarts when the step is allowed and runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const { agent, events, chat, action } = journaledAgent(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 10 } });
  runtime.simulateInventory = true;
  const DIRT = { step: { skill: "collect_block", block: "dirt", count: 1 } };
  chat.reply({ say: "Okay!", route: "act", request: "cook 3 beef" }, { say: "Cooked!" });
  // Fails twice, refused once, then the dirt changes the inventory: allowed, runs (fails), and two more refusals make
  // 2, not 3 (1 + 2 would have ended the objective).
  action.reply(CRAFT, CRAFT, CRAFT, DIRT, CRAFT, CRAFT, CRAFT, { done: "ok" });
  await agent.handle(say("Steve", "cook me 3 beef"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const finished = events.find((event) => event.kind === "objective" && event.event === "finished");
  assert.equal(finished?.kind === "objective" && `${finished.outcome}: ${finished.detail}`, "done: ok");
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, 3);
});

test("a refused step is allowed again when the inventory changed or the bot moved 8 blocks since its last failure (rule 2)", async (t) => {
  const { order, runtime } = craftOrders(t);
  const crafts = () => runtime.submitted.filter((call) => call.tool === "craft_item").length;
  await order("cook 3 beef", CRAFT, CRAFT, { give_up: "No recipe." });
  assert.equal(crafts(), 2);
  const unchanged = await order("cook some beef", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(unchanged[0] ?? "", /failed lately/u, "another objective's failure is guarded by key, not shown");
  assert.equal(crafts(), 2, "nothing changed: refused");
  runtime.addItem("oak_log", 1);
  const carried = await order("cook the beef", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(carried[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3, "the inventory changed: it ran");
  // That run failed again with the new inventory as its state: refused again until something else changes.
  const again = await order("cook beef now", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(again[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 7, y: 64, z: 0 } };
  const near = await order("cook beef please", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(near[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3, "7 blocks away is still the same place");
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 0 } };
  const moved = await order("cook beef then", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(moved[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 4, "8 blocks away: it ran");
});

const HUNT = { step: { skill: "hunt", mob: "glow_squid", drop: "ink_sac", count: 8 } };
/** A short window (0.002 minutes = 120 ms) looked at every 10 ms, instead of 5 minutes every 30 seconds. */
const QUICK_GAIN = { noGain: { minutes: 0.002, sampleMs: 10 } };

test("a step out to obtain items that gains none for the whole window is stopped and fails, saying how far it got", async (t) => {
  // Live 2026-10-09: Vex's "hunt glow_squid for 8 ink_sac" ran to the time limit three times, gaining nothing.
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 100_000;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "No squid, sorry!" });
  action.reply(HUNT, { give_up: "no squid" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the hunt was stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. hunt glow_squid for 8 ink_sac -> failed: nothing gained in 0\.002 minutes: 0 of 8 ink_sac so far \(the rest is in your inventory\)/u);
});

// Review V3: WSL resyncs its wall clock forward after the host wakes; the no-gain window must not read that as minutes.
test("a 60 s wall clock step does not stop a step that keeps gaining", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("ink_sac", 1), 30);
  const realNow = Date.now;
  const stepAt = realNow() + 100;
  Date.now = () => realNow() + (realNow() >= stepAt ? 60_000 : 0);
  t.after(() => {
    Date.now = realNow;
    clearInterval(gains);
  });
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  // Waited on the monotonic clock: `until` reads the stepped one.
  const deadline = performance.now() + 5_000;
  while (runtime.said.length < 2 && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(runtime.cancelled.length, 0, "gaining every 30 ms: a clock step is not 60 s without a gain");
});

/** A fetch for logs seen 900 blocks away: nothing near, so it walks there (the first `navigate` takes `duration` polls, later ones none) before gathering. */
function farFetch(duration: number) {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  const submit = runtime.submit.bind(runtime);
  let trips = 0;
  runtime.submit = (tool, input) => {
    if (tool === "navigate") runtime.durations.navigate = trips++ === 0 ? duration : 0;
    return submit(tool, input);
  };
  runtime.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either." };
  runtime.seen = { oak_log: { dimension: "overworld", x: 900, z: 0 } };
  return runtime;
}
const FETCH = { step: { skill: "get_items", items: [{ item: "oak_log", count: 2 }] } };

test("a fetch travelling to the place it saw the block gets nearer: that is progress for the no-gain stop (live 2026-10-10 run 9: Kenji's boat trip)", async (t) => {
  const runtime = farFetch(400);
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  // 20 blocks nearer every 30 ms against a 120 ms window: no item rises for 400 ms, yet it is not stopped.
  const walking = setInterval(() => { runtime.snapshot = { ...runtime.snapshot, position: { ...runtime.snapshot.position, x: runtime.snapshot.position.x + 20 } }; }, 30);
  t.after(() => clearInterval(walking));
  chat.reply({ say: "Okay!", route: "act", request: "get 2 oak_log" }, { say: "Got them!" });
  action.reply(FETCH, { done: "got the logs" });
  await agent.handle(say("Steve", "get me 2 oak logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "getting nearer is progress");
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2, "it arrived and gathered");
});

test("a fetch travelling that gets no nearer is stopped after the window, as before", async (t) => {
  const runtime = farFetch(100_000);
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "get 2 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(FETCH, { give_up: "stuck" });
  await agent.handle(say("Steve", "get me 2 oak logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the walk was stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /get 2 oak_log -> failed: nothing gained in 0\.002 minutes: 0 of 2 oak_log so far/u);
});

test("a step whose items keep increasing is not stopped, and a collect step is looked at too (any step has the silence limit)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  runtime.durations.collect_block = 300;
  const statuses = { calls: 0 };
  const status = runtime.status.bind(runtime);
  runtime.status = async () => {
    statuses.calls += 1;
    return status();
  };
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("ink_sac", 1), 30);
  t.after(() => clearInterval(gains));
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "gaining every 30 ms against a 120 ms window: not stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. hunt glow_squid for 8 ink_sac -> done/u);
  clearInterval(gains);
  const sampled = statuses.calls;
  runtime.durations.collect_block = 50;
  chat.reply({ say: "Okay!", route: "act", request: "collect 1 dirt" }, { say: "Done!" });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 1 } }, { done: "dirt" });
  await agent.handle(say("Steve", "get me a dirt"));
  await until(() => runtime.said.length === 4, 5_000);
  assert.equal(runtime.cancelled.length, 0, "the collect step (about 300 ms, moving or not) is not cancelled");
  assert.ok(sampled > 15, `the hunt was sampled (${sampled} calls)`);
});

test("a step whose target never rises but another item does is not stopped; one where nothing rises still is", async (t) => {
  // Live 2026-10-10 run 8: "get 48 dark_oak_stairs" gathered 20 dark_oak_log for its planks and was stopped for no stairs.
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("dark_oak_log", 1), 30);
  t.after(() => clearInterval(gains));
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "logs rising against a 120 ms window: the chain is progressing");
  clearInterval(gains);
  runtime.durations.collect_mob_drop = 100_000;
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "No squid, sorry!" });
  action.reply(HUNT, { give_up: "no squid" });
  await agent.handle(say("Steve", "get me 8 ink sacs again"));
  await until(() => runtime.said.length === 4, 5_000);
  assert.equal(runtime.cancelled.length, 1, "nothing rose: stopped as before");
});

test("with no house the goal tier is told what a small one takes and which full blocks she carries", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["bread"]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 150 }, { name: "cobblestone", count: 64 }, { name: "oak_door", count: 1 }, { name: "bread", count: 3 }] };
  runtime.recipes = { spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] } };
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /- \(building\) you have no house of your own yet; a small house takes 16 foundation, 9 floor, 27 wall, [^\n]*; build can use other blocks per role: you carry 150 dirt, 64 cobblestone\n/u);
});

test("a temporary own house is a home: the goal tier sees what is temporary and what improving it needs", async (t) => {
  const runtime = new FakeRuntime();
  const place = {
    name: "the small medieval house you built", detail: "door 0 64 2 facing north", own: true,
    house: { size: "small" as const, style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north" as const, materials: { wall: "dirt" } },
  };
  runtime.notes = [memoryNote({ kind: "place", place })];
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /- \(building\) your house at door 0 64 2 is temporary: wall dirt \(your style: oak_planks\)/u);
  assert.match(request, /improving your house needs \d+ more oak_planks/u);
  assert.doesNotMatch(request, /no house of your own/u);
});

test("a step failing for a full inventory names the junk with its whole count (live 2026-10-10: 18 of 238 snowballs dropped per step)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [...Array.from({ length: 15 }, (_, index) => ({ name: "snowball", count: index === 0 ? 8 : 16 })), { name: "stone_pickaxe", count: 1 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "Full, sorry." });
  action.reply({ step: { skill: "collect_block", block: "birch_log", count: 5 } }, { step: { skill: "collect_block", block: "birch_log", count: 5 } });
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /232 snowball \(15 slots\)/u);
  assert.doesNotMatch(prompt, /1 stone_pickaxe \(1 slot\)/u, "the pickaxe is needed");
});

test("a give done and sent again identically goes back once, and the order ends done after one give", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  const give = { step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } };
  action.reply(give, give, { done: "Steve has 2 dirt" });
  await agent.handle(say("Steve", "give me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "drop_item").length, 1);
  assert.match(action.requests[2]?.at(-1)?.content ?? "", /just succeeded: if that did what was asked, answer done/u);
});

test("a line naming nobody, right after its speaker named another character, carries that as a fact for the others only (live 2026-10-11: 'thanks, no rush' answered by Ayla and Vex)", async (t) => {
  const asked: (string | undefined)[] = [];
  const seen = async (character: string, others: string[]) => {
    const runtime = new FakeRuntime();
    const tiers = scriptedMind();
    const mind = { ...tiers.mind, chat: (input: Parameters<typeof tiers.mind.chat>[0], signal: AbortSignal) => { asked.push(input.talkedTo === undefined ? undefined : `${input.talkedTo.name}@${input.talkedTo.secondsAgo}`); return tiers.mind.chat(input, signal); } } as typeof tiers.mind;
    const agent = new Agent({ persona: testPersona({ username: character, displayName: character }), runtime, mind, otherAgents: others, log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    t.after(async () => { controller.abort(); await running; });
    tiers.chat.reply({ route: "ignore", say: "", spoken_to: ["unclear"] }, { route: "ignore", say: "", spoken_to: ["unclear"] });
    await agent.handle(say("Tester", "Vex, mine some stone", false));
    await agent.handle(say("Tester", "thanks, no rush", false));
  };
  await seen("Ayla", ["Vex"]);
  assert.match(asked.at(-1) ?? "", /^Vex@\d+$/u);
  asked.length = 0;
  await seen("Vex", ["Ayla"]);
  assert.equal(asked.at(-1), undefined, "for Vex the line naming him is the conversation with him, not a fact");
});

test("the junk hint never lists what the objective gathers (live 2026-10-11: cobblestone listed for \"Mine cobblestone\")", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "cobblestone", count: 256 }, { name: "dirt", count: 128 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "Mine cobblestone" }, { say: "Full, sorry." });
  const mine = { step: { skill: "collect_block", block: "stone", count: 5 } };
  action.reply(mine, mine);
  await agent.handle(say("Steve", "mine some cobblestone"));
  await until(() => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /128 dirt/u);
  assert.doesNotMatch(prompt, /nothing you are doing needs[^"]*cobblestone/u);
});

test("a \"stop\" with a request while nothing runs is an order (live 2026-10-11, L7: \"release that area\" routed stop while idle); while busy it stops the work, then takes the request", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Releasing it.", route: "stop", request: "release that area" });
  action.reply({ done: "released" });
  await agent.handle(say("Steve", "release that area"));
  await until(() => action.requests.length >= 1);
  assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "release that area"/u);
  assert.deepEqual(runtime.cancelled, []);
  await until(() => agent.activity === "idle");

  const busy = new FakeRuntime();
  busy.durations.collect_block = 100_000;
  const second = agentFor(t, busy);
  second.chat.reply({ say: "Okay.", route: "act", request: "collect 16 oak_log" }, { say: "Stopped.", route: "stop", request: "release that area" });
  second.action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "released" });
  await second.agent.handle(say("Steve", "collect logs"));
  await until(() => busy.submitted.some((call) => call.tool === "collect_block"));
  await second.agent.handle(say("Steve", "release that area"));
  await until(() => busy.cancelled.length === 1);
  await until(() => second.action.requests.some((request) => /Objective \(asked by Steve\): "release that area"/u.test(request[1]?.content ?? "")));
  assert.equal(busy.cancelled.length, 1, "busy: the current work is stopped, then the request is the order (live 2026-10-11, L7)");
});

test("a chat poll that fails (the runtime restarting) is logged and retried at the next poll, the agent keeps listening (review B5)", async (t) => {
  const runtime = new FakeRuntime();
  const read = runtime.readMessages.bind(runtime);
  let calls = 0;
  runtime.readMessages = async () => {
    calls += 1;
    if (calls === 2) throw new Error("runtime restarting");
    return read();
  };
  const logs: string[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { log: (line) => logs.push(line) });
  chat.reply({ say: "Hello!", route: "talk", request: "" });
  await until(() => calls >= 3);
  runtime.inbox.push(say("Steve", "hello"));
  await until(() => spokenTo(runtime).length > 0);
  assert.ok(logs.some((line) => /runtime restarting/u.test(line)));
  assert.equal(agent.activity, "idle");
});

test("a chat poll that keeps failing is logged once, and again only after a read worked (review R17)", async (t) => {
  const runtime = new FakeRuntime();
  const read = runtime.readMessages.bind(runtime);
  let calls = 0;
  runtime.readMessages = async () => {
    calls += 1;
    if ((calls >= 2 && calls <= 6) || (calls >= 9 && calls <= 12)) throw new Error("runtime down");
    return read();
  };
  const logs: string[] = [];
  agentFor(t, runtime, {}, { log: (line) => logs.push(line) });
  await until(() => calls >= 14);
  assert.equal(logs.filter((line) => /chat unreadable/u.test(line)).length, 2, "one line per outage, not one per poll");
});

test("a stop with a request ends the speaker's orders and the character's own goals, the other players' queued orders stay (review R18)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply(
    { say: "Okay.", route: "act", request: "collect 16 oak_log" },
    { say: "Later.", route: "later", request: "mine stone" },
    { say: "Stopped.", route: "stop", request: "release that area" },
  );
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "released" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Alex", "mine stone"));
  await agent.handle(say("Steve", "release that area"));
  await until(() => action.requests.some((request) => /Objective \(asked by Steve\): "release that area"/u.test(request[1]?.content ?? "")));
  const stacks = events.flatMap((event) => event.kind === "state" ? [event.stack.map((work) => work.text)] : []);
  assert.deepEqual(stacks.filter((stack) => stack.length > 0 && !stack.includes("collect 16 oak_log")).at(0), ["mine stone"], "Steve's logs ended, Alex's queued order stayed");
  assert.ok(stacks.some((stack) => stack.join("|") === "mine stone|release that area"), "and the new request went on top of it");
  assert.equal(runtime.cancelled.length, 1);
});

test("a line naming nobody within 60 s of its speaker naming another character is ignored, unless the model says it speaks to her or everyone (A5, live 2026-10-11, L6)", async (t) => {
  const outcome = async (to: string[], afterMs: number) => {
    const runtime = new FakeRuntime();
    const tiers = scriptedMind();
    const mind = { ...tiers.mind, chat: async (input: { message: { message: string } }) => input.message.message === "thanks" ? { to, say: "You're welcome!", route: "talk" as const, request: "" } : { to: ["Vex"], say: "", route: "ignore" as const, request: "" } } as unknown as typeof tiers.mind;
    const agent = new Agent({ persona: testPersona({ username: "Ayla", displayName: "Ayla" }), runtime, mind, otherAgents: ["Vex"], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    t.after(async () => { controller.abort(); await running; });
    const now = Date.now.bind(Date);
    let offset = 0;
    const clock = t.mock.method(Date, "now", () => now() + offset);
    await agent.handle(say("Tester", "Vex, mine some stone", false));
    runtime.said.length = 0;
    offset = afterMs;
    await agent.handle(say("Tester", "thanks", false));
    clock.mock.restore();
    return runtime.said.length;
  };
  assert.equal(await outcome(["Tester"], 20_000), 0, "the model read it as for the speaker only: ignored");
  assert.equal(await outcome(["unclear"], 20_000), 0);
  assert.equal(await outcome(["unclear"], 70_000), 1, "70 s later: routed as before");
  assert.equal(await outcome(["Ayla"], 20_000), 1, "it names her");
  assert.equal(await outcome(["everyone"], 20_000), 1, "it names everyone");
});

test("a body that restarted under a step is one failed step: the objective goes on, no streak or repeat rule fires", async (t) => {
  // Both limits at their smallest: an ordinary failure would end the objective after this one step.
  const runtime = new FakeRuntime();
  runtime.throwNext.collect_block = "[BODY_RESTARTED] the body restarted: collect_block was not done";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 1, maxSkillFailuresInARow: 1 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "Done!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => action.requests.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 5 birch_log -> failed: \[BODY_RESTARTED\] the body restarted: collect_block was not done/u);
});

const COLLECT = { step: { skill: "collect_block", block: "oak_log", count: 16 } };

test("a step with no item target and no sign of life for the whole window is cancelled and fails, saying so (run 14: a step waited for ever)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(COLLECT, { give_up: "stuck" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the action was cancelled as by the agent");
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log -> failed: the action gave no sign of life for 0\.002 minutes/u);
});

test("a step with no item target that keeps moving is alive: a sign of life resets the clock", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 400;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const walking = setInterval(() => { runtime.snapshot = { ...runtime.snapshot, position: { ...runtime.snapshot.position, x: runtime.snapshot.position.x + 20 } }; }, 30);
  t.after(() => clearInterval(walking));
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Got them!" });
  action.reply(COLLECT, { done: "got the logs" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0);
});

test("the silence limit holds when the inventory read never answers (the clock is the wall clock, not an event)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const status = runtime.status.bind(runtime);
  runtime.status = () => (runtime.submitted.some((call) => call.tool === "collect_block") && runtime.cancelled.length === 0 ? new Promise(() => undefined) : status());
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(COLLECT, { give_up: "stuck" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1);
});

test("a plain stop from one player ends her work and the character's own goals, not another player's queued order (SF4)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply(
    { say: "Okay.", route: "act", request: "collect 16 oak_log" },
    { say: "Later.", route: "later", request: "mine stone" },
    { say: "Stopped.", route: "stop", request: "" },
  );
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "x" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  await agent.handle(say("Alex", "mine stone"));
  await agent.handle(say("Steve", "stop"));
  await until(() => runtime.cancelled.length === 1);
  const stacks = events.flatMap((event) => event.kind === "state" ? [event.stack.map((work) => work.text)] : []);
  assert.deepEqual(stacks.filter((stack) => stack.length > 0 && !stack.includes("collect 16 oak_log")).at(0), ["mine stone"], "Steve's logs ended, Alex's queued order stayed");
});

test("a reply that shouts is sent as a shout in public chat, and as a plain whisper to a whisperer", async (t) => {
  const runtime = new FakeRuntime();
  const tiers = scriptedMind({ range: 64 });
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: [], log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  tiers.chat.reply(
    { spoken_to: ["Ayla"], say: "Coming!", shout: true, route: "talk", request: "" },
    { spoken_to: ["Ayla"], say: "Psst!", shout: true, route: "talk", request: "" },
  );
  runtime.inbox.push(say("Steve", "Ayla, are you there?"));
  await until(() => runtime.said.length === 1);
  runtime.inbox.push({ ...say("Steve", "Ayla, are you there?"), channel: "whisper" });
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "send_message").map((call) => call.input), [
    { message: "Coming!", shout: true },
    { message: "Psst!", to: "Steve" },
  ]);
});

// Conversations (spec 2026-10-18-conversations-design).
function talkOptions(extra: Partial<AgentOptions> = {}, modelFree = true): Partial<AgentOptions> {
  return { conversations: { budget: new ConversationBudget(2), modelFree: () => modelFree }, otherAgents: ["Vex", "Bruno"], ...extra };
}

const toAyla = { spoken_to: ["Ayla"], route: "talk" };

test("another agent's line is still ignored outside a conversation, and always without conversations", async (t) => {
  const runtime = new FakeRuntime();
  const withTalks = agentFor(t, runtime, {}, talkOptions());
  await withTalks.agent.handle(say("Vex", "hello everyone", false));
  await withTalks.agent.handle(say("Vex", "Bruno, did you see?", false));
  assert.equal(withTalks.chat.requests.length, 0);
  assert.equal(withTalks.agent.conversation, null);
  const off = agentFor(t, new FakeRuntime());
  await off.agent.handle(say("Vex", "Ayla, got a minute?"));
  assert.equal(off.chat.requests.length, 0, "conversations off: as before");
  assert.equal(off.agent.conversation, null);
});

test("an agent's line naming her opens a conversation and is answered; a member's line naming nobody is answered too", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions());
  chat.reply({ ...toAyla, say: "Sure, what's up?" }, { ...toAyla, say: "The farm is fine." });
  await agent.handle(say("Vex", "Ayla, got a minute?"));
  assert.deepEqual(runtime.said, ["Sure, what's up?"]);
  assert.match(chat.requests[0]?.[1]?.content ?? "", /This conversation:/u);
  assert.deepEqual(agent.conversation?.members, ["Ayla", "Vex"]);
  await agent.handle(say("Vex", "how is the farm?", false));
  assert.deepEqual(runtime.said, ["Sure, what's up?", "The farm is fine."]);
  assert.equal(agent.conversation?.lines, 4);
});

test("in a group, a line naming another member is not answered by her, and a nameless one is dropped when a member spoke meanwhile", async (t) => {
  const runtime = new FakeRuntime();
  const settings = { ...testPersona().settings, chatBurstMs: 60_000 };
  const { agent, chat } = agentFor(t, runtime, { settings }, talkOptions());
  chat.reply({ ...toAyla, say: "Hello you two." });
  await agent.handle(say("Vex", "Ayla and Bruno, hello"));
  assert.deepEqual(agent.conversation?.members, ["Ayla", "Vex", "Bruno"]);
  assert.equal(chat.requests.length, 1);
  await agent.handle(say("Bruno", "Vex, how are you?", false));
  assert.equal(chat.requests.length, 1, "a line naming another member: no call");
  // Bruno spoke after the message Ayla is about to read.
  (agent as unknown as { inbox: { push(message: ReturnType<typeof say>): void } }).inbox.push(say("Bruno", "anyone hungry?", false));
  await agent.handle(say("Vex", "I could eat", false), { message: say("Vex", "I could eat", false), lines: 1, seq: 0 });
  assert.equal(chat.requests.length, 1, "a nameless line after which a member spoke: no call");
  chat.reply({ ...toAyla, say: "Me too." });
  await agent.handle(say("Vex", "bread then?", false));
  assert.deepEqual(runtime.said, ["Hello you two.", "Me too."], "nobody spoke since: she answers");
});

test("close ends the conversation, journaled as goodbye with its gist", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions({ journal: (event) => events.push(event) }));
  chat.reply({ ...toAyla, say: "Bye, Vex!", close: true }, { gist: "Said hello to Vex." });
  await agent.handle(say("Vex", "Ayla, I must go, bye"));
  assert.equal(agent.conversation, null);
  await until(() => events.some((event) => event.kind === "conversation" && event.event === "ended"));
  const ended = events.find((event) => event.kind === "conversation" && event.event === "ended");
  assert.equal(ended?.kind === "conversation" && ended.reason, "goodbye");
  assert.equal(ended?.kind === "conversation" && ended.gist, "Said hello to Vex.");
  const chatRow = events.find((event) => event.kind === "chat");
  assert.ok(chatRow?.kind === "chat" && chatRow.conversation !== undefined, "the chat row carries the conversation");
});

test("an order ends a chance conversation taken_over", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, talkOptions({ journal: (event) => events.push(event) }, false));
  chat.reply({ ...toAyla, say: "Sure." }, { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true });
  action.reply({ done: "got it" });
  await agent.handle(say("Vex", "Ayla, hi"));
  assert.notEqual(agent.conversation, null);
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  assert.equal(agent.conversation, null);
  const ended = events.find((event) => event.kind === "conversation" && event.event === "ended");
  assert.equal(ended?.kind === "conversation" && ended.reason, "taken_over");
});

test("simultaneous openings merge: both end with both members", async (t) => {
  const open = (to: string) => ({ open: true, to: [to], topic: "hello", length: "short", say: `${to}, hi` });
  const budget = new ConversationBudget(2);
  const world = (self: string, other: string) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, players: [{ username: other, position: { x: 10, y: 64, z: 0 } }] };
    const tiers = agentFor(t, runtime, { username: self, displayName: self }, talkOptions({ random: () => 0, otherAgents: [other], conversations: { budget, modelFree: () => true } }));
    tiers.chat.reply(open(other), { spoken_to: [other], say: "Hi!", route: "talk" }, { spoken_to: [other], say: "Hi again.", route: "talk" });
    return { runtime, ...tiers };
  };
  const ayla = world("Ayla", "Vex");
  const vex = world("Vex", "Ayla");
  await until(() => ayla.agent.conversation !== null && vex.agent.conversation !== null);
  ayla.runtime.inbox.push(say("Vex", "Ayla, hi"));
  vex.runtime.inbox.push(say("Ayla", "Vex, hi"));
  await until(() => ayla.runtime.said.length >= 2 && vex.runtime.said.length >= 2);
  assert.deepEqual([...ayla.agent.conversation!.members].sort(), ["Ayla", "Vex"]);
  assert.deepEqual([...vex.agent.conversation!.members].sort(), ["Ayla", "Vex"]);
  assert.equal(budget.active, 1, "one slot held for the one conversation");
  assert.equal(ayla.agent.conversation!.opener, "Ayla");
  assert.equal(vex.agent.conversation!.opener, "Ayla", "Vex sorts later: it takes Ayla as the opener");
  assert.deepEqual([ayla.runtime.said.length, vex.runtime.said.length], [2, 2], "each side answered the other's line once");
  assert.equal(ayla.chat.requests.length, 2);
  assert.equal(vex.chat.requests.length, 2);
});

test("its own line coming back is not a member's: no wake, no line counted", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions());
  chat.reply({ ...toAyla, say: "Hi." });
  await agent.handle(say("Vex", "Ayla, hi"));
  const lines = agent.conversation!.lines;
  runtime.inbox.push(say("Ayla", "Hi."));
  await sleep(40);
  assert.equal(agent.conversation?.lines, lines);
  assert.equal(chat.requests.length, 1);
});

test("an order ends a social conversation: its follow step is aborted, the order runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 5;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "Live well and be friendly." }, talkOptions({ journal: (event) => events.push(event), otherAgents: ["Vex"] }));
  planner.reply({ objective: "go and chat with Vex", for: "socialising" });
  chat.reply({ open: true, to: ["Vex"], topic: "the village", length: "long", say: "Vex! Walk with me?" }, { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true }, { gist: "Walked a bit, then an order came." });
  action.reply({ done: "got the dirt" });
  await until(() => agent.conversation?.kind === "social");
  assert.match(agent.activity, /go and chat with Vex/u);
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  assert.equal(agent.conversation, null);
  await until(() => events.some((event) => event.kind === "conversation" && event.event === "ended"));
  const ended = events.find((event) => event.kind === "conversation" && event.event === "ended");
  assert.equal(ended?.kind === "conversation" && ended.reason, "taken_over");
  await until(() => action.requests.length >= 1);
  assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "collect 5 dirt"/u);
});

test("socialising is never offered to a character without conversations", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, planner } = agentFor(t, runtime, { goal: "Live well." });
  planner.reply({ objective: "chat with Vex", for: "socialising" });
  await until(() => planner.requests.length >= 1);
  assert.doesNotMatch(JSON.stringify(planner.requests[0]), /chatting with someone/u);
  assert.equal(agent.conversation, null);
});

test("a runtime that stays down is logged once by the conversation check, again only after a read worked", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions({ log: (line) => logs.push(line) }));
  chat.reply({ ...toAyla, say: "Hi." });
  await agent.handle(say("Vex", "Ayla, hi"));
  await until(() => logs.some((line) => line.startsWith("listening as")));
  const status = runtime.status.bind(runtime);
  let down = true;
  runtime.status = async () => {
    if (down) throw new Error("runtime down");
    return status();
  };
  await sleep(120);
  assert.equal(logs.filter((line) => line.startsWith("conversation check failed")).length, 1);
  down = false;
  await sleep(60);
  down = true;
  await sleep(60);
  assert.equal(logs.filter((line) => line.startsWith("conversation check failed")).length, 2, "logged again after a read worked");
});

test("no chance opening while a socialising objective is on its way to its partner", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 1_500;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const settings = { ...testPersona().settings, conversation: { ...testPersona().settings.conversation, checkEverySeconds: 1 } };
  const { agent, chat, planner } = agentFor(t, runtime, { goal: "Be friendly.", settings }, talkOptions({ otherAgents: ["Vex"], random: () => 0 }));
  planner.reply({ objective: "go and chat with Vex", for: "socialising" });
  await until(() => agent.activity.includes("go and chat with Vex"));
  runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, { username: "Bruno", position: { x: 4, y: 64, z: 0 } }] };
  await sleep(1_300);
  assert.equal(chat.requests.length, 0, "no opening call to Bruno on the way");
  assert.equal(agent.conversation, null);
});

test("a player's nameless line from within talk range joins the conversation; from farther away it does not", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions());
  chat.reply({ ...toAyla, say: "Hi Vex." }, { ...toAyla, say: "Hello Steve." });
  await agent.handle(say("Vex", "Ayla, hi"));
  await agent.handle({ ...say("Steve", "lovely weather", false), distance: 100 });
  assert.equal(agent.conversation?.members.includes("Steve"), false);
  await agent.handle({ ...say("Steve", "lovely weather", false), distance: 10 });
  assert.equal(agent.conversation?.members.includes("Steve"), true);
});

test("a request from a conversation member keeps the conversation", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, talkOptions({ journal: (event) => events.push(event) }, false));
  const act = { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true };
  chat.reply({ ...toAyla, say: "Sure." }, act, { ...toAyla, say: "Almost done, Vex." }, { gist: "x" });
  action.reply({ done: "got it" });
  await agent.handle(say("Vex", "Ayla, hi"));
  const record = agent.conversation;
  assert.notEqual(record, null);
  await agent.handle(say("Vex", "Ayla, collect 5 dirt"));
  assert.equal(agent.conversation, record, "the same record: the favour did not end it");
  assert.ok(!events.some((event) => event.kind === "conversation" && event.event === "ended"));
  // The next line of the member is still handled inside the conversation.
  await agent.handle(say("Vex", "how is it going?", false));
  assert.match(chat.requests.at(-1)?.[1]?.content ?? "", /This conversation:/u);
  assert.equal(agent.conversation, record);
});

test("a request from someone who is not a member still ends it taken_over", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, talkOptions({ journal: (event) => events.push(event) }, false));
  chat.reply({ ...toAyla, say: "Sure." }, { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true });
  action.reply({ done: "got it" });
  await agent.handle(say("Vex", "Ayla, hi"));
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  assert.equal(agent.conversation, null);
  assert.equal(events.some((event) => event.kind === "conversation" && event.event === "ended" && event.reason === "taken_over"), true);
});

test("a stop from a member still ends the conversation taken_over", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions({ journal: (event) => events.push(event) }, false));
  chat.reply({ ...toAyla, say: "Sure." }, { spoken_to: ["Ayla"], say: "Stopping.", route: "stop", request: "" });
  await agent.handle(say("Vex", "Ayla, hi"));
  await agent.handle(say("Vex", "Ayla, stop", false));
  assert.equal(agent.conversation, null);
  assert.equal(events.some((event) => event.kind === "conversation" && event.event === "ended" && event.reason === "taken_over"), true);
});

test("a later from a member keeps the conversation going", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(t, runtime, {}, talkOptions({}, false));
  chat.reply({ ...toAyla, say: "Sure." }, { spoken_to: ["Ayla"], say: "Later.", route: "later", request: "collect 5 dirt" });
  action.reply({ done: "got it" });
  await agent.handle(say("Vex", "Ayla, hi"));
  const record = agent.conversation;
  await agent.handle(say("Vex", "Ayla, collect 5 dirt when you can", false));
  assert.equal(agent.conversation, record);
});

test("a favour agreed with the partner of a social conversation keeps it; the routine resumes without a second opening", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 5;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "Live well and be friendly." }, talkOptions({ journal: (event) => events.push(event), otherAgents: ["Vex"] }));
  planner.reply({ objective: "go and chat with Vex", for: "socialising" });
  chat.reply(
    { open: true, to: ["Vex"], topic: "the village", length: "long", say: "Vex! Walk with me?" },
    { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true },
    { gist: "Talked about the village." }, { gist: "Talked about the village." },
  );
  action.reply({ done: "got the dirt" });
  await until(() => agent.conversation?.kind === "social");
  const record = agent.conversation;
  await agent.handle(say("Vex", "Ayla, please collect 5 dirt"));
  assert.equal(agent.conversation, record, "the favour did not end the conversation");
  await until(() => action.requests.length >= 1);
  assert.equal(events.filter((event) => event.kind === "conversation" && event.event === "opened").length, 1, "one opening only");
});

/** The next call answers 400 ms after the test starts, as a live model takes seconds: every bot has registered its distance to the speaker before any claims the line. */
function slowModel(model: { hold(): () => void }): void {
  const release = model.hold();
  setTimeout(release, 400);
}

/** Two agents (Ayla and Vex) sharing one record of the lines to everyone; each model reads the line as a greeting. */
function greetedBy(t: Parameters<typeof agentFor>[0], speakerAt: { ayla: number; vex: number }, line: ReturnType<typeof say> & { distance?: number }, hearers: { ayla: boolean; vex: boolean } = { ayla: true, vex: true }) {
  const everyone = new EveryoneLines();
  const greeting = { spoken_to: ["everyone"], asks: "", language: "English", say: "Hey!", route: "talk", request: "" };
  const make = (name: string, at: number, hears: boolean) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, players: [steveAt(at)] };
    const built = agentFor(t, runtime, { id: name.toLowerCase(), username: name }, { everyone, otherAgents: ["Ayla", "Vex"].filter((other) => other !== name) });
    built.chat.reply(greeting);
    slowModel(built.chat);
    return { runtime, hears, ...built };
  };
  const ayla = make("Ayla", speakerAt.ayla, hearers.ayla);
  const vex = make("Vex", speakerAt.vex, hearers.vex);
  return { ayla, vex, say: async () => {
    await sleep(100); // the agents drain the chat from before they started first
    for (const bot of [ayla, vex]) if (bot.hears) bot.runtime.inbox.push(line);
  } };
}

test("a greeting to everyone is answered by the bot nearest the speaker only, distances from positions", async (t) => {
  const { ayla, vex, say: speak } = greetedBy(t, { ayla: 30, vex: 5 }, say("Steve", "sups boys ?", false));
  await speak();
  await until(() => vex.runtime.said.length > 0, 4_000);
  await sleep(300);
  assert.deepEqual([ayla.runtime.said, vex.runtime.said], [[], ["Hey!"]]);
});

test("a greeting to everyone with the line's own distance (localized chat) is answered by the nearer bot only", async (t) => {
  const everyone = new EveryoneLines();
  const greeting = { spoken_to: ["everyone"], asks: "", language: "English", say: "Hey!", route: "talk", request: "" };
  const bots = [["Ayla", 40], ["Vex", 6]].map(([name, distance]) => {
    const runtime = new FakeRuntime();
    const built = agentFor(t, runtime, { id: String(name).toLowerCase(), username: String(name) }, { everyone, otherAgents: ["Ayla", "Vex"].filter((other) => other !== name) });
    built.chat.reply(greeting);
    slowModel(built.chat);
    return { runtime, distance: distance as number };
  });
  await sleep(100); // the agents drain the chat from before they started first
  for (const bot of bots) bot.runtime.inbox.push({ ...say("Steve", "sups boys ?", false), distance: bot.distance });
  const runtimes = bots.map((bot) => bot.runtime);
  await until(() => runtimes[1]!.said.length > 0, 4_000);
  await sleep(300);
  assert.deepEqual(runtimes.map((runtime) => runtime.said), [[], ["Hey!"]]);
});

test("a bot that does not hear the greeting is no candidate: the one that heard it answers", async (t) => {
  const { ayla, vex, say: speak } = greetedBy(t, { ayla: 30, vex: 5 }, say("Steve", "sups boys ?", false), { ayla: true, vex: false });
  await speak();
  await until(() => ayla.runtime.said.length > 0, 4_000);
  await sleep(300);
  assert.deepEqual([ayla.runtime.said, vex.runtime.said], [["Hey!"], []]);
});

const MIN = 60_000;
const ACCEPT = { spoken_to: ["Ayla"], asks: "", language: "English", say: "Deal.", route: "talk", request: "", trade: { action: "accept", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "me" } };

/** A runtime with Theo two blocks away and 10 bread carried, for the trade tests. */
function tradingRuntime(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "bread", count: 10 }], players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] };
  return runtime;
}

/** The relation notes of the runtime, newest first, read back the way a restart does. */
function savedRelations(runtime: FakeRuntime) {
  return recall(runtime.notes.map((note) => note.context).reverse(), { places: 8, lately: 5, farms: 4, times: 3 }).relations;
}

test("work resumes after a trade hand-off", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await until(() => action.requests.length === 2, 4_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log/u, "the earlier objective's next step is asked for");
  assert.equal(runtime.cancelled.length, 1, "its running step was set aside for the give");
  assert.deepEqual(events.filter((event) => event.kind === "trade").map((event) => event.event), ["agreed", "gave"]);
  const trade = savedRelations(runtime)[0]?.trades[0];
  assert.deepEqual([trade?.state, trade?.first], ["i_gave", "me"]);
  await until(() => agent.activity === "idle");
});

test("shelter keeps the trade due: a stop during the give drops the hand-off, the trade stays open and is given later, then broken at its deadline", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.drop_item = 100_000;
  const { agent, chat } = agentFor(t, runtime);
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = t.mock.method(Date, "now", () => now() + offset);
  chat.reply(ACCEPT, { say: "Okay.", route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await agent.handle(say("Steve", "Ayla, stop"));
  await until(() => runtime.cancelled.length === 1);
  await sleep(100);
  assert.equal(agent.activity, "idle");
  assert.deepEqual([savedRelations(runtime)[0]?.trades[0]?.state, savedRelations(runtime)[0]?.trades[0]?.gaveAt], ["agreed", null], "the trade is still due");
  delete runtime.durations.drop_item;
  offset = 31_000;
  await sleep(300);
  assert.equal(savedRelations(runtime)[0]?.trades[0]?.state, "i_gave", "taken again later and given");
  offset += 11 * MIN;
  await sleep(300);
  const broken = savedRelations(runtime)[0]?.trades[0];
  assert.deepEqual([broken?.state, broken?.brokenBy], ["broken", "them"]);
  clock.mock.restore();
});

test("a player's give_item request outside a trade is unchanged, and keeps no relation", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  action.reply({ step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } }, { done: "Steve has 2 dirt" });
  await agent.handle(say("Steve", "could you give me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(bodyCalls(runtime), ["navigate", "drop_item"]);
  assert.deepEqual(savedRelations(runtime), []);
});

test("a trade the checks refuse goes back to the chat tier once with the reason and is then not made", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  const unaffordable = { ...ACCEPT, say: "Deal, all my iron!", trade: { ...ACCEPT.trade, give: [{ item: "iron_ingot", count: 5 }], get: [{ item: "bread", count: 1 }] } };
  chat.reply(unaffordable, { ...ACCEPT, say: "Sorry, I have none.", trade: undefined });
  await agent.handle(say("Theo", "Ayla, bread for iron?"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 2);
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Your relations:\nYou have not dealt with Theo before\./u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /you carry 0 iron_ingot, not 5/u);
  assert.deepEqual(runtime.said, ["Sorry, I have none."]);
  assert.deepEqual(savedRelations(runtime), []);
});

test("relations off: no relation block, no trade paragraph, no trade", async (t) => {
  const runtime = tradingRuntime();
  const persona = testPersona();
  const { agent, chat } = agentFor(t, runtime, { settings: { ...persona.settings, relations: { ...persona.settings.relations, enabled: false } } });
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.said.length === 1);
  assert.doesNotMatch(chat.requests[0]?.[0]?.content ?? "", /"trade"/u);
  assert.doesNotMatch(chat.requests[0]?.[1]?.content ?? "", /Your relations/u);
  await sleep(100);
  assert.deepEqual(bodyCalls(runtime), []);
  assert.deepEqual(savedRelations(runtime), []);
});

/** The objectives the agent took on, as `<requester or own>: <text>`, from its journal. */
const takenObjectives = (events: BrainEvent[]): string[] => events.flatMap((event) => (event.kind === "objective" && event.event === "taken" ? [`${event.requester ?? "own"}: ${event.text}`] : []));
const TRADE_AND_ORDER = { ...ACCEPT, route: "act", request: "give Theo 5 bread" };

test("a trade line routed act takes no order", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply(TRADE_AND_ORDER);
  await agent.handle(say("Theo", "Ayla, give me 5 bread, I pay 5 iron_ingot right after"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  await until(() => agent.activity === "idle");
  assert.deepEqual(takenObjectives(events), ["own: hand over 5 bread to Theo (trade)"]);
});

test("a later route with a trade takes no order", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  // "later" is a route only while the character works for someone else.
  chat.reply({ say: "On it.", route: "act", request: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await agent.handle(say("Steve", "Ayla, collect 16 oak_log"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...TRADE_AND_ORDER, route: "later" });
  await agent.handle(say("Theo", "Ayla, give me 5 bread, I pay 5 iron_ingot right after"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), ["Steve: collect 16 oak_log", "own: hand over 5 bread to Theo (trade)"]);
});

test("decline with act keeps the order", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply({ ...TRADE_AND_ORDER, trade: { action: "decline", give: [], get: [], first: "me" } });
  action.reply({ step: { skill: "give_item", player: "Theo", item: "bread", count: 5 } }, { done: "Theo has the bread" });
  await agent.handle(say("Theo", "Ayla, never mind the trade, just give me 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), ["Theo: give Theo 5 bread"]);
});

test("an ignored proposal keeps the order", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  const propose = { ...ACCEPT, trade: { ...ACCEPT.trade, action: "propose", first: "them" } };
  chat.reply(propose);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "proposed");
  // A second proposal with the same partner is refused by the checks (twice) and dropped: the order stays.
  chat.reply({ ...propose, route: "act", request: "give Theo 1 bread" }, { ...propose, route: "act", request: "give Theo 1 bread" });
  action.reply({ step: { skill: "give_item", player: "Theo", item: "bread", count: 1 } }, { done: "Theo has the bread" });
  await agent.handle(say("Theo", "Ayla, give me 1 bread now"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"));
  assert.deepEqual(takenObjectives(events), ["Theo: give Theo 1 bread"]);
  assert.equal(savedRelations(runtime)[0]?.trades.length, 1, "still the one proposal");
});

test("a stop with a trade still stops", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, stop that, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.cancelled.length >= 1);
  assert.ok(!takenObjectives(events).some((line) => line.startsWith("Theo:")), "a stop takes no order");
});

test("a hand-off already given ends done without a give and the previous objective resumes", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations; takeHandoff(h: Handoff): void };
  await until(() => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  const id = inside.relations.book.trades()[0]!.id;
  // The give was made by another objective while the hand-off was waiting on the stack.
  await inside.relations.trades.gaveOutside("Theo", "bread", 5);
  inside.takeHandoff({ kind: "give", tradeId: id, partner: "Theo", items: [{ item: "bread", count: 5 }] });
  await until(() => action.requests.length === 2, 4_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log/u, "the objective below takes its next step");
  assert.ok(!runtime.submitted.some((call) => call.tool === "drop_item"), "no give_item call");
  const finished = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("hand over") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(finished, [["done", "already handed over"]]);
});

test("an agreed trade where they pay first sets the own objective aside for a wait; the payment ends it, the give follows and the objective resumes", async (t) => {
  const runtime = tradingRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" }, { journal: (event) => events.push(event) });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } }, { done: "got the logs" });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await until(() => takenObjectives(events).includes("own: wait for Theo to give their side (trade)"), 4_000);
  assert.ok(runtime.cancelled.length >= 1, "the own step was aborted for the wait");
  const finishedWait = () => events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("wait for Theo"));
  assert.equal(finishedWait(), false, "the wait runs while nothing arrives");
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "iron_ingot", count: 5 }] };
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
  await until(finishedWait, 4_000);
  const waits = events.flatMap((event) => (event.kind === "objective" && event.event === "finished" && event.text.startsWith("wait for Theo") ? [[event.outcome, event.detail]] : []));
  assert.deepEqual(waits, [["done", "they gave"]]);
  await until(() => action.requests.length >= 2, 4_000);
  assert.match(action.requests.at(-1)?.[1]?.content ?? "", /collect 16 oak_log/u, "the own objective resumes after the wait");
});

test("a stop during the wait for their side drops it: the trade stays open and the wait is not on the stack", async (t) => {
  const runtime = tradingRuntime();
  const events: BrainEvent[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  await until(() => takenObjectives(events).includes("own: wait for Theo to give their side (trade)"), 4_000);
  const inside = agent as unknown as { relations: AgentRelations; stack: { objective: { handoff?: Handoff } }[] };
  chat.reply({ spoken_to: ["Ayla"], asks: "", language: "English", say: "Okay.", route: "stop", request: "" });
  await agent.handle(say("Theo", "Ayla, stop that"));
  await until(() => inside.stack.every((work) => work.objective.handoff === undefined), 4_000);
  assert.equal(inside.relations.book.trades()[0]?.state, "agreed", "the trade stays open");
  assert.equal(inside.relations.trades.awaits(inside.relations.book.trades()[0]!.id), true);
});

/** Ayla (bread, Theo 2 blocks away) whose own `get_items` for 3 iron_ingot ends failed: the goal tier is asked again with trading in reach. */
async function failedIronObjective(t: Parameters<typeof agentFor>[0], extra: Partial<AgentOptions> = {}) {
  // Theo is out of the opening distance: no chance opening takes the talk before the routine does.
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 30, y: 64, z: 0 } }] };
  runtime.durations.navigate = 5;
  const events: BrainEvent[] = [];
  const built = agentFor(t, runtime, { goal: "Forge an iron kit." }, talkOptions({ journal: (event) => events.push(event), otherAgents: ["Theo"], random: () => 0, ...extra }));
  built.planner.reply({ objective: "get 3 iron_ingot" });
  built.action.reply({ step: { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] } }, { give_up: "no iron anywhere near" });
  return { runtime, events, ...built };
}

test("a failed own get_items objective draws trading and shows the trade-needs line to the next goal call", async (t) => {
  const { planner } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await until(() => planner.requests.length >= 2, 4_000);
  const prompt = JSON.stringify(planner.requests[1]);
  assert.match(prompt, /feel most like [^.]*trading items with someone/u);
  assert.match(prompt, /trade for iron_ingot you could not get: ask Theo what they would want for it \(you carry 10 bread\)/u);
});

test("without anyone to trade with, a failed objective draws no trading", async (t) => {
  const runtime = tradingRuntime();
  const built = agentFor(t, runtime, { goal: "Forge an iron kit." }, { random: () => 0 });
  built.planner.reply({ objective: "get 3 iron_ingot" });
  built.action.reply({ step: { skill: "get_items", items: [{ item: "iron_ingot", count: 3 }] } }, { give_up: "no iron anywhere near" });
  built.planner.reply({ objective: "gather wood" });
  await until(() => built.planner.requests.length >= 2, 4_000);
  assert.doesNotMatch(JSON.stringify(built.planner.requests[1]), /trading items with someone|trade for/u);
});

test("a trading objective runs the routine: no work-tier call, a trade step in the journal, done on an agreed trade", async (t) => {
  const { runtime, events, agent, chat, action, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for 5 iron ingots", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" }, ACCEPT, { gist: "Agreed bread for iron." }, { gist: "Agreed bread for iron." });
  await until(() => agent.conversation?.kind === "social", 4_000);
  assert.equal(action.requests.length, 2, "the trading objective asked the work tier nothing");
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  // The hand-off sets the routine aside; it resumes with the talk still on and follows until the talk ends.
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
  await sleep(100);
  (agent as unknown as { talks: ConversationController }).talks.end("out_of_range");
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo") && event.outcome === "done"), 6_000);
  const rows = events.filter((event) => event.kind === "step" && event.objective.startsWith("trade Theo"));
  const row = rows.at(-1);
  assert.equal(rows.length, 1, "F9: set aside for the hand-off, then ended done on resume: no second trade step");
  assert.deepEqual(row?.kind === "step" && row.input, { skill: "trade", partner: "Theo" });
  const finished = events.find((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo"));
  assert.match(String(finished?.kind === "objective" && finished.detail), /^agreed with Theo: 5 bread for 5 iron_ingot/u);
  assert.equal(action.requests.length, 2);
  assert.ok(runtime.submitted.some((call) => call.tool === "drop_item"), "the hand-off ran");
});

test("a goal reply \"for\": \"trading iron_ingot\" runs the trade routine, not a work-tier step", async (t) => {
  const { agent, action, planner, chat } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo to trade me 3 iron_ingot for some of my bread", for: "trading iron_ingot" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" });
  await until(() => agent.conversation?.kind === "social", 4_000);
  assert.equal(action.requests.length, 2, "the objective asked the work tier nothing");
});

test("a trading objective that ends refused is not asked again: the next goal call is not a trade ask to that partner", async (t) => {
  const { events, agent, chat, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for 3 iron ingots", for: "trading" }, { objective: "gather wood" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, want to swap for iron?" }, { gist: "He said no." });
  await until(() => agent.conversation?.kind === "social", 4_000);
  (agent as unknown as { talks: ConversationController }).talks.end("out_of_range");
  await until(() => planner.requests.length >= 3, 8_000);
  assert.ok(events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo") && event.outcome === "failed"));
  const situation = planner.requests[2]?.[1]?.content ?? "";
  assert.doesNotMatch(situation, /feel most like.*trading|trade for iron_ingot/u);
});

test("F7: a trading objective naming only carried items asks Theo for the need instead of failing 'already carry'", async (t) => {
  const { events, agent, action, planner, chat } = await failedIronObjective(t);
  planner.reply({ objective: "ask Theo to trade me 1 bread for some of my bread", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "short", say: "Theo, I need iron: what do you want for it?" });
  await until(() => agent.conversation?.kind === "social", 4_000);
  assert.equal(action.requests.length, 2, "the routine ran: no work-tier call");
  assert.ok(!events.some((event) => event.kind === "objective" && event.event === "finished" && /already carry/u.test(event.detail ?? "")));
  assert.ok((agent as unknown as { asks: TradeAsks }).asks.needs.current(Date.now(), []).includes("iron_ingot"));
});

test("F7: a second trading objective that fails before any ask pauses trading: the next goal call draws none though a need is set, until a new need", async (t) => {
  const { events, agent, planner } = await failedIronObjective(t);
  const asks = (agent as unknown as { asks: TradeAsks }).asks;
  await until(() => planner.requests.length >= 2, 4_000);
  asks.failedFast(Date.now() - 60_000);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u, "one fast failure: trading is still drawn");
  // The need is gone when the objective is planned (the memory ran out): "already carry bread" fails at once.
  asks.needs.drop("iron_ingot");
  planner.reply({ objective: "ask Theo to trade me bread", for: "trading" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished" && /already carry bread/u.test(event.detail ?? "")), 4_000);
  await until(() => planner.requests.length >= 3, 4_000);
  assert.equal(asks.paused(Date.now()), true);
  asks.needs.set(["iron_ingot"], Date.now());
  planner.reply({ objective: "gather wood" });
  await until(() => planner.requests.length >= 4, 4_000);
  assert.doesNotMatch(JSON.stringify(planner.requests[3]), /trading items with someone|trade for/u, "paused: no trading though a need is set");
  asks.failed(["bucket"], [], Date.now());
  assert.equal(asks.paused(Date.now()), false, "a new need ends the pause");
});

test("an order during a trading objective aborts the routine and runs", async (t) => {
  const { agent, chat, action, planner } = await failedIronObjective(t);
  planner.reply({ objective: "trade Theo for iron ingots", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "iron", length: "long", say: "Theo! Walk with me?" }, { spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 5 dirt", starts_now: true }, { gist: "An order came." });
  action.reply({ done: "got the dirt" });
  await until(() => agent.conversation?.kind === "social", 4_000);
  await agent.handle(say("Steve", "Ayla, collect 5 dirt"));
  await until(() => action.requests.length >= 3, 6_000);
  assert.match(action.requests[2]?.[1]?.content ?? "", /Objective \(asked by Steve\): "collect 5 dirt"/u);
});

test("every partner refused lately: the next goal call draws no trading, though a need is set", async (t) => {
  const { agent, planner } = await failedIronObjective(t);
  (agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], Date.now() - 60_000);
  planner.reply({ objective: "gather wood" });
  await until(() => planner.requests.length >= 2, 4_000);
  assert.doesNotMatch(JSON.stringify(planner.requests[1]), /trading items with someone|trade for/u);
});

test("one partner of two refused lately: trading is still drawn for the other", async (t) => {
  const { agent, planner } = await failedIronObjective(t, { otherAgents: ["Theo", "Bruno"] });
  (agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], Date.now() - 60_000);
  planner.reply({ objective: "ask Bruno for iron", for: "trading" });
  await until(() => planner.requests.length >= 2, 4_000);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u);
});

test("a refusal older than 10 minutes, or a miss that is not yet a refusal, leaves trading drawn", async (t) => {
  const old = await failedIronObjective(t);
  (old.agent as unknown as { asks: TradeAsks }).asks.refused.add("Theo", ["bread"], Date.now() - 10 * 60_000 - 1);
  old.planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await until(() => old.planner.requests.length >= 2, 4_000);
  assert.match(JSON.stringify(old.planner.requests[1]), /trading items with someone/u);
  const missed = await failedIronObjective(t);
  (missed.agent as unknown as { asks: TradeAsks }).asks.refused.missed("Theo", ["bread"], Date.now());
  missed.planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await until(() => missed.planner.requests.length >= 2, 4_000);
  assert.match(JSON.stringify(missed.planner.requests[1]), /trading items with someone/u);
});

test("a hand-off the partner did not take is retaken and done once the partner takes it (s1d, bug A)", async (t) => {
  const runtime = tradingRuntime();
  runtime.dropOutcomes.push(
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0 } },
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: true, collectedCount: 5 } },
  );
  const { agent, chat } = agentFor(t, runtime);
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = t.mock.method(Date, "now", () => now() + offset);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "pick_up_items"), 4_000);
  await sleep(200);
  assert.equal(savedRelations(runtime)[0]?.trades[0]?.state, "agreed", "not taken: the trade is still due, no gave row");
  offset = 31_000;
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "i_gave", 4_000);
  assert.equal(runtime.submitted.filter((call) => call.tool === "drop_item").length, 2);
  clock.mock.restore();
});

test("a partly taken hand-off credits the taken part: the retake gives only what is left", async (t) => {
  const runtime = tradingRuntime();
  runtime.dropOutcomes.push(
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 2 } },
    { status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 3 }], recipient: { collected: true, collectedCount: 3 } },
  );
  const { agent, chat } = agentFor(t, runtime);
  const now = Date.now.bind(Date);
  let offset = 0;
  const clock = t.mock.method(Date, "now", () => now() + offset);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "pick_up_items"), 4_000);
  await sleep(200);
  offset = 31_000;
  await until(() => savedRelations(runtime)[0]?.trades[0]?.state === "i_gave", 4_000);
  const counts = runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => (call.input.items as { count: number }[])[0]?.count);
  assert.deepEqual(counts, [5, 3]);
  clock.mock.restore();
});

test("an outside give_item the partner did not pick up is not counted toward the trade (s1d, bug A)", async (t) => {
  const runtime = tradingRuntime();
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "bread", dropped: 5 }], recipient: { collected: false, collectedCount: 0 } });
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ ...ACCEPT, trade: { ...ACCEPT.trade, first: "them" } }, { say: "Sure.", route: "act", request: "give Theo 5 bread" });
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread, you after me?"));
  const inside = agent as unknown as { relations: AgentRelations };
  await until(() => inside.relations.book.trades().some((trade) => trade.state === "agreed"));
  action.reply({ step: { skill: "give_item", player: "Theo", item: "bread", count: 5 } }, { done: "left it" });
  await agent.handle(say("Steve", "Ayla, give Theo 5 bread"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
  await sleep(300);
  assert.equal(inside.relations.book.trades()[0]?.gaveAt, null, "left at the feet, never taken: not a give");
  assert.deepEqual(inside.relations.trades.leftToGive(inside.relations.book.trades()[0]!.id), [{ item: "bread", count: 5 }]);
});

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

test("two bots of one brain: the trading routine waits for its turn, opens, and both records hold the proposer's terms and reach done", async (t) => {
  const budget = new ConversationBudget(1);
  budget.tryTake();
  const board = new TradeBoard();
  const aylaLog: string[] = [];
  const ayla = await failedIronObjective(t, { tradeBoard: board, conversations: { budget, modelFree: () => true }, random: () => 1, log: (line) => aylaLog.push(line) });
  ayla.runtime.snapshot = { ...ayla.runtime.snapshot, players: [{ username: "Theo", position: { x: 3, y: 64, z: 0 } }] };
  const theoRuntime = new FakeRuntime();
  theoRuntime.snapshot = { ...theoRuntime.snapshot, inventory: [{ name: "iron_ingot", count: 10 }], players: [{ username: "Ayla", position: { x: 3, y: 64, z: 0 } }] };
  const theo = agentFor(t, theoRuntime, { id: "theo", username: "Theo" }, talkOptions({ tradeBoard: board, conversations: { budget, modelFree: () => true }, otherAgents: ["Ayla"], random: () => 1 }));
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
  await until(() => aylaLog.some((line) => line === "trading: trade with Theo"), 4_000);
  await sleep(150);
  assert.equal(ayla.agent.conversation, null, "the cap is full: the routine waits, no talk yet");
  assert.ok(!ayla.events.some((event) => event.kind === "objective" && event.event === "finished" && event.text.startsWith("trade Theo")), "the trade objective is still waiting for its turn, not failed");
  budget.give();
  const trades = (runtime: FakeRuntime, partner: string) => savedRelations(runtime).find((r) => r.partner === partner)?.trades[0];
  await until(() => trades(theoRuntime, "Ayla")?.state === "done" && trades(ayla.runtime, "Theo")?.state === "done", 8_000);
  const [mine, theirs] = [trades(ayla.runtime, "Theo")!, trades(theoRuntime, "Ayla")!];
  assert.equal(mine.id, theirs.id, "one trade, one id");
  assert.deepEqual([mine.give, mine.get, theirs.give, theirs.get], [sideOf("bread", 4), sideOf("iron_ingot", 4), sideOf("iron_ingot", 4), sideOf("bread", 4)], "Ayla's terms on both sides");
});

type ShareInside = { startedAt: number; times: { activity: string; purpose: string; ended: string; minutes: number }[] };
/** The agent has been up `sinceStart` minutes and spent `minutes` of them on trading steps that ended `endedAgo` minutes ago. */
function tradedFor(agent: Agent, sinceStart: number, minutes: number, endedAgo = 0): void {
  const inside = agent as unknown as ShareInside;
  inside.startedAt = Date.now() - sinceStart * MIN;
  inside.times.push({ activity: "trading", purpose: "trading", ended: new Date(Date.now() - endedAgo * MIN).toISOString(), minutes });
}
const ownDrawn = (events: BrainEvent[]) => events.flatMap((event) => (event.kind === "objective" && event.event === "own" ? [event.drawn ?? []] : []));

test("F9: 16 min of trading in the 30 min since the start: the next goal call draws no trading though a need is set; time passing without trading brings it back", async (t) => {
  const { events, agent, planner } = await failedIronObjective(t);
  tradedFor(agent, 30, 16);
  planner.reply({ objective: "gather wood" });
  await until(() => planner.requests.length >= 2, 4_000);
  assert.doesNotMatch(String(planner.requests[1]?.[1]?.content), /feel most like[^.]*trading|trade for/u);
  assert.ok(ownDrawn(events).every((drawn) => !drawn.includes("trading")), "the journal's drawn has no trading");
  // Edge 4: the wall clock moves, no step runs; the trading minutes fall out of the hour.
  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + 61 * MIN);
  (agent as unknown as { asks: TradeAsks }).asks.needs.set(["iron_ingot"], Date.now());
  planner.reply({ objective: "gather wood again" });
  await until(() => planner.requests.length >= 3, 6_000);
  assert.match(String(planner.requests[2]?.[1]?.content), /feel most like[^.]*trading/u, "trading capped, then drawn again");
});

test("F9: 3 min after the start, all of it trading: no ceiling yet, trading is forced as today", async (t) => {
  const { agent, planner } = await failedIronObjective(t);
  tradedFor(agent, 3, 3);
  planner.reply({ objective: "ask Theo for iron", for: "trading" });
  await until(() => planner.requests.length >= 2, 4_000);
  assert.match(JSON.stringify(planner.requests[1]), /trading items with someone/u);
});

test("F9: while trading is capped a partner's proposal in chat is still answered, agreed and handed off", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, { random: () => 0 });
  tradedFor(agent, 30, 16);
  chat.reply(ACCEPT);
  await agent.handle(say("Theo", "Ayla, 5 iron_ingot for your 5 bread?"));
  await until(() => runtime.submitted.some((call) => call.tool === "drop_item"), 4_000);
  assert.equal((agent as unknown as { relations: AgentRelations }).relations.book.trades().length, 1, "the trade was made");
});
