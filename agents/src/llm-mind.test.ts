import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCall } from "./brain-log.ts";
import { chatSystemPrompt, LlmMind, openingName, personaPrompt } from "./llm-mind.ts";
import type { ChatInput, WorkInput } from "./mind.ts";
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

test("preferences reach the init prompt as feelings, never as a rule: her feelings show, and she still does what she hates", () => {
  const prompt = personaPrompt(testPersona({ preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } }));
  assert.match(prompt, /You love farming and like building; you dislike fighting monsters and hate mining\. Your feelings show whenever work comes up:\nglad about what you love, reluctant about what you dislike or hate, even when you do it anyway, said in your own words./u);
  assert.doesNotMatch(personaPrompt(testPersona()), /You love/u);
});

test("with preferences, how a request is taken is the character's call; the work tier may pick the liked way; narration may show it", async () => {
  const preferences = { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } as const;
  const chatPrompt = chatSystemPrompt(testPersona({ preferences }));
  assert.match(chatPrompt, /reply with only a JSON object \{"spoken_to": \[\.\.\.\], "language": "\.\.\.", "work": "\.\.\.", "say": "\.\.\.", "route": "\.\.\.", "request": "\.\.\."\}/u);
  assert.match(chatPrompt, /- "work": first, the kind of work the message asks of you, one of building, reshaping ground, farming, [^\n]*fighting monsters/u);
  assert.match(chatPrompt, /and how you take it \(gladly,\n  grudgingly, bargaining, or declining\) is yours, in character, as your stance and whose requests come first allow/u);
  assert.doesNotMatch(chatSystemPrompt(testPersona()), /grudgingly|"work"/u);
  const { mind, action, chat } = scriptedMind();
  action.reply({ done: "nothing to do" });
  await mind.next({ persona: testPersona({ preferences }), objective: { text: "get food", requester: null }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] }, signal);
  assert.match(action.requests[0]?.[0]?.content ?? "", /- When there are several ways to reach the objective \(food from a farm or from hunting\), you may pick the one\n  you like\./u);
  chat.reply({ say: "Tilling again!" });
  await mind.narrate({ persona: testPersona({ preferences }), objective: "make a farm", outcome: "progress", detail: "tilling", history: [] }, signal);
  assert.match(chat.requests[0]?.[0]?.content ?? "", /Your feelings about the work may show in what you say\./u);
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
    opportunities: [],
    time: [],
  }, signal);
  assert.equal(objective, "Collect 16 oak_log for my base.");
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
    time: [],
  };
  planner.reply({ objective: "build a small medieval house here" }, { objective: "Fetch oak logs from beyond my old houses, then build." });
  assert.equal(await mind.chooseObjective(input, signal), "Fetch oak logs from beyond my old houses, then build.");
  assert.match(planner.requests[1]?.at(-1)?.content ?? "", /is what you just tried, and it failed: All nearby oak logs are in protected areas\./u);

  planner.reply({ objective: "Build a small medieval house here." }, { objective: "Build a small medieval house here." });
  assert.equal(await mind.chooseObjective(input, signal), "Build a small medieval house here.");
  planner.reply({ objective: "Build a small medieval house here." });
  assert.equal(await mind.chooseObjective({ ...input, lastFailed: null }, signal), "Build a small medieval house here.", "nothing failed: never sent back");
});

test("an unnamed line right after the speaker spoke to someone else is sent back once if taken for her; said again, it stands", async () => {
  // Live 2026-10-04: "fix it now" after "Opus, Vex is going through the ocean" was taken by both characters. In a
  // conversation with her (an unnamed line reaches the model only then), the speaker turned to Opus.
  const { chat, mind } = scriptedMind();
  const talking = [{ speaker: "Steve", text: "Ayla, wood please", to: ["Ayla"] }, { speaker: "Ayla", text: "On my way!", to: ["Steve"] }];
  const input = { ...chatInput("fix it now", false), history: [...talking, { speaker: "Steve", text: "Opus, Vex fell in the water", to: ["Opus"] }] };
  chat.reply({ spoken_to: ["Ayla"], say: "On it!", route: "act", request: "fix it" }, { spoken_to: ["Opus"], say: "", route: "ignore", request: "" });
  assert.equal((await mind.chat(input, signal)).route, "ignore");
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Steve to Opus: "Opus, Vex fell in the water"/u);
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /Steve's line just before this one spoke to Opus, and this one names nobody/u);

  chat.reply({ spoken_to: ["Ayla"], say: "Fine.", route: "talk", request: "" }, { spoken_to: ["Ayla"], say: "Fine.", route: "talk", request: "" });
  assert.equal((await mind.chat(input, signal)).route, "talk", "said again, it stands");

  // Her own line since, or the speaker's last line read as for her: no check.
  chat.reply({ spoken_to: ["Ayla"], say: "Sure.", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, history: [...input.history, { speaker: "Ayla", text: "Hm?", to: ["Steve"] }] }, signal)).route, "talk");
  chat.reply({ spoken_to: ["Ayla"], say: "Sure.", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, history: talking }, signal)).route, "talk");
});

