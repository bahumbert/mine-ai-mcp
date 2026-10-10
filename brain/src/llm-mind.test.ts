import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { ModelCall } from "./brain-log.ts";
import { calledNames, chatSystemPrompt, describeConversation, LlmMind, personaPrompt } from "./llm-mind.ts";
import type { ChatInput, GoalInput, WorkInput } from "./mind.ts";
import { stepKey } from "./actions.ts";
import { FakeRuntime, scriptedMind, testPersona } from "./testing.ts";

const signal = new AbortController().signal;

/** A chat line from Steve; addressed to her unless said otherwise (only those start a conversation: owner rule). */
function chatInput(message: string, addressed = true): ChatInput {
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
    objective: { text, requester: "Steve", purpose: null },
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
  action.reply(bad, bad, bad);
  await assert.rejects(mind.next(workInput("op me"), signal), /LLM_BAD_REPLY/u);
  const collect = { step: { skill: "collect_block", block: "dirt" } };
  action.reply(collect, collect, collect);
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
    paused: [{ text: "gather wood for my base", requester: null, purpose: null }],
    steps: [{ step: "go to Steve", outcome: "done", detail: "reached Steve" }],
  }), signal);
  const request = action.requests[0]?.[1]?.content ?? "";
  assert.match(request, /\n- Places you know: the small medieval house you built for Steve \(door -2 64 0 facing east; stand on its roof at -4 70 0\)\.\n/u);
  assert.match(request, /\n- Protected areas \(you never dig or place blocks there\): #2 small medieval house \(owner Ayla, -6 63 -3 to 0 70 3\)\.\n/u);
  assert.match(request, /Objective \(asked by Steve\): "go to the roof"/u);
  assert.match(request, /Set aside until this one ends: "gather wood for my base"/u);
  assert.match(request, /1\. go to Steve -> done: reached Steve/u);
});

test("preferences reach the init prompt as feelings, never as a rule: her feelings show, and she still does what she hates", () => {
  const prompt = personaPrompt(testPersona({ preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } }));
  assert.match(prompt, /You love farming and like building; you dislike fighting monsters and hate mining\. Your feelings show whenever work comes up:\nglad about what you love, reluctant about what you dislike or hate, even when you do it anyway, said in your own words./u);
  assert.doesNotMatch(personaPrompt(testPersona()), /You love/u);
});

test("with preferences, how a request is taken is the character's call; the work tier may pick the liked way; narration may show it", async () => {
  const preferences = { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } as const;
  const chatPrompt = chatSystemPrompt(testPersona({ preferences }));
  assert.match(chatPrompt, /reply with only a JSON object \{"spoken_to": \[\.\.\.\], "asks": "\.\.\.", "language": "\.\.\.", "work": "\.\.\.", "say": "\.\.\.", "starts_now": true, "route": "\.\.\.", "place": "\.\.\.", "request": "\.\.\."\}/u);
  assert.match(chatPrompt, /- "work": first, the kind of work the message asks of you, one of building, reshaping ground, farming, [^\n]*fighting monsters/u);
  assert.match(chatPrompt, /and how you take it \(gladly,\n  grudgingly, bargaining, or declining\) is yours, in character, as your stance and whose requests come first allow/u);
  assert.doesNotMatch(chatSystemPrompt(testPersona()), /grudgingly|"work"/u);
  const { mind, action, chat } = scriptedMind();
  action.reply({ done: "nothing to do" });
  await mind.next({ persona: testPersona({ preferences }), objective: { text: "get food", requester: null, purpose: null }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] }, signal);
  assert.match(action.requests[0]?.[0]?.content ?? "", /- When there are several ways to reach the objective \(food from a farm or from hunting\), you may pick the one\n  you like\./u);
  chat.reply({ say: "Tilling again!" });
  await mind.narrate({ persona: testPersona({ preferences }), objective: "make a farm", outcome: "progress", detail: "tilling", history: [] }, signal);
  assert.match(chat.requests[0]?.[0]?.content ?? "", /Your feelings about the work may show in what you say\./u);
});

test("the work tier knows crops ripen over time near water and bread is made from wheat", async () => {
  const { mind, action } = scriptedMind();
  action.reply({ done: "ok" });
  await mind.next({ persona: testPersona(), objective: { text: "make bread", requester: "Tom", purpose: null }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] }, new AbortController().signal);
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
    opportunities: [],
    time: [], drawn: [], chances: [],
  }, signal);
  assert.equal(objective.text, "Collect 16 oak_log for my base.");
  assert.equal(objective.purpose, null, "no \"for\" in the reply: no purpose");
  assert.match(planner.requests[0]?.[1]?.content ?? "", /- craft a crafting_table: done \(crafted it\)/u);
});

