import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCall } from "./brain-log.ts";
import { chatSystemPrompt, LlmMind, personaPrompt } from "./llm-mind.ts";
import type { ChatInput, WorkInput } from "./mind.ts";
import { FakeRuntime, scriptedMind, testPersona } from "./testing.ts";

const signal = new AbortController().signal;

function chatInput(message: string, addressed = false): ChatInput {
  return {
    persona: testPersona(),
    message: { username: "Steve", channel: "chat", message, addressed },
    history: [],
    snapshot: new FakeRuntime().snapshot,
    activity: "idle",
    places: [],
    areas: [],
  };
}

function workInput(text: string, overrides: Partial<WorkInput> = {}): WorkInput {
  return {
    persona: testPersona(),
    objective: { text, requester: "Steve" },
    snapshot: new FakeRuntime().snapshot,
    places: [],
    areas: [],
    steps: [],
    paused: [],
    ...overrides,
  };
}

test("the chat tier reads a fenced JSON reply as an answer plus a route", async () => {
  const { chat, mind } = scriptedMind();
  chat.reply("Sure!\n```json\n{\"say\":\"Right behind you!\",\"route\":\"act\",\"request\":\"follow Steve\"}\n```");
  const decision = await mind.chat(chatInput("yo Ayla stick with me", true), signal);
  assert.deepEqual(decision, { say: "Right behind you!", route: "act", request: "follow Steve" });
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Steve says in chat, naming you: "yo Ayla stick with me"/u);
});

test("taking something on without restating it is repaired once", async () => {
  const { chat, mind } = scriptedMind();
  chat.reply({ say: "On it.", route: "act" }, { say: "On it.", route: "act", request: "collect 3 dirt" });
  assert.equal((await mind.chat(chatInput("grab me some dirt"), signal)).request, "collect 3 dirt");
  assert.equal(chat.requests[1]?.length, 4);
});

test("the work tier answers with one validated step, and why", async () => {
  const { action, mind } = scriptedMind();
  action.reply({ thought: "Logs first.", step: { skill: "collect_block", block: "oak_log", count: 5 } });
  assert.deepEqual(await mind.next(workInput("give Steve 5 oak_log"), signal), {
    kind: "step",
    step: { skill: "collect_block", block: "oak_log", count: 5 },
    thought: "Logs first.",
  });
});

test("the work tier may end the objective: done, or given up with a reason", async () => {
  const { action, mind } = scriptedMind();
  action.reply({ done: "Steve has his logs." }, { give_up: "I do not know how to build a tower." });
  assert.deepEqual(await mind.next(workInput("give Steve 5 oak_log"), signal), { kind: "done", summary: "Steve has his logs." });
  assert.deepEqual(await mind.next(workInput("build a tower"), signal), { kind: "give_up", reason: "I do not know how to build a tower." });
});

test("a skill outside the catalog, or one this character cannot use, is rejected after the repair round", async () => {
  const { action, mind } = scriptedMind();
  const bad = { step: { skill: "op_player", player: "Steve" } };
  action.reply(bad, bad);
  await assert.rejects(mind.next(workInput("op me"), signal), /LLM_BAD_REPLY/u);
  const collect = { step: { skill: "collect_block", block: "dirt" } };
  action.reply(collect, collect);
  const walker = testPersona({ skills: ["follow_player", "go_to"] });
  await assert.rejects(mind.next(workInput("dig", { persona: walker }), signal), /you cannot use collect_block/u);
});

test("the work tier sees the objective, who asked, what was set aside, places and the steps so far", async () => {
  const { action, mind } = scriptedMind();
  const house = { name: "the small medieval house you built for Steve", detail: "door -2 64 0 facing east; stand on its roof at -4 70 0" };
  action.reply({ step: { skill: "go_to", x: -4, y: 70, z: 0 } });
  await mind.next(workInput("go to the roof", {
    places: [house],
    areas: [{ regionId: 2, label: "small medieval house", owner: "Ayla", min: { x: -6, y: 63, z: -3 }, max: { x: 0, y: 70, z: 3 } }],
    paused: [{ text: "gather wood for my base", requester: null }],
    steps: [{ step: "go to Steve", outcome: "done", detail: "reached Steve" }],
  }), signal);
  const request = action.requests[0]?.[1]?.content ?? "";
  assert.match(request, /\n- Places you know: the small medieval house you built for Steve \(door -2 64 0 facing east; stand on its roof at -4 70 0\)\.\n/u);
  assert.match(request, /\n- Protected areas \(you never dig or place blocks there\): #2 small medieval house \(owner Ayla, -6 63 -3 to 0 70 3\)\.\n/u);
  assert.match(request, /Objective \(asked by Steve\): "go to the roof"/u);
  assert.match(request, /Set aside until this one ends: "gather wood for my base"/u);
  assert.match(request, /1\. go to Steve -> done: reached Steve/u);
});

test("aptitudes reach the init prompt as what the character is good at and likes doing, never as a rule", () => {
  const prompt = personaPrompt(testPersona({ aptitudes: { farmer: 0.8, explorer: 0.5, builder: 0.2, miner: 0 } }));
  assert.match(prompt, /What you are good at and like doing: farming \(very\), exploring \(fairly\), building \(a little\)\./u);
  assert.doesNotMatch(prompt, /mining/u);
  assert.doesNotMatch(personaPrompt(testPersona({ aptitudes: {} })), /good at and like doing/u);
});

test("the work tier knows crops ripen over time near water and bread is made from wheat", async () => {
  const { mind, action } = scriptedMind();
  action.reply({ done: "ok" });
  await mind.next({ persona: testPersona(), objective: { text: "make bread", requester: "Tom" }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] }, new AbortController().signal);
  assert.match(action.requests[0]?.[0]?.content ?? "", /Crops ripen over time near water[^\n]*bread is crafted from 3 wheat/u);
  // Live 2026-10-03: "give Tom 1 bread" ended "done (gave Tom 1 bread)" right after crafting it; no give step ran.
  assert.match(action.requests[0]?.[0]?.content ?? "", /answer done only when the steps so far did every part of it/u);
});

