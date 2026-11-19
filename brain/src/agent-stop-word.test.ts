// A stop word acts in the poll that reads it, before the burst window and any model call (plan 2026-11-18-model-call-lanes
// Task 3, spec D3). The bot is Ayla; Vex is another bot, Alex a player.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentOptions } from "./agent.ts";
import { INSTANT_TYPING } from "./body.ts";
import type { BrainEvent } from "./brain-log.ts";
import { ConversationBudget } from "./conversation/controller.ts";
import { OtherAgents } from "./other-agents.ts";
import type { Persona } from "./persona.ts";
import { SpeakerBudget } from "./speaker-budget.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "./testing.ts";

type Context = { after(fn: () => Promise<void>): void };

/** The reply the chat tier gives to a stop line it reads, and to a line that is nobody's. */
const STOP_REPLY = { spoken_to: ["Ayla"], say: "Stopped.", route: "stop", request: "" };
const IGNORE_REPLY = { spoken_to: [], say: "", route: "ignore", request: "" };
const LONG_STEP = { step: { skill: "collect_block", block: "oak_log", count: 4 } };

const say = (username: string, message: string, addressed = true) => ({ username, channel: "chat" as const, message, addressed });
const whisper = (username: string, message: string) => ({ username, channel: "whisper" as const, message, addressed: false });

/** A running Ayla with the stop word "stop" and the burst window of a real persona (1.5 s), over a runtime whose collect takes ever. */
function stopAgent(t: Context, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}, settings: Partial<Persona["settings"]> = {}) {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const events: BrainEvent[] = [];
  const logs: string[] = [];
  const tiers = scriptedMind();
  const agent = new Agent({
    persona: testPersona({ settings: { ...testPersona().settings, chatBurstMs: 1_500, ...settings }, ...persona }),
    runtime, mind: tiers.mind, otherAgents: new OtherAgents("Ayla", ["Vex"], null), log: (line) => logs.push(line), typing: INSTANT_TYPING, pollMs: 5,
    obeyRandom: () => 0, stopWords: ["stop"], knownNames: ["Alex"], journal: (event) => events.push(event), ...options,
  });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, runtime, events, logs, ...tiers };
}

/** Takes an order of `speaker` and waits until its step runs. */
async function takeOrder(built: ReturnType<typeof stopAgent>, speaker: string, request = "collect 4 oak_log"): Promise<void> {
  const steps = built.runtime.submitted.filter((call) => call.tool === "collect_block").length;
  built.chat.reply({ spoken_to: ["Ayla"], say: "On it.", route: "act", request });
  built.action.reply(LONG_STEP);
  await built.agent.handle(say(speaker, `Ayla, ${request}`));
  await until(() => built.runtime.submitted.filter((call) => call.tool === "collect_block").length > steps);
}

/** A bot with an own goal running (the planner chose a long collect). */
async function withOwnGoal(t: Context, options: Partial<AgentOptions> = {}, persona: Partial<Persona> = {}, settings: Partial<Persona["settings"]> = {}) {
  const built = stopAgent(t, { goal: "build yourself a base", ...persona }, options, settings);
  built.planner.reply({ objective: "collect 16 oak_log" });
  built.action.reply(LONG_STEP);
  await until(() => built.runtime.submitted.some((call) => call.tool === "collect_block"));
  return built;
}

const stopEvents = (events: readonly BrainEvent[]) => events.filter((event) => event.kind === "stop");