test("the objective that just failed, chosen again as it was, is sent back once with its reason; chosen again, it stands", async () => {
  const { planner, mind } = scriptedMind();
  const input = {
    persona: testPersona({ goal: "build yourself a base" }),
    snapshot: new FakeRuntime().snapshot,
    places: [],
    areas: [],
    lately: ["Build a small medieval house here.: failed (All nearby oak logs are in protected areas.)"],
    lastFailed: { objective: "Build a small medieval house here.", reason: "All nearby oak logs are in protected areas." },
    opportunities: [],
    time: [], drawn: [], chances: [],
  };
  planner.reply({ objective: "build a small medieval house here" }, { objective: "Fetch oak logs from beyond my old houses, then build." });
  assert.equal((await mind.chooseObjective(input, signal)).text, "Fetch oak logs from beyond my old houses, then build.");
  assert.match(planner.requests[1]?.at(-1)?.content ?? "", /is what you just tried, and it failed: All nearby oak logs are in protected areas\./u);

  planner.reply({ objective: "Build a small medieval house here." }, { objective: "Build a small medieval house here." });
  assert.equal((await mind.chooseObjective(input, signal)).text, "Build a small medieval house here.");
  planner.reply({ objective: "Build a small medieval house here." });
  assert.equal((await mind.chooseObjective({ ...input, lastFailed: null }, signal)).text, "Build a small medieval house here.", "nothing failed: never sent back");
});

test("a conversation starts only when she is addressed; an unnamed line is hers only while one with its speaker goes on, or when it speaks to everyone", async () => {
  // Owner rule 2026-10-07, after the real world: players chatted among themselves in French, and each line got an answer.
  const { chat, mind } = scriptedMind();
  const input = chatInput("je vois plus les skins", false);
  // Not addressed, no conversation with her: the model is told so, and only a reading as spoken to everyone gets through
  // (owner 2026-10-09: "anyone got bread?" is answered). Her name in its reading never starts a conversation.
  chat.reply(
    { spoken_to: ["unclear"], language: "French", say: "Ah bon ?", route: "talk", request: "" },
    { spoken_to: ["Ayla"], language: "French", say: "Moi non plus", route: "talk", request: "" },
    { spoken_to: ["everyone"], asks: "who has bread?", language: "English", say: "No bread here, sorry!", route: "talk", request: "" },
  );
  const unclear = await mind.chat(input, signal);
  assert.deepEqual([unclear.route, unclear.say, unclear.to], ["ignore", "", undefined]);
  assert.match(chat.requests[0]?.at(-1)?.content ?? "", /does not name you, and you are not talking with Steve: it is for you only if it asks or calls everyone around/u);
  assert.deepEqual([(await mind.chat(input, signal)).route, chat.requests.length], ["ignore", 2], "read as hers: left alone, not sent back");
  const everyone = await mind.chat(chatInput("anyone got bread?", false), signal);
  assert.deepEqual([everyone.route, everyone.say, everyone.to], ["talk", "No bread here, sorry!", ["everyone"]]);
  // Others talking among themselves just before (here Bob asking the speaker), none of it to her: part of their chat,
  // the model not asked. Minutes old, their lines no longer count.
  const asked = chat.requests.length;
  const now = Date.now();
  const answer = await mind.chat({ ...chatInput("yeah, restarting now", false), history: [{ speaker: "Bob", text: "Steve, did you restart?", to: ["Steve"], at: now }] }, signal);
  assert.deepEqual([answer.route, answer.say, chat.requests.length], ["ignore", "", asked]);
  chat.reply({ spoken_to: ["everyone"], asks: "who has bread?", language: "English", say: "Not me, sorry!", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...chatInput("anyone got bread?", false), history: [{ speaker: "Bob", text: "brb", at: now - 10 * 60_000 }] }, signal)).route, "talk");
  // A line to everyone that asks nothing: left alone.
  chat.reply({ spoken_to: ["everyone"], asks: "", language: "English", say: "Ouch!", route: "talk", request: "" });
  assert.equal((await mind.chat(chatInput("lol that creeper got me again", false), signal)).route, "ignore");
  // Naming someone else, or after the speaker's line to someone else: left alone, the model not asked.
  const before = chat.requests.length;
  assert.equal((await mind.chat({ ...chatInput("teleport me Opus", false), knownNames: ["Opus"] }, signal)).route, "ignore");
  assert.equal((await mind.chat({ ...chatInput("fix it now", false), history: [{ speaker: "Steve", text: "Opus, Vex is in the ocean", to: ["Opus"], at: now }] }, signal)).route, "ignore");
  assert.equal(chat.requests.length, before);
  // Her name, or a whisper, starts one.
  chat.reply({ spoken_to: ["Ayla"], language: "French", say: "Oui !", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, message: { ...input.message, message: "Ayla tu viens ?", addressed: true } }, signal)).route, "talk");
  chat.reply({ spoken_to: ["Ayla"], say: "Oui ?", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, message: { ...input.message, channel: "whisper" } }, signal)).route, "talk");
  // Going on: he spoke to her, or she answered him, within the last lines and minutes; then unnamed lines are read.
  chat.reply({ spoken_to: ["Ayla"], say: "Ah bon ?", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Ayla", text: "Tu as faim ?", to: ["Steve"], at: now }] }, signal)).route, "talk");
  // Gone quiet (minutes ago, or six lines of others since): over, and her reading of the line as hers is not enough.
  chat.reply({ spoken_to: ["Ayla"], say: "Ah bon ?", route: "talk", request: "" }, { spoken_to: ["Ayla"], say: "Ah bon ?", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Steve", text: "Ayla, salut", to: ["Ayla"], at: now - 10 * 60_000 }] }, signal)).route, "ignore");
  const others = Array.from({ length: 6 }, (_, index) => ({ speaker: "Bob", text: `ligne ${index}`, at: now }));
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Steve", text: "Ayla, salut", to: ["Ayla"], at: now }, ...others] }, signal)).route, "ignore");
});

test("a reply sent back for answering a line it read as for someone else keeps that reading", async () => {
  // Live 2026-10-04: "nice work today, thanks Vex" came back read as spoken to the speaker, which let it through.
  const { chat, mind } = scriptedMind();
  chat.reply(
    { spoken_to: ["Vex"], say: "You're welcome!", route: "talk", request: "" },
    { spoken_to: ["Steve"], say: "Thanks for the thanks!", route: "talk", request: "" },
  );
  const held = await mind.chat(chatInput("nice work today, thanks Vex"), signal);
  assert.deepEqual([held.route, held.to, held.say], ["ignore", ["Vex"], ""]);
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

  models.planner.reply("nope", "still nope", "nope again");
  await assert.rejects(mind.chooseObjective({ persona: testPersona(), snapshot: new FakeRuntime().snapshot, places: [], areas: [], lately: [], opportunities: [], time: [], drawn: [], chances: [] }, signal));
  assert.equal(calls[1]?.tier, "goal");
  assert.match(calls[1]?.error ?? "", /^\[LLM_BAD_REPLY\]/u);
});

test("a character with preferences names the kind of work a request is before answering; one without is never asked", async () => {
  const preferences = { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } as const;
  const input = (persona: ReturnType<typeof testPersona>): ChatInput => ({
    persona, message: { username: "Tom", channel: "chat", message: "get me 20 stone", addressed: true }, history: [], snapshot: new FakeRuntime().snapshot, activity: "idle", places: [], areas: [],
  });
  const { mind, chat } = scriptedMind();
  chat.reply({ work: "mining", say: "Ugh, stone... fine.", route: "act", request: "get Tom 20 stone" }, { say: "Sure!", route: "act", request: "get Tom 20 stone" });
  assert.deepEqual(await mind.chat(input(testPersona({ preferences })), signal), { work: "mining", say: "Ugh, stone... fine.", route: "act", request: "get Tom 20 stone" });
  assert.deepEqual(await mind.chat(input(testPersona()), signal), { say: "Sure!", route: "act", request: "get Tom 20 stone" });
});

test("the chat tier names who a line speaks to first; a line it reads as for others only is never taken on", async () => {
  // In a conversation with her (StarOr1 spoke to her just before), so the model reads these lines.
  const input = (message: string): ChatInput => ({
    persona: testPersona(), message: { username: "StarOr1", channel: "chat", message, addressed: false }, history: [{ speaker: "StarOr1", text: "Ayla, hi", to: ["Ayla"] }], snapshot: new FakeRuntime().snapshot, activity: "idle", places: [], areas: [],
  });
  const { mind, chat } = scriptedMind();
  // Live 2026-10-03: "Opus, ..." (the owner talking to the controller) was taken as an order. Read as for Opus, an
  // "act" is sent back; the corrected answer ignores it.
  chat.reply(
    { spoken_to: ["Opus"], say: "On it!", route: "act", request: "check on Vex" },
    { spoken_to: ["Opus"], say: "", route: "ignore", request: "" },
  );
  assert.deepEqual(await mind.chat(input("Opus, Vex is going through the ocean"), signal), { to: ["Opus"], say: "", route: "ignore", request: "" });
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"spoken_to" is \["Opus"\], which is not you: "route" must be "ignore"/u);
  // Her name anywhere, one of several, everyone or unclear: hers to answer; "@" and a comma-separated string read too.
  for (const to of [["Vex", "Ayla"], ["everyone"], ["unclear"], "@ayla", "Vex, Ayla"]) {
    chat.reply({ spoken_to: to, say: "Sure!", route: "act", request: "get wood" });
    assert.equal((await mind.chat(input("Vex, mine stone. Ayla, get wood."), signal)).route, "act", JSON.stringify(to));
  }
  const prompt = chatSystemPrompt(testPersona());
  assert.match(prompt, /- "spoken_to": first, who the message speaks to \(its listeners, never the player who says it\)/u);
  assert.match(prompt, /"\.\.\. thanks Ayla"/u);
});

test("give_up or done written as a skill inside step is read as what it says, its reason kept", async () => {
  const { mind, action } = scriptedMind();
  const work: WorkInput = { persona: testPersona(), objective: { text: "build a house", requester: "StarOr1", purpose: null }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] };
  action.reply({ thought: "No logs.", step: { skill: "give_up", reason: "All nearby oak logs are in protected areas." } }, { step: { skill: "done", summary: "built it" } });
  assert.deepEqual(await mind.next(work, signal), { kind: "give_up", reason: "All nearby oak logs are in protected areas." });
  assert.deepEqual(await mind.next(work, signal), { kind: "done", summary: "built it" });
});