test("the init prompt carries the style, the own goal, whose requests come first, and the freedom to decide", () => {
  const prompt = personaPrompt(testPersona({ style: "medieval", goal: "build yourself a base", authority: ["Server", "Tom", "*"] }));
  assert.match(prompt, /You build in the medieval style/u);
  assert.match(prompt, /Your own goal, when nobody needs you: build yourself a base/u);
  assert.match(prompt, /Server \(the world's operator\), then Tom, then any other player/u);
  assert.match(prompt, /When a request is unclear, impossible, or you do not know how, say so or ask/u);
  assert.match(personaPrompt(testPersona()), /You have no goal of your own/u);
  assert.match(chatSystemPrompt(testPersona({ stance: "rival" })), /"act" = you take on what they ask now/u);
  assert.match(chatSystemPrompt(testPersona()), /"later" = you take it on for when your current work is done/u);
  // Live 2026-10-01: "please never dig around here" got "I'll keep this spot safe" as talk, and nothing kept it.
  assert.match(chatSystemPrompt(testPersona()), /A promise that one of the things you can do keeps [\s\S]*? is "act"/u);
});

test("the goal tier picks the next own objective, knowing how the last ones went", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply({ objective: "Collect 16 oak_log for my base." });
  const objective = await mind.chooseObjective({
    persona: testPersona({ goal: "build yourself a base" }),
    snapshot: new FakeRuntime().snapshot,
    places: [],
    areas: [],
    lately: ["craft a crafting_table: done (crafted it)"],
  }, signal);
  assert.equal(objective, "Collect 16 oak_log for my base.");
  assert.match(planner.requests[0]?.[1]?.content ?? "", /- craft a crafting_table: done \(crafted it\)/u);
});

test("the house skill line lists what the character's own style needs", async () => {
  const { action, mind } = scriptedMind();
  action.reply({ done: "nothing to do" });
  await mind.next(workInput("anything", { persona: testPersona({ style: "medieval" }) }), signal);
  assert.match(action.requests[0]?.[0]?.content ?? "", /build a house in your medieval style .*small = 42 spruce_stairs, 36 oak_planks, 24 oak_log, 16 cobblestone, 7 spruce_slab, 3 glass_pane, 1 oak_door/u);
});

test("\"later\" is offered only while working for someone else; said anyway, the reply is repaired to act", async () => {
  assert.doesNotMatch(chatSystemPrompt(testPersona(), false), /"later"/u);
  const { chat, mind } = scriptedMind();
  chat.reply(
    { say: "Just a sec to finish this house first.", route: "later", request: "build Steve a small house" },
    { say: "On it!", route: "act", request: "build Steve a small house" },
  );
  const decision = await mind.chat({ ...chatInput("build me a house"), canWait: false }, signal);
  assert.deepEqual(decision, { say: "On it!", route: "act", request: "build Steve a small house" });
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"later" is not a route now/u);
});

test("every model call is reported with its tier, prompt, raw replies and decision, a repaired one included", async () => {
  const models = scriptedMind();
  const calls: ModelCall[] = [];
  const mind = new LlmMind({ chat: models.chat, action: models.action, planner: models.planner }, (call) => calls.push(call));
  models.chat.reply("not json", { say: "Hi!", route: "talk", request: "" });
  await mind.chat(chatInput("hello"), signal);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call?.tier, "chat");
  assert.equal(call?.model, "chat");
  assert.deepEqual(call?.replies, ["not json", "{\"say\":\"Hi!\",\"route\":\"talk\",\"request\":\"\"}"]);
  assert.equal(call?.turns.length, 4, "system, request, the bad reply and the repair request");
  assert.deepEqual(call?.result, { say: "Hi!", route: "talk", request: "" });

  models.planner.reply("nope", "still nope");
  await assert.rejects(mind.chooseObjective({ persona: testPersona(), snapshot: new FakeRuntime().snapshot, places: [], areas: [], lately: [] }, signal));
  assert.equal(calls[1]?.tier, "goal");
  assert.match(calls[1]?.error ?? "", /^\[LLM_BAD_REPLY\]/u);
});