test("a whispered stop word ends the speaker's order in the poll that reads it, before any chat call ends", async (t) => {
  const built = stopAgent(t);
  await takeOrder(built, "Steve");
  assert.match(built.agent.activity, /for Steve/u);
  const release = built.chat.hold(); // the chat call for the stop line, whenever it starts, stays open until released
  built.chat.reply(STOP_REPLY);
  built.runtime.inbox.push(whisper("Steve", "stop"));
  await until(() => built.runtime.cancelled.length === 1);
  assert.equal(built.agent.activity, "idle");
  assert.deepEqual(built.runtime.said, ["On it."], "the stop line's chat call has not ended: nothing it says was said");
  assert.deepEqual(stopEvents(built.events), [{ kind: "stop", speaker: "Steve", text: "stop", channel: "whisper" }]);
  release();
  await until(() => built.runtime.said.length === 2, 4_000);
  assert.deepEqual(built.runtime.said, ["On it.", "Stopped."], "the chat tier still answers the line, in its own voice");
  const kinds = built.events.map((event) => event.kind).filter((kind) => kind === "stop" || kind === "chat");
  assert.deepEqual(kinds, ["chat", "stop", "chat"], "the order's own chat row, then the stop row before the chat row of the stop line");
});

test("a stop word naming the bot ends the speaker's work and the bot's own goal, and keeps Alex's order", async (t) => {
  const built = await withOwnGoal(t);
  await takeOrder(built, "Alex", "collect 2 dirt");
  await takeOrder(built, "Steve", "collect 4 oak_log");
  assert.match(built.agent.activity, /for Steve/u);
  built.action.reply(LONG_STEP);
  built.chat.reply(STOP_REPLY);
  built.runtime.inbox.push(say("Steve", "Ayla, STOP!"));
  await until(() => !built.agent.activity.includes("for Steve"));
  assert.match(built.agent.activity, /for Alex/u, "Alex's order is on top again");
  assert.doesNotMatch(built.agent.activity, /your own goal/u, "the own goal under it ended too");
  assert.equal(stopEvents(built.events).length, 1);
});

test("a public stop word naming nobody from a player with no order on the stack, and the bot's own line 'stop', change nothing", async (t) => {
  const built = await withOwnGoal(t);
  built.chat.reply(IGNORE_REPLY);
  built.runtime.inbox.push(say("Steve", "stop", false), say("Ayla", "stop", false), whisper("Ayla", "stop"));
  await sleep(300);
  assert.match(built.agent.activity, /your own goal/u);
  assert.equal(built.runtime.cancelled.length, 0);
  assert.deepEqual(stopEvents(built.events), []);
});

test("a stop word naming another bot or player is not this bot's, even from a speaker with an order on it", async (t) => {
  const built = stopAgent(t);
  await takeOrder(built, "Steve");
  built.chat.reply(IGNORE_REPLY, IGNORE_REPLY);
  built.runtime.inbox.push(say("Steve", "Vex stop", false));
  built.runtime.inbox.push(say("Steve", "Alex, stop", false));
  await sleep(300);
  assert.match(built.agent.activity, /for Steve/u);
  assert.deepEqual(stopEvents(built.events), []);
});

test("a public stop word naming nobody, just after the speaker named another bot, is not this bot's", async (t) => {
  const built = stopAgent(t);
  await takeOrder(built, "Steve");
  built.chat.reply(IGNORE_REPLY, IGNORE_REPLY);
  built.runtime.inbox.push(say("Steve", "Vex, come here", false));
  await until(() => built.chat.requests.length === 2, 4_000); // the line to Vex was read: the agent noted whom it named
  built.runtime.inbox.push(say("Steve", "stop", false));
  await sleep(300);
  assert.match(built.agent.activity, /for Steve/u);
  assert.deepEqual(stopEvents(built.events), []);
});

test("a public stop word right after a line to another bot, still waiting in the burst window, is not this bot's", async (t) => {
  const built = stopAgent(t);
  await takeOrder(built, "Steve");
  built.chat.reply(IGNORE_REPLY);
  built.runtime.inbox.push(say("Steve", "Vex, come here", false), say("Steve", "stop", false)); // one poll: the chat tier has read neither, only the inbox knows the first
  await sleep(300);
  assert.match(built.agent.activity, /for Steve/u);
  assert.deepEqual(stopEvents(built.events), []);
});

test("a speaker outside listensTo stops nothing", async (t) => {
  const built = await withOwnGoal(t, {}, { listensTo: ["Steve"] });
  built.runtime.inbox.push(whisper("Mallory", "stop"));
  await sleep(300);
  assert.match(built.agent.activity, /your own goal/u);
  assert.deepEqual(stopEvents(built.events), []);
});