/**
 * Live 2026-10-03, in a conversation with Ayla: "no stop harvesting, this is important" and "I can move away, no
 * problem" were read as spoken to StarOr1, who said them, and ignored.
 */
test("the speaker is never one of the listeners, and a line for her is never ignored", async () => {
  const input = (message: string): ChatInput => ({
    persona: testPersona(), message: { username: "StarOr1", channel: "chat", message, addressed: false }, history: [{ speaker: "Ayla", text: "Harvesting now!", to: ["StarOr1"] }], snapshot: new FakeRuntime().snapshot, activity: "idle", places: [], areas: [],
  });
  const { mind, chat } = scriptedMind();
  chat.reply(
    { spoken_to: ["StarOr1"], say: "", route: "ignore", request: "" },
    { spoken_to: ["StarOr1"], say: "Got it, stopping now!", route: "stop", request: "" },
  );
  assert.deepEqual(await mind.chat(input("no stop harvesting, this is important"), signal), { to: ["unclear"], say: "Got it, stopping now!", route: "stop", request: "" });
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"spoken_to" is \["unclear"\], which includes you: answer it/u);
  chat.reply({ spoken_to: ["Ayla"], say: "", route: "ignore", request: "" }, { spoken_to: ["Ayla"], say: "", route: "talk", request: "" });
  assert.equal((await mind.chat(input("I can move away, no problem"), signal)).route, "talk");
  // A line for someone else stays ignored, and one without spoken_to is not checked.
  chat.reply({ spoken_to: ["Opus"], say: "", route: "ignore", request: "" }, { say: "", route: "ignore", request: "" });
  assert.equal((await mind.chat(input("Opus, fix it"), signal)).route, "ignore");
  assert.equal((await mind.chat(input("hm"), signal)).route, "ignore");
});

