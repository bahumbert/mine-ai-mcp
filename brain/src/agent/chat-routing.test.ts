// Tests of how the agent reads chat: routes, queued requests, superseded lines, whispers and stop.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Agent } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { say, agentFor, others, spokenTo, steveAt, journaledAgent } from "./agent-fixtures.test.ts";

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
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base", settings: { ...testPersona().settings, restAfterStopSeconds: 60 } });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await clock.settle(until(() => runtime.submitted.some((call) => call.tool === "collect_block")), 10_000);
  chat.reply({ say: "Okay, I'll take a break.", route: "stop", request: "" });
  await clock.settle(agent.handle(say("Steve", "stop, take a break")), 10_000);
  await clock.settle(until(() => runtime.cancelled.length === 1), 10_000);
  assert.equal(agent.activity, "idle");
  await clock.advance(59_000);
  assert.equal(planner.requests.length, 1, "no new own objective while resting");
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

test("a name added to the live list of other agents after construction is not answered (a bot started from chat while this one runs)", async (t) => {
  const runtime = new FakeRuntime();
  const names: string[] = ["Vex"];
  const { agent, chat } = agentFor(t, runtime, {}, { otherAgents: { names: () => names } });
  chat.reply({ say: "Hello Brea.", route: "talk", request: "" });
  await agent.handle(say("Brea", "Ayla come here"));
  await until(() => runtime.said.length === 1);
  assert.equal(chat.requests.length, 1, "before the list names her, Brea is a player");
  names.push("Brea");
  await agent.handle(say("Brea", "Ayla come here again"));
  assert.equal(chat.requests.length, 1, "no model call for a name the provider now lists");
  assert.deepEqual(runtime.said, ["Hello Brea."]);
});

test("under an order, what it starts doing and why is given to the chat tier, which says it; its own goals stay silent", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action, planner, events } = journaledAgent(t, runtime, { goal: "gather dirt", settings: { ...testPersona().settings, narrateEverySeconds: 0 } });
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
  await until(() => events.filter((event) => event.kind === "objective" && event.event === "finished").length === 2);
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
  await until(() => runtime.inbox.length === 0);
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
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base", settings: { ...testPersona().settings, restAfterStopSeconds: 60 } });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await clock.settle(until(() => runtime.submitted.some((call) => call.tool === "collect_block")), 10_000);
  const release = chat.hold();
  chat.reply(
    { spoken_to: ["Ayla"], say: "Okay, stopping.", route: "stop", request: "" },
    { spoken_to: ["Ayla"], say: "Right.", route: "talk", request: "" },
  );
  runtime.inbox.push(say("Steve", "Ayla, stop"));
  await clock.settle(until(() => chat.requests.length === 1), 10_000);
  runtime.inbox.push(say("Steve", "Ayla, please"));
  await clock.settle(until(() => runtime.inbox.length === 0), 10_000);
  release();
  await clock.settle(until(() => runtime.said.length === 1), 10_000);
  await clock.settle(until(() => runtime.cancelled.length === 1), 10_000);
  assert.deepEqual(runtime.said, ["Right."]);
  assert.equal(agent.activity, "idle");
  await clock.advance(59_000);
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
  await until(() => runtime.inbox.length === 0);
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

test("a line naming nobody, right after its speaker named another character, carries that as a fact for the others only (live 2026-10-11: 'thanks, no rush' answered by Ayla and Vex)", async (t) => {
  const asked: (string | undefined)[] = [];
  const seen = async (character: string, otherNames: string[]) => {
    const runtime = new FakeRuntime();
    const tiers = scriptedMind();
    const mind = { ...tiers.mind, chat: (input: Parameters<typeof tiers.mind.chat>[0], signal: AbortSignal) => { asked.push(input.talkedTo === undefined ? undefined : `${input.talkedTo.name}@${input.talkedTo.secondsAgo}`); return tiers.mind.chat(input, signal); } } as typeof tiers.mind;
    const agent = new Agent({ persona: testPersona({ username: character, displayName: character }), runtime, mind, otherAgents: others(...otherNames), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
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
  const read = runtime.readEvents.bind(runtime);
  let calls = 0;
  runtime.readEvents = async () => {
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
  const read = runtime.readEvents.bind(runtime);
  let calls = 0;
  runtime.readEvents = async () => {
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

test("a line naming nobody within 60 s of its speaker naming another character is ignored, unless the model says it speaks to her or everyone (A5, live 2026-10-11, L6)", async () => {
  const outcome = async (to: string[], afterMs: number) => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const runtime = new FakeRuntime();
    const tiers = scriptedMind();
    const mind = { ...tiers.mind, chat: async (input: { message: { message: string } }) => input.message.message === "thanks" ? { to, say: "You're welcome!", route: "talk" as const, request: "" } : { to: ["Vex"], say: "", route: "ignore" as const, request: "" } } as unknown as typeof tiers.mind;
    const agent = new Agent({ persona: testPersona({ username: "Ayla", displayName: "Ayla" }), runtime, mind, otherAgents: others("Vex"), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
    const controller = new AbortController();
    const running = agent.run(controller.signal);
    try {
      await clock.settle(agent.handle(say("Tester", "Vex, mine some stone", false)), 10_000);
      runtime.said.length = 0;
      await clock.advance(afterMs, 1_000);
      await clock.settle(agent.handle(say("Tester", "thanks", false)), 10_000);
      return runtime.said.length;
    } finally {
      controller.abort();
      await clock.settle(running, 10_000);
    }
  };
  assert.equal(await outcome(["Tester"], 20_000), 0, "the model read it as for the speaker only: ignored");
  assert.equal(await outcome(["unclear"], 20_000), 0);
  assert.equal(await outcome(["unclear"], 70_000), 1, "70 s later: routed as before");
  assert.equal(await outcome(["Ayla"], 20_000), 1, "it names her");
  assert.equal(await outcome(["everyone"], 20_000), 1, "it names everyone");
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
