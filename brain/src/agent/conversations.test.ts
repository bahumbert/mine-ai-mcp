// Tests of agent conversations: opening, groups, closing, orders ending them, status reads, requests from members.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import type { BrainEvent } from "../brain-log.ts";
import { ConversationBudget, type ConversationController } from "../conversation/controller.ts";
import { FakeRuntime, testPersona, until } from "../testing.ts";
import { agentFor, clockedAgentFor, clockUntil, heardOnce, others, say, talkOptions, toAyla } from "./agent-fixtures.test.ts";

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

test("the conversation's windows run on the monotonic clock and its end is written on the wall clock (the controller's two named clocks)", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  // The 90 s of clock fire the agent's polls and the conversation look: the silence and range ends are set past them, so the talk is still open to read.
  const conversation = { ...testPersona().settings.conversation, silenceSeconds: 600, outOfRangeSeconds: 600 };
  const settings = { ...testPersona().settings, conversation };
  const { agent, chat, stop } = clockedAgentFor(clock, new FakeRuntime(), { settings }, talkOptions());
  const talks = (agent as unknown as { talks: ConversationController }).talks;
  try {
    chat.reply({ ...toAyla, say: "Sure, what's up?" });
    await agent.handle(say("Vex", "Ayla, hi"));
    assert.notEqual(agent.conversation, null);
    await clock.advance(90_000);
    clock.stepWallClock(-30_000); // WSL steps about 2 s; a 2 s step still rounds to the same 1.5 minutes, so the step is 30 s to show a wall-read window
    assert.equal(talks.facts()?.minutes, 1.5, "the minutes are the monotonic time since the start, the wall step changed nothing");
    chat.reply({ gist: "Talked." });
    talks.end("goodbye");
    const endedAt = Date.now();
    await clock.settle(talks.finished(), 10_000);
    assert.equal(talks.lastTalk("Vex")?.endedAt, endedAt, "the end is a wall time, the one a memory writes as an ISO date");
  } finally {
    await stop();
  }
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
  await agent.handle(say("Vex", "I could eat", false), heardOnce(say("Vex", "I could eat", false)));
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
    const tiers = agentFor(t, runtime, { username: self, displayName: self }, talkOptions({ random: () => 0, otherAgents: others(other), conversations: { budget, modelFree: () => true } }));
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

test("its own line coming back is not a member's: no wake, no line counted", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const { agent, chat, stop } = clockedAgentFor(clock, runtime, {}, talkOptions());
  try {
    chat.reply({ ...toAyla, say: "Hi." });
    await agent.handle(say("Vex", "Ayla, hi"));
    const lines = agent.conversation!.lines;
    runtime.inbox.push(say("Ayla", "Hi."));
    await clock.advance(40); // eight polls of the agent (pollMs 5): the returned line is read, and nothing came of it
    assert.equal(runtime.inbox.length, 0, "the line was read");
    assert.equal(agent.conversation?.lines, lines);
    assert.equal(chat.requests.length, 1);
  } finally {
    await stop();
  }
});

test("an order ends a social conversation: its follow step is aborted, the order runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 5;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const events: BrainEvent[] = [];
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "Live well and be friendly." }, talkOptions({ journal: (event) => events.push(event), otherAgents: others("Vex") }));
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

test("a runtime that stays down is logged once by the conversation check, again only after a read worked", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { agent, chat, stop } = clockedAgentFor(clock, runtime, {}, talkOptions({ log: (line) => logs.push(line), talkLookMs: 5 }));
  try {
    chat.reply({ ...toAyla, say: "Hi." });
    await agent.handle(say("Vex", "Ayla, hi"));
    await clockUntil(clock, () => logs.some((line) => line.startsWith("listening as")));
    const status = runtime.status.bind(runtime);
    let down = true;
    runtime.status = async () => {
      if (down) throw new Error("runtime down");
      return status();
    };
    await clock.advance(120);
    assert.equal(logs.filter((line) => line.startsWith("conversation check failed")).length, 1);
    down = false;
    await clock.advance(60);
    down = true;
    await clock.advance(60);
    assert.equal(logs.filter((line) => line.startsWith("conversation check failed")).length, 2, "logged again after a read worked");
  } finally {
    await stop();
  }
});