test("a step far away that a turned sign brings near goes back once; sent again, it stands", async () => {
  // Live 2026-10-04: "go to 499 76 109" for a log at -499 76 109 walked Ayla 750 blocks east.
  const { action, mind } = scriptedMind();
  const at = { ...new FakeRuntime().snapshot, position: { x: -480, y: 70, z: 100 } };
  action.reply({ step: { skill: "go_to", x: 499, y: 76, z: 109 } }, { step: { skill: "go_to", x: -499, y: 76, z: 109 } });
  const fixed = await mind.next(workInput("get wood", { snapshot: at }), signal);
  assert.deepEqual(fixed.kind === "step" ? fixed.step : null, { skill: "go_to", x: -499, y: 76, z: 109 });
  assert.match(action.requests[1]?.at(-1)?.content ?? "", /x 499 is 979 blocks from you, but with the sign turned \(-499 109\) it is 21 blocks away/u);
  action.reply({ step: { skill: "go_to", x: 499, y: 76, z: 109 } }, { step: { skill: "go_to", x: 499, y: 76, z: 109 } });
  const meant = await mind.next(workInput("get wood", { snapshot: at }), signal);
  assert.equal(meant.kind === "step" && meant.step.skill === "go_to" ? meant.step.x : null, 499);
});

test("a build refused for missing materials is said to be ready once they are all carried", async () => {
  // Live 2026-10-04: given everything a house lacked, Ayla went on looking for logs and never built.
  const { action, mind } = scriptedMind();
  const steps = [{ step: "build a small house", outcome: "failed" as const, detail: "missing 3 oak_log, 1 oak_door for a small medieval house (the rest is carried): fetch exactly the missing items with get_items, then build again" }];
  const carrying = (inventory: { name: string; count: number }[]) => ({ ...new FakeRuntime().snapshot, inventory });
  action.reply({ done: "ok" }, { done: "ok" });
  await mind.next(workInput("build a house", { steps, snapshot: carrying([{ name: "oak_log", count: 2 }, { name: "oak_door", count: 1 }]) }), signal);
  assert.doesNotMatch(action.requests[0]?.at(-1)?.content ?? "", /is carried now/u);
  await mind.next(workInput("build a house", { steps, snapshot: carrying([{ name: "oak_log", count: 2 }, { name: "oak_log", count: 1 }, { name: "oak_door", count: 1 }]) }), signal);
  assert.match(action.requests[1]?.at(-1)?.content ?? "", /Everything a small medieval house was missing \(3 oak_log, 1 oak_door\) is carried now: build it again\./u);
});


/** A snapshot with Steve in sight at 103 64 -40 and Tom far away, her own position 0 64 0. */
function crowded() {
  return { ...new FakeRuntime().snapshot, players: [{ username: "Steve", position: { x: 103.4, y: 64, z: -39.6 } }, { username: "Tom", position: null }, { username: "Opus", position: null }] };
}