test("another agent outside the bot's conversation stops nothing; inside it, it stops what that agent asked", async (t) => {
  const built = await withOwnGoal(t, { conversations: { budget: new ConversationBudget(2), modelFree: () => true } });
  built.runtime.inbox.push(say("Vex", "Ayla, stop"));
  await sleep(300);
  assert.match(built.agent.activity, /your own goal/u, "Vex is not a member of any conversation of hers");
  assert.deepEqual(stopEvents(built.events), []);
  built.chat.reply({ spoken_to: ["Ayla"], say: "Hi.", route: "talk", request: "" }, STOP_REPLY);
  await built.agent.handle(say("Vex", "Ayla, got a minute?"));
  assert.notEqual(built.agent.conversation, null, "Vex is a member now");
  built.runtime.inbox.push(say("Vex", "Ayla, stop"));
  await until(() => !built.agent.activity.includes("your own goal"));
  assert.equal(built.agent.activity, "idle");
  assert.equal(stopEvents(built.events).length, 1);
});

test("a stop word while idle rests the bot: the objective its goal tier chooses meanwhile is dropped and no goal starts in the rest time", async (t) => {
  const built = stopAgent(t, { goal: "build yourself a base" }, {}, { restAfterStopSeconds: 30 });
  const release = built.planner.hold();
  built.planner.reply({ objective: "collect 16 oak_log" });
  built.action.reply(LONG_STEP);
  await until(() => built.planner.requests.length === 1); // idle: the goal tier is thinking, nothing is on the stack
  assert.equal(built.agent.activity, "idle");
  built.chat.reply(STOP_REPLY);
  built.runtime.inbox.push(whisper("Steve", "stop"));
  await until(() => stopEvents(built.events).length === 1);
  release();
  await sleep(500);
  assert.equal(built.agent.activity, "idle", "the bot rests");
  assert.equal(built.planner.requests.length, 1, "and the goal tier is not asked again");
});

test("a stop word drops the speaker's earlier lines still in the burst window: the chat tier reads the stop alone", async (t) => {
  const built = stopAgent(t);
  built.chat.reply(STOP_REPLY);
  built.runtime.inbox.push(say("Steve", "Ayla get 4 oak_log"), say("Steve", "Ayla stop")); // one poll: both are in the burst window
  await until(() => built.runtime.said.length === 1, 4_000);
  assert.equal(built.chat.requests.length, 1, "one chat call");
  const read = built.chat.requests[0]?.[1]?.content ?? "";
  assert.match(read, /Ayla stop/u);
  assert.doesNotMatch(read, /oak_log/u, "the order line before the stop was dropped, not joined");
  assert.equal(built.agent.activity, "idle");
});

test("an order line awaiting a trade's decision when the stop word comes is not taken", async (t) => {
  const built = stopAgent(t, {}, {}, { chatBurstMs: 0 });
  let decide!: () => void;
  let waitingForDecision = false;
  const decided = new Promise<void>((resolve) => { decide = resolve; });
  const relations = (built.agent as unknown as { relations: { decided: () => Promise<string | null> } }).relations;
  relations.decided = async () => {
    waitingForDecision = true; // `handle` has read the reply and waits for the trade decision
    await decided;
    return null;
  };
  const swap = { spoken_to: ["Ayla"], say: "Deal.", route: "act", request: "get 4 oak_log", trade: { action: "propose", give: [{ item: "bread", count: 2 }], get: [{ item: "oak_log", count: 4 }], first: "me" } };
  built.chat.reply(swap, STOP_REPLY);
  built.runtime.snapshot = { ...built.runtime.snapshot, inventory: [{ name: "bread", count: 10 }], players: [{ username: "Steve", position: { x: 3, y: 64, z: 0 } }] };
  built.runtime.inbox.push(say("Steve", "Ayla, swap 2 bread for 4 oak_log and fetch them"));
  await until(() => waitingForDecision);
  built.runtime.inbox.push(say("Steve", "Ayla stop"));
  await until(() => stopEvents(built.events).length === 1);
  decide();
  await until(() => built.runtime.said.length === 2, 4_000);
  assert.equal(built.agent.activity, "idle", "the order the line gave was not taken after the stop");
  assert.ok(built.logs.some((line) => line.includes("superseded during the trade decision: no order taken")), built.logs.join("\n"));
});