test("a conversation starts only when she is addressed; an unnamed line is hers only while one with its speaker goes on", async () => {
  // Owner rule 2026-10-07, after the real world: players chatted among themselves in French, and each line got an answer.
  const { chat, mind } = scriptedMind();
  const input = chatInput("je vois plus les skins", false);
  // Not addressed, no conversation with her: left alone, the model not even asked.
  assert.deepEqual([(await mind.chat(input, signal)).route, chat.requests.length], ["ignore", 0]);
  // Her name, or a whisper, starts one.
  chat.reply({ spoken_to: ["Ayla"], language: "French", say: "Oui !", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, message: { ...input.message, message: "Ayla tu viens ?", addressed: true } }, signal)).route, "talk");
  chat.reply({ spoken_to: ["Ayla"], say: "Oui ?", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, message: { ...input.message, channel: "whisper" } }, signal)).route, "talk");
  // Going on: he spoke to her, or she answered him, within the last lines and minutes; then unnamed lines are read.
  const now = Date.now();
  chat.reply({ spoken_to: ["Ayla"], say: "Ah bon ?", route: "talk", request: "" });
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Ayla", text: "Tu as faim ?", to: ["Steve"], at: now }] }, signal)).route, "talk");
  // Gone quiet (minutes ago, or six lines of others since): over.
  const requests = chat.requests.length;
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Steve", text: "Ayla, salut", to: ["Ayla"], at: now - 10 * 60_000 }] }, signal)).route, "ignore");
  const others = Array.from({ length: 6 }, (_, index) => ({ speaker: "Bob", text: `ligne ${index}`, at: now }));
  assert.equal((await mind.chat({ ...input, history: [{ speaker: "Steve", text: "Ayla, salut", to: ["Ayla"], at: now }, ...others] }, signal)).route, "ignore");
  assert.equal(chat.requests.length, requests);
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

test("a line opening with someone else's name goes back once when taken; the second reply stands", async () => {
  // Live 2026-10-04 and the bench 2/3: "Opus, Vex is going through the Ocean without boat" answered by Vex.
  const { chat, mind } = scriptedMind();
  const line = "Opus, Ayla is going through the Ocean without boat, you said you fixed that";
  chat.reply(
    { spoken_to: ["Ayla"], say: "I'll get a boat!", route: "talk", request: "" },
    { spoken_to: ["Opus"], say: "", route: "ignore", request: "" },
  );
  assert.equal((await mind.chat(chatInput(line, true), signal)).route, "ignore");
  chat.reply(
    { spoken_to: ["Ayla"], say: "I'll get a boat!", route: "talk", request: "" },
    { spoken_to: ["Ayla"], say: "I'll get a boat!", route: "talk", request: "" },
  );
  assert.equal((await mind.chat(chatInput(line, true), signal)).route, "talk");
});

test("a request restated with \"me\" goes back once to name the speaker", async () => {
  // The bench 3/3: "Vex, mine me some iron ore" restated as "mine me some iron ore"; the work tier never saw the chat.
  const { chat, mind } = scriptedMind();
  chat.reply(
    { spoken_to: ["Ayla"], say: "Sure!", route: "act", request: "mine me some iron ore" },
    { spoken_to: ["Ayla"], say: "Sure!", route: "act", request: "mine some iron ore for Steve" },
  );
  assert.equal((await mind.chat(chatInput("Ayla, mine me some iron ore", true), signal)).request, "mine some iron ore for Steve");
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"request" says "me", "my" or "I": .* with Steve.s name in their place, keeping everything else/u);
  chat.reply({ spoken_to: ["Ayla"], say: "Sure!", route: "act", request: "mine iron ore for Steve, mine is gone" });
  assert.equal((await mind.chat(chatInput("Ayla, mine iron ore", true), signal)).route, "act");
});

test("only a capitalised name before a comma opens a line to someone", () => {
  assert.equal(openingName("Opus, Vex is going through the Ocean"), "Opus");
  assert.equal(openingName("@Tom: come here"), "Tom");
  for (const text of ["Hey, Ayla", "Thanks, that was quick", "opus, fix it", "Vex is going there", "Come here, Ayla"]) assert.equal(openingName(text), null, text);
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
  await assert.rejects(mind.chooseObjective({ persona: testPersona(), snapshot: new FakeRuntime().snapshot, places: [], areas: [], lately: [], opportunities: [], time: [] }, signal));
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
  const work: WorkInput = { persona: testPersona(), objective: { text: "build a house", requester: "StarOr1" }, snapshot: new FakeRuntime().snapshot, places: [], areas: [], steps: [], paused: [] };
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

test("\"where you are\" is her own position, and taking an order on never promises to finish something first", async () => {
  // Live 2026-10-04: "build yourself a small house right where you are now" became "at Tester's current position", and
  // she said "Just let me finish this little project first".
  const { chat, mind } = scriptedMind();
  chat.reply(
    { spoken_to: ["Ayla"], say: "Sure! Just let me finish this little project first.", route: "act", request: "build a small house at Steve's position" },
    { spoken_to: ["Ayla"], say: "Sure! Just let me finish this little project first.", route: "act", request: "build a small house at 0 64 0" },
    { spoken_to: ["Ayla"], say: "On it!", route: "act", request: "build a small house at 0 64 0" },
  );
  const decision = await mind.chat(chatInput("Ayla, build yourself a small house right where you are", true), signal);
  assert.deepEqual([decision.request, decision.say], ["build a small house at 0 64 0", "On it!"]);
  assert.match(chat.requests[1]?.at(-1)?.content ?? "", /"where you are" in Steve's line is where you stand, at 0 64 0/u);
  assert.match(chat.requests[2]?.at(-1)?.content ?? "", /"say" must not promise to finish anything first/u);
});