test("what the history shows about a message is given in the prompt before the call, never sent back after it (ADR-017)", async () => {
  // Live 2026-10-04: "fix it now" after "Opus, Vex is going through the ocean" was taken by both characters. These were
  // send-backs with an English opening-word list; now the model is told, and its reply stands.
  const { chat, mind } = scriptedMind();
  const talking = [{ speaker: "Steve", text: "Ayla, wood please", to: ["Ayla"], at: Date.now() - 40_000 }, { speaker: "Ayla", text: "On my way!", to: ["Steve"], at: Date.now() - 39_000 }];
  const input: ChatInput = { ...chatInput("fix it now", false), history: [...talking, { speaker: "Steve", text: "Opus, Vex fell in the water", to: ["Opus"] }], snapshot: crowded() };
  chat.reply({ spoken_to: ["Ayla"], say: "On it!", route: "act", request: "fix it" });
  const decision = await mind.chat(input, signal);
  assert.equal(decision.route, "act", "a reply that is consistent with itself is not sent back");
  assert.equal(chat.requests.length, 1);
  const request = chat.requests[0]?.[1]?.content ?? "";
  assert.match(request, /About this message:\n- You are talking with Steve \(your last exchange was \d+ s ago\)\.\n- Steve's line just before this one spoke to Opus, not to you, and this message names nobody\./u);
  assert.ok(request.indexOf("About this message") < request.indexOf("New message:"), "before the message");
  // Someone else spoke to the speaker just before (live 2026-10-07: "ok j'arrive" after Bob's "Tom, tu viens miner ?").
  const answering: ChatInput = {
    ...chatInput("ok j'arrive", false),
    snapshot: crowded(),
    history: [{ speaker: "Steve", text: "Ayla, need help?", to: ["Ayla"] }, { speaker: "Ayla", text: "No thanks!", to: ["Steve"] }, { speaker: "Tom", text: "Steve, coming to mine?", to: ["Steve"] }],
  };
  assert.match(describeConversation(answering), /- Tom spoke to Steve just before this message, which names nobody\./u);
  // An addressed line, a line naming a player, and an empty history show no such fact.
  assert.equal(describeConversation({ ...answering, message: { ...answering.message, addressed: true } }).includes("spoke to Steve"), false);
  assert.equal(describeConversation({ ...input, message: { ...input.message, message: "fix it Opus" } }).includes("just before this one"), false);
  assert.equal(describeConversation(chatInput("hi", true)), "");
});

test("calledNames: known names opening a sentence before a comma or colon, or written @name (ADR-017 point 7)", () => {
  const names = ["Opus", "Vex", "Ayla"];
  assert.deepEqual(calledNames("Opus, Vex is going through the Ocean without boat, you said you fixed that", names), ["Opus"]);
  assert.deepEqual(calledNames("Opus, Vex traverse l'océan sans bateau, tu avais dit que c'était réglé", names), ["Opus"]);
  assert.deepEqual(calledNames("Ayla, get wood. Vex, mine stone.", names), ["Ayla", "Vex"]);
  assert.deepEqual(calledNames("nice work today, thanks Vex", names), []);
  assert.deepEqual(calledNames("@Ayla come", names), ["Ayla"]);
  assert.deepEqual(calledNames("Ok, Vex get wood", ["Vex", "Ayla"]), []);
  assert.deepEqual(calledNames("opus: help", names), ["Opus"]);
  assert.deepEqual(calledNames("Vex , dig", names), ["Vex"]);
  assert.deepEqual(calledNames("Vexing, dig\nvex: now", names), ["Vex"]);
  assert.deepEqual(calledNames("Opus, Opus: Opus!", names), ["Opus"]);
  assert.deepEqual(calledNames("Ayla, get some wood and Vex, mine some stone.", names), ["Ayla", "Vex"]);
  assert.deepEqual(calledNames("nice work, thanks Vex, see you", names), ["Vex"]);
  assert.deepEqual(calledNames("Ayla, get some wood and Vex mine some stone", names), ["Ayla"], "no comma after the second name: not a call");
});

test("describeConversation tells a character named without being called that another name is called (ADR-017 point 7)", () => {
  const vex = testPersona({ id: "vex", username: "Vex", displayName: "Vex" });
  const opusLine = (persona = vex): ChatInput => ({ ...chatInput("Opus, Vex is going through the Ocean without boat, you said you fixed that", false), persona, snapshot: crowded() });
  const fact = /- This message calls Opus by name \(a name followed by a comma or colon\); it names you without calling you\./u;
  assert.match(describeConversation({ ...opusLine(), knownNames: ["Opus"] }), fact);
  assert.match(describeConversation(opusLine()), fact, "Opus is a player online here");
  // Not named: the fact is for a character the message names.
  const ayla = opusLine(testPersona());
  assert.equal(describeConversation({ ...ayla, knownNames: ["Opus"] }).includes("calls Opus"), false);
  // Called herself: nothing to add.
  const both: ChatInput = { ...chatInput("Ayla, get wood. Vex, mine stone.", true), snapshot: crowded(), knownNames: ["Opus"] };
  assert.equal(describeConversation({ ...both, persona: vex }).includes("calls"), false);
  assert.equal(describeConversation(both).includes("calls"), false);
  // No known name beyond hers, no fact.
  const alone = { ...chatInput("Opus, Ayla is going through the ocean"), snapshot: new FakeRuntime().snapshot };
  assert.equal(describeConversation(alone), "");
  // A name from the history is known too.
  const spoken = { ...alone, history: [{ speaker: "Opus", text: "hello", to: ["everyone"] }] };
  assert.match(describeConversation(spoken), /calls Opus by name/u);
});

test("a reply that speaks to her when the message calls others by name and names her without calling her goes back, unless it takes an order on (ADR-017 point 7)", async () => {
  const vex = testPersona({ id: "vex", username: "Vex", displayName: "Vex" });
  const input = (line: string): ChatInput => ({ ...chatInput(line, true), persona: vex, snapshot: crowded(), knownNames: ["Opus"] });
  {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["Vex"], say: "Sorry!", route: "talk", request: "" }, { spoken_to: ["Opus"], say: "", route: "ignore", request: "" });
    const decision = await mind.chat(input("Opus, Vex traverse l'océan sans bateau"), signal);
    assert.equal(decision.route, "ignore");
    assert.equal(chat.requests.length, 2);
    const sentBack = JSON.stringify(chat.requests[1]);
    assert.ok(sentBack.includes("spoken_to"), sentBack);
    assert.ok(sentBack.includes("the message calls Opus by name and names you without calling you"), sentBack);
  }
  {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["everyone"], say: "Hm.", route: "talk", request: "" });
    assert.equal((await mind.chat(input("Opus, Vex traverse l'océan sans bateau"), signal)).route, "talk");
    assert.equal(chat.requests.length, 1, "not sent back");
  }
  {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["Vex"], say: "On it!", route: "act", request: "mine some stone" });
    assert.equal((await mind.chat(input("Ayla, get some wood. Vex, mine some stone."), signal)).route, "act");
    assert.equal(chat.requests.length, 1, "called herself: not sent back");
  }
  {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["Vex"], say: "On it!", route: "act", request: "mine some stone" });
    assert.equal((await mind.chat(input("Ayla, get some wood and Vex mine some stone"), signal)).route, "act");
    assert.equal(chat.requests.length, 1, "an order taken on is not held to the called names");
  }
});