test("no chance opening while a socialising objective is on its way to its partner", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  runtime.durations.navigate = 1_500;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Vex", position: { x: 30, y: 64, z: 0 } }] };
  const settings = { ...testPersona().settings, conversation: { ...testPersona().settings.conversation, checkEverySeconds: 1 } };
  const { agent, chat, planner, stop } = clockedAgentFor(clock, runtime, { goal: "Be friendly.", settings }, talkOptions({ otherAgents: others("Vex"), random: () => 0 }));
  try {
    planner.reply({ objective: "go and chat with Vex", for: "socialising" });
    await clockUntil(clock, () => agent.activity.includes("go and chat with Vex"));
    runtime.snapshot = { ...runtime.snapshot, players: [...runtime.snapshot.players, { username: "Bruno", position: { x: 4, y: 64, z: 0 } }] };
    await clock.advance(1_300); // past the conversation check period (1 s): the look ran, and the walk (1.5 s) is still on its way
    assert.equal(chat.requests.length, 0, "no opening call to Bruno on the way");
    assert.equal(agent.conversation, null);
  } finally {
    await stop();
  }
});

/** The status reads made by the conversation look (found by its frame in the stack: the goal loop reads the status too). */
function countStatusReads(runtime: FakeRuntime): { calls: number } {
  const reads = { calls: 0 };
  const status = runtime.status.bind(runtime);
  runtime.status = async () => {
    if ((new Error().stack ?? "").includes("lookAtConversations")) reads.calls += 1;
    return status();
  };
  return reads;
}

test("in a conversation the status is read at most once per 2 s, and the first look after it opens is not delayed", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const reads = countStatusReads(runtime);
  const { agent, chat, stop } = clockedAgentFor(clock, runtime, {}, talkOptions());
  try {
    chat.reply({ ...toAyla, say: "Sure, what's up?" });
    await clock.advance(50);
    const idle = reads.calls;
    await agent.handle(say("Vex", "Ayla, hi"));
    assert.notEqual(agent.conversation, null);
    assert.ok(idle >= 1, "an idle look was made before the talk opened, so the first look below proves the key");
    await clock.advance(500);
    assert.ok(reads.calls > idle, "the first look after the talk opened came within 500 ms");
    const first = reads.calls;
    await clock.advance(700);
    assert.ok(reads.calls - first <= 1, `${reads.calls - first} status reads in 0.7 s of conversation (poll 5 ms)`);
  } finally {
    await stop();
  }
});

test("in a group talk her reply to the carried partner's line is the trade ask, a reply to another member is not", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime, {}, talkOptions());
  const talks = (agent as unknown as { talks: { carryIntent(partner: string, intent: { kind: "trade"; want: string[]; offer: { item: string; count: number }[] }): void; facts(): unknown; askedSince(partner: string, since: number): boolean } }).talks;
  talks.carryIntent("Vex", { kind: "trade", want: ["iron_ingot"], offer: [{ item: "oak_log", count: 32 }] });
  chat.reply({ ...toAyla, say: "Hi Bruno." }, { to: ["Bruno"], say: "", route: "ignore", request: "" }, { ...toAyla, say: "Fine, Bruno." }, { ...toAyla, say: "Vex, iron for oak?" });
  await agent.handle(say("Bruno", "Ayla, hi"));
  await agent.handle(say("Vex", "Ayla, hey"));
  assert.equal(agent.conversation?.members.length, 3, "Bruno's talk, Vex joined");
  talks.facts();
  await agent.handle(say("Bruno", "Ayla, how are you?"));
  assert.equal(talks.askedSince("Vex", 0), false, "her reply to Bruno is not the ask");
  talks.facts();
  await agent.handle(say("Vex", "Ayla, so?"));
  assert.equal(talks.askedSince("Vex", 0), true, "her reply to Vex is");
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
  // The done report of the favour may be asked after it: the line's own request is the last one that is not a report.
  const lineRequest = chat.requests.filter((turns) => !(turns[1]?.content ?? "").includes(") is done:")).at(-1);
  assert.match(lineRequest?.[1]?.content ?? "", /This conversation:/u);
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
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "Live well and be friendly." }, talkOptions({ journal: (event) => events.push(event), otherAgents: others("Vex") }));
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