test("an order typed just before the stop word does not start after it", async (t) => {
  const built = stopAgent(t);
  const release = built.chat.hold();
  built.chat.reply({ spoken_to: ["Ayla"], say: "On it.", route: "act", request: "collect 4 oak_log" }, STOP_REPLY);
  built.runtime.inbox.push(say("Steve", "Ayla get 4 oak_log"));
  await until(() => built.chat.requests.length === 1, 4_000); // the first line's chat call is open
  await sleep(500);
  built.runtime.inbox.push(say("Steve", "Ayla stop"));
  await until(() => stopEvents(built.events).length === 1);
  release();
  await until(() => built.events.filter((event) => event.kind === "chat").length === 1, 4_000);
  const [first] = built.events.filter((event) => event.kind === "chat");
  assert.equal(first?.kind === "chat" && first.superseded, true);
  assert.equal(built.agent.activity, "idle");
  assert.deepEqual(built.events.filter((event) => event.kind === "objective"), []);
});

test("next action: an order right after the stop is taken, the rest time blocks only own goals", async (t) => {
  const built = stopAgent(t, {}, {}, { restAfterStopSeconds: 30 });
  await takeOrder(built, "Steve");
  built.chat.reply(STOP_REPLY, { spoken_to: ["Ayla"], say: "Coming.", route: "act", request: "follow Steve" });
  built.action.reply(LONG_STEP);
  built.runtime.inbox.push(whisper("Steve", "stop"));
  await until(() => stopEvents(built.events).length === 1);
  await until(() => built.runtime.said.length === 2, 4_000); // the chat call of the stop line ended: route stop, idempotent
  built.runtime.inbox.push(say("Steve", "Ayla follow me"));
  await until(() => built.agent.activity.includes("follow Steve"), 4_000);
  assert.match(built.agent.activity, /for Steve/u);
});

test("a speaker whose budget is empty stops the order at once during a flood and loses the lines waiting", async (t) => {
  const speakerBudget = new SpeakerBudget({ perMinute: 1, burst: 1 });
  const built = stopAgent(t, {}, { speakerBudget });
  await takeOrder(built, "Steve");
  assert.equal(speakerBudget.tryTake("Steve"), true, "the one token is spent");
  const asked = built.chat.requests.length;
  built.runtime.inbox.push(say("Steve", "Ayla do this"));
  built.runtime.inbox.push(say("Steve", "Ayla and that"));
  await sleep(100);
  built.runtime.inbox.push(whisper("Steve", "stop"));
  await until(() => built.runtime.cancelled.length === 1);
  assert.equal(built.agent.activity, "idle");
  assert.equal(built.chat.requests.length, asked, "no model call and no token: the stop word needs neither");
  assert.ok(built.logs.some((line) => line.includes("stopped at once (2 earlier lines dropped)")), built.logs.join("\n"));
});

test("no stop words, no early stop: the order ends when the chat reply 'stop' returns", async (t) => {
  const built = stopAgent(t, {}, { stopWords: [] });
  await takeOrder(built, "Steve");
  const asked = built.chat.requests.length;
  const release = built.chat.hold();
  built.chat.reply(STOP_REPLY);
  built.runtime.inbox.push(whisper("Steve", "stop"));
  await until(() => built.chat.requests.length === asked + 1, 4_000);
  await sleep(100);
  assert.match(built.agent.activity, /for Steve/u, "the chat call is open and nothing stopped the order");
  release();
  await until(() => built.agent.activity === "idle", 2_000);
  assert.deepEqual(stopEvents(built.events), []);
});