test("a conversation interrupted by someone else speaking to the speaker is not given as going on", () => {
  // Bench: "ok j'arrive" after Ayla's exchange with StarOr1 and Bob's "StarOr1, tu viens miner avec moi ?" got both facts.
  const input: ChatInput = {
    ...chatInput("ok j'arrive", false),
    message: { username: "StarOr1", channel: "chat", message: "ok j'arrive", addressed: false },
    history: [
      { speaker: "StarOr1", text: "Ayla, tu as besoin d'aide ?", to: ["Ayla"], at: Date.now() - 20_000 },
      { speaker: "Ayla", text: "Non merci !", to: ["StarOr1"], at: Date.now() - 19_000 },
      { speaker: "Bob", text: "StarOr1, tu viens miner avec moi ?", to: ["StarOr1"], at: Date.now() - 5_000 },
    ],
    snapshot: { ...new FakeRuntime().snapshot, players: [{ username: "StarOr1", position: null }, { username: "Bob", position: null }] },
  };
  const facts = describeConversation(input);
  assert.match(facts, /- Bob spoke to StarOr1 just before this message, which names nobody./u);
  assert.equal(facts.includes("You are talking with"), false);
});

test("a reply that speaks to her when the line answers someone else who just spoke to its speaker goes back (ADR-017)", async () => {
  const lines = (ayla: boolean) => [
    { speaker: "StarOr1", text: "Ayla, tu as besoin d'aide ?", to: ["Ayla"], at: Date.now() - 20_000 },
    { speaker: "Ayla", text: "Non merci !", to: ["StarOr1"], at: Date.now() - 19_000 },
    { speaker: "Bob", text: "StarOr1, tu viens miner avec moi ?", to: ["StarOr1"], at: Date.now() - 5_000 },
    ...(ayla ? [{ speaker: "Ayla", text: "Super !", to: ["StarOr1"], at: Date.now() - 2_000 }] : []),
  ];
  const input = (addressed: boolean, ayla = false): ChatInput => ({
    ...chatInput("ok j'arrive", addressed),
    message: { username: "StarOr1", channel: "chat", message: "ok j'arrive", addressed },
    history: lines(ayla),
    snapshot: { ...new FakeRuntime().snapshot, players: [{ username: "StarOr1", position: null }, { username: "Bob", position: null }] },
  });
  {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["Ayla"], say: "Super !", route: "talk", request: "" }, { spoken_to: ["Bob"], say: "", route: "ignore", request: "" });
    assert.equal((await mind.chat(input(false), signal)).route, "ignore");
    assert.equal(chat.requests.length, 2);
    assert.ok(JSON.stringify(chat.requests[1]).includes("this message names nobody and Bob spoke to StarOr1 just before it: it answers Bob, not you"));
  }
  for (const [name, given] of [["addressed", input(true)], ["Ayla answered after Bob", input(false, true)]] as const) {
    const { chat, mind } = scriptedMind();
    chat.reply({ spoken_to: ["Ayla"], say: "Super !", route: "talk", request: "" });
    assert.equal((await mind.chat(given, signal)).route, "talk", name);
    assert.equal(chat.requests.length, 1, `${name}: not sent back`);
  }
});

test("no function of the chat tier reads what a player wrote beyond whether it names someone (ADR-017)", () => {
  const source = readFileSync(new URL("./llm-mind.ts", import.meta.url), "utf8");
  for (const gone of ["openingName", "OPENING_WORDS", "WHERE_YOU_ARE", "finishSentBack", "requestSentBack"]) assert.ok(!source.includes(gone), gone);
  // No regex literal over the line for "me", "my", "I", "where" or "first" (the English patches this replaced).
  assert.doesNotMatch(source, /\\b\(?(?:\?:)?(?:\[Mm\]e|my|where|let me|first|finish)/u);
});

test("the code writes where a request happens, from the reply's place: the speaker's position or that she cannot see them, or her own", async () => {
  const { chat, mind } = scriptedMind();
  const input = (snapshot = crowded()): ChatInput => ({ ...chatInput("Ayla, build me a small house here"), snapshot });
  const act = (place?: string) => ({ spoken_to: ["Ayla"], say: "On my way!", route: "act", request: "build Steve a small house", ...(place !== undefined && { place }) });
  chat.reply(act("speaker"), act("speaker"), act("you"), act("named"), act("none"), act());
  const seen = await mind.chat(input(), signal);
  assert.deepEqual([seen.request, seen.place], ["build Steve a small house (at 103 64 -40, where Steve stands)", "speaker"]);
  const unseen = await mind.chat(input({ ...crowded(), players: [{ username: "Steve", position: null }] }), signal);
  assert.equal(unseen.request, "build Steve a small house (where Steve is; you cannot see them from here)");
  const hers = await mind.chat(input(), signal);
  assert.equal(hers.request, "build Steve a small house (at 0 64 0, where you stand)");
  for (const expected of ["named", "none", undefined]) {
    const asis = await mind.chat(input(), signal);
    assert.deepEqual([asis.request, asis.place], ["build Steve a small house", expected]);
  }
});

test("\"act\" whose own line does not start now goes back; later and talk are not held to it", async () => {
  // Live 2026-10-04: "Just let me finish this little project first" with "act". The model judges its own line, in its
  // language (starts_now), instead of an English regex over it.
  const { chat, mind } = scriptedMind();
  chat.reply(
    { spoken_to: ["Ayla"], say: "D'accord, je finis ça d'abord !", starts_now: false, route: "act", request: "build Steve a house" },
    { spoken_to: ["Ayla"], say: "J'arrive tout de suite !", starts_now: true, route: "act", request: "build Steve a house" },
  );
  const decision = await mind.chat(chatInput("Ayla, construis-moi une maison"), signal);
  assert.deepEqual([decision.say, decision.startsNow], ["J'arrive tout de suite !", true]);
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"starts_now" is false, but "act" stops what you were doing and starts at once/u);
  chat.reply({ spoken_to: ["Ayla"], say: "After this.", starts_now: false, route: "later", request: "build Steve a house" });
  assert.equal((await mind.chat(chatInput("Ayla, build me a house"), signal)).route, "later");
  chat.reply({ spoken_to: ["Ayla"], say: "Hm.", starts_now: false, route: "talk", request: "" });
  assert.equal((await mind.chat(chatInput("Ayla, ready?"), signal)).route, "talk");
});

test("the chat prompt explains place and starts_now, and no longer asks for coordinates in the request", () => {
  const prompt = chatSystemPrompt(testPersona());
  assert.match(prompt, /\{"spoken_to": \[\.\.\.\], "asks": "\.\.\.", "language": "\.\.\.", "say": "\.\.\.", "starts_now": true, "route": "\.\.\.", "place": "\.\.\.", "request": "\.\.\."\}/u);
  assert.match(prompt, /- "place": where the request happens/u);
  assert.match(prompt, /Never write\n  coordinates for "speaker" or "you" in "request": they are added for you/u);
  assert.doesNotMatch(prompt, /"for"/u);
  assert.doesNotMatch(prompt, /write them as the speaker's name and coordinates/u);
});

test("the goal tier's \"for\" names the kind of work the objective is for, by id or in words; an unknown or missing one is no purpose", async () => {
  const { planner, mind } = scriptedMind();
  const input = { persona: testPersona({ goal: "build yourself a base" }), snapshot: new FakeRuntime().snapshot, places: [], areas: [], lately: [], opportunities: [], time: [], drawn: [], chances: [] };
  planner.reply({ objective: "Build a house.", for: "building" }, { objective: "Fight.", for: "fighting monsters" }, { objective: "Dream.", for: "knitting" }, { objective: "Rest.", for: "none" });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Build a house.", purpose: "building" });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Fight.", purpose: "mob_combat" });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Dream.", purpose: null });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Rest.", purpose: null });
  assert.equal(planner.requests.length, 4, "an unknown \"for\" is not sent back");
});

/** A goal call's input for a character with a goal, a snapshot with nothing in it, and the given draw. */
function goalInput(overrides: Partial<GoalInput> = {}): GoalInput {
  return { persona: testPersona({ goal: "build yourself a base" }), snapshot: new FakeRuntime().snapshot, places: [], areas: [], lately: [], opportunities: [], time: [], drawn: [], chances: [], ...overrides };
}

const chancesOf = (...activities: GoalInput["drawn"]) => activities.map((activity) => ({ activity, chance: 1 / activities.length }));

test("the goal tier is told what it feels like doing now, before the things that could use doing", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply({ objective: "Build a house.", for: "building" }, { objective: "Mine.", for: "mining" }, { objective: "Rest." });
  await mind.chooseObjective(goalInput({ drawn: ["building", "mob_combat"], chances: chancesOf("building", "mob_combat", "mining") }), signal);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /Right now you feel most like building, or else fighting monsters\./u);
  assert.ok(request.indexOf("Right now you feel most like") < request.indexOf("Things that could use doing"));
  await mind.chooseObjective(goalInput({ drawn: ["mining"], chances: chancesOf("mining") }), signal);
  assert.match(planner.requests[1]?.[1]?.content ?? "", /Right now you feel most like mining\./u);
  await mind.chooseObjective(goalInput(), signal);
  assert.doesNotMatch(planner.requests[2]?.[1]?.content ?? "", /you feel most like/u, "nothing drawn: nothing said");
});

test("the things that could use doing for a drawn activity come first, the others keep their order, none is dropped", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply({ objective: "Eat." });
  const opportunities = [
    { activities: ["crafting" as const], text: "your stone_pickaxe has 5 uses left" },
    { activities: ["farming" as const, "hunting" as const], text: "you carry no food; you are starving" },
    { activities: ["building" as const], text: "you have no house of your own yet" },
    { activities: ["crafting" as const], text: "you carry no bed" },
  ];
  await mind.chooseObjective(goalInput({ opportunities, drawn: ["building", "crafting"], chances: chancesOf("building", "crafting", "farming") }), signal);
  const request = planner.requests[0]?.[1]?.content ?? "";
  const at = (text: string) => request.indexOf(text);
  assert.ok(at("stone_pickaxe") < at("no house of your own") && at("no house of your own") < at("no bed") && at("no bed") < at("you are starving"), request);
  assert.ok(at("you are starving") > -1, "an urgent opportunity is still shown whatever the draw");
});

test("the goal prompt asks for what it feels like now, urgent things first, and a \"for\" among the available activities", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply({ objective: "Build." });
  await mind.chooseObjective(goalInput({ drawn: ["building"], chances: chancesOf("building", "mob_combat") }), signal);
  const system = planner.requests[0]?.[0]?.content ?? "";
  assert.match(system, /Pick an objective for what you feel like now \(the\s+first, else the second\)/u);
  assert.match(system, /something urgent comes first \(starving, no tools for\s+it, night\), and then say so/u);
  assert.match(system, /\{"objective": "<one sentence>", "for": "<kind of work>"\}/u);
  assert.match(system, /"for" is the kind of work[\s\S]*one of building, fighting monsters/u);
  assert.doesNotMatch(system, /follow your tastes, or vary/u);
});

test("a \"for\" outside the available activities is no purpose", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply({ objective: "Hunt.", for: "hunting" }, { objective: "Mine.", for: "mining" });
  const input = goalInput({ drawn: ["building", "mining"], chances: chancesOf("building", "mining") });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Hunt.", purpose: null });
  assert.deepEqual(await mind.chooseObjective(input, signal), { text: "Mine.", purpose: "mining" });
});

test("a step that failed once is shown and runs when sent again; failed twice, it is refused every time", async () => {
  // Live 2026-10-10, run 6: sent back once, "craft cooked_beef" and "get 7 spruce_log" still came 18 and 22 times.
  const craft = { skill: "craft_item", item: "cooked_beef", count: 6 } as const;
  const once = { step: "craft 3 cooked_beef", key: stepKey({ ...craft, count: 3 }), detail: "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef. Smelted in a furnace instead: cooked_beef from beef.", objective: "Cook some food", minutesAgo: 4, count: 1 };
  const first = scriptedMind();
  first.action.reply({ thought: "Cook it.", step: craft });
  assert.deepEqual(await first.mind.next(workInput("Cook beef in the furnace", { earlierFailures: [once] }), signal), { kind: "step", step: craft, thought: "Cook it." });
  assert.equal(first.action.requests.length, 1, "not sent back");
  assert.match(first.action.requests[0]?.[1]?.content ?? "", /Steps that failed lately in your objectives[^\n]*\n- craft 3 cooked_beef, 4 minutes ago, for "Cook some food": \[ITEMS_NOT_CRAFTABLE\]/u);
  const twice = { ...once, count: 2 };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const refused = scriptedMind();
    refused.action.reply({ thought: "Again.", step: craft }, { thought: "Again.", step: craft }, { thought: "Again.", step: craft });
    await assert.rejects(refused.mind.next(workInput("Cook beef in the furnace", { earlierFailures: [twice] }), signal), /LLM_BAD_REPLY/u);
    assert.equal(refused.action.requests.length, 3, "refused at every try, until the repair rounds run out");
    assert.match(refused.action.requests[1]?.at(-1)?.content ?? "", /"craft 6 cooked_beef" failed 2 times in the last 30 minutes, the last 4 minutes ago.*Smelted in a furnace instead.*refused: choose a different step, or give this objective up/u);
  }
  const shown = scriptedMind();
  shown.action.reply({ thought: "Other.", step: { skill: "collect_block", block: "oak_log", count: 1 } });
  await shown.mind.next(workInput("Cook beef", { earlierFailures: [twice] }), signal);
  assert.match(shown.action.requests[0]?.[1]?.content ?? "", /- craft 3 cooked_beef, failed 2 times, the last 4 minutes ago, for "Cook some food" \(refused now\)/u);
});

test("a step unlike the ones that failed lately is not sent back; counts aside, the same thing is the same step", async () => {
  const { action, mind } = scriptedMind();
  const earlier = { step: "craft 3 cooked_beef", key: stepKey({ skill: "craft_item", item: "cooked_beef", count: 3 }), detail: "no recipe", objective: "Cook", minutesAgo: 2, count: 2 };
  action.reply({ thought: "Furnace.", step: { skill: "get_items", items: [{ item: "cooked_beef", count: 3 }] } });
  assert.equal((await mind.next(workInput("Cook beef", { earlierFailures: [earlier] }), signal)).kind, "step");
  assert.equal(action.requests.length, 1);
  assert.equal(stepKey({ skill: "craft_item", item: "cooked_beef", count: 3 }), stepKey({ skill: "craft_item", item: "cooked_beef", count: 64 }));
  assert.notEqual(stepKey({ skill: "craft_item", item: "cooked_beef", count: 3 }), stepKey({ skill: "craft_item", item: "bread", count: 3 }));
  assert.equal(stepKey({ skill: "get_items", items: [{ item: "a", count: 1 }, { item: "b", count: 2 }] }), stepKey({ skill: "get_items", items: [{ item: "b", count: 9 }, { item: "a", count: 9 }] }));
});

test("the work tier is told a failed or refused step comes back with its reason, is accepted once more, and that giving up beats trying again", async () => {
  const { mind, action } = scriptedMind();
  action.reply({ done: "ok" });
  await mind.next(workInput("anything"), signal);
  assert.match((action.requests[0]?.[0]?.content ?? "").replace(/\s+/gu, " "), /A step that failed or was refused comes back with its reason: follow what the reason says, or choose a different step\. The same step is accepted once more at most\. When nothing works for an objective, give it up and choose another one: giving up is better than trying again\./u);
});
