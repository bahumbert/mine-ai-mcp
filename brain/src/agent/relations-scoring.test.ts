// Tests of how heard lines score relations and answer open requests: the partner's reply, a whisper, a line naming me, a nameless line, a need heard from a partner and the seek reach.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrainEvent } from "../brain-log.ts";
import type { AgentRelations } from "../relations/agent-relations.ts";
import { newRelation, withSaid } from "../relations/record.ts";
import { FakeRuntime, until } from "../testing.ts";
import { agentFor, heardOnce, others, say, talkOptions } from "./agent-fixtures.test.ts";
import { chatFromFarAgent, MIN, ORDER, savedRelations, takenObjectives, tradingRuntime } from "./trade-fixtures.test.ts";

test("a line that asks for something opens a request, and the answer to it scores", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.reply(
    { spoken_to: ["Ayla"], asks: "", language: "English", say: "Theo, could you give me 5 oak_log?", route: "talk", request: "", asks_of: ["Theo"], asks_what: "5 oak_log" },
    { spoken_to: ["Ayla"], asks: "", language: "English", say: "Understood.", route: "talk", request: "", my_request: { n: 1, answer: "refused" } },
  );
  await agent.handle(say("Theo", "Ayla, what do you need?"));
  await until(() => runtime.said.length === 1);
  await until(() => savedRelations(runtime)[0]?.requests.length === 1);
  assert.equal(savedRelations(runtime)[0]?.requests[0]?.what, "5 oak_log");
  await agent.handle(say("Theo", "Ayla, no, sorry"));
  await until(() => runtime.said.length === 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /Your requests to Theo:\n1\. You asked Theo for 5 oak_log 0 min ago\./u);
  await until(() => savedRelations(runtime)[0]?.ledger.length === 1);
  const theo = savedRelations(runtime)[0]!;
  assert.deepEqual([theo.requests, theo.ledger[0]?.kind, theo.score], [[], "request_refused", -3]);
});

test("a hurt_by event read from the runtime scores the attacker", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  agentFor(t, runtime, {}, { journal: (event) => events.push(event) });
  runtime.hurtEvents.push({ attacker: "Steve", direct: null, at: Date.now() });
  await until(() => events.some((e) => e.kind === "relation" && e.event === "scored" && e.scoreKind === "hurt" && e.partner === "Steve"));
});

const ASK_THEO = { spoken_to: ["Theo"], asks: "", language: "English", say: "Theo, can you spare 4 coal?", route: "talk", request: "", asks_of: ["Theo"], asks_what: "4 coal" };

/** The ask goes out, held or not: Theo then has a record to speak against. */
async function agentAsking(t: Parameters<typeof agentFor>[0], runtime: FakeRuntime) {
  const made = agentFor(t, runtime);
  const relations = (made.agent as unknown as { relations: AgentRelations }).relations;
  made.chat.reply(ASK_THEO);
  return { ...made, relations };
}
const theoRequests = (relations: AgentRelations) => relations.book.get("Theo")?.requests ?? [];

test("a heard line reaches the relations: the partner's marks the request, the bot's own echo marks nothing", async (t) => {
  const runtime = tradingRuntime();
  const { agent, relations } = await agentAsking(t, runtime);
  await agent.handle(say("Theo", "Ayla, do you have coal?"));
  await until(() => theoRequests(relations).length === 1);
  const at = theoRequests(relations)[0]!.at;
  await new Promise((r) => setTimeout(r, 5));
  runtime.inbox.push({ username: "Ayla", channel: "chat", message: "Theo, can you spare 4 coal?", addressed: false });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(theoRequests(relations)[0]?.heard, false, "its own line is never a member's");
  runtime.inbox.push({ username: "Theo", channel: "chat", message: "Ayla, I got no coal on me.", addressed: true });
  await until(() => theoRequests(relations)[0]?.heard === true);
  assert.equal(theoRequests(relations)[0]?.at, at);
});

test("a line said while the ask is still being typed does not count, and the request opens once it is said", async (t) => {
  const runtime = tradingRuntime();
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const say0 = runtime.say.bind(runtime);
  runtime.say = async (...args) => { await held; return say0(...args); };
  const { agent, relations } = await agentAsking(t, runtime);
  relations.book.load([newRelation("Theo", Date.now(), 0)]);
  await agent.handle(say("Theo", "Ayla, do you have coal?"));
  runtime.inbox.push({ username: "Theo", channel: "chat", message: "hello?", addressed: false });
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(theoRequests(relations), [], "not asked yet: nobody has heard the ask");
  release();
  await until(() => theoRequests(relations).length === 1);
  assert.equal(theoRequests(relations)[0]?.heard, false);
});

test("a failed say opens no request", async (t) => {
  const runtime = tradingRuntime();
  runtime.say = async () => { throw new Error("socket closed"); };
  const { agent, relations } = await agentAsking(t, runtime);
  await agent.handle(say("Theo", "Ayla, do you have coal?"));
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(theoRequests(relations), []);
});

// Only a line spoken to her answers her request (owner 2026-10-29: Lena's ask to the Tester was not answered by his line to Ayla).
const fromTheo = (message: string, extra: { channel?: "chat" | "whisper"; addressed?: boolean } = {}) => ({ ...say("Theo", message, false), ...extra });
const readTo = (to: string[], route = "talk") => ({ spoken_to: to, asks: "", language: "English", say: "ok", route, request: "" });
const theoHeard = (relations: AgentRelations) => theoRequests(relations)[0]?.heard;

/** Ayla has asked Theo for coal and the request is open; the chat tier's next replies are the ones of the test. */
async function askedTheoForCoal(t: Parameters<typeof agentFor>[0]) {
  const runtime = tradingRuntime();
  const made = await agentAsking(t, runtime);
  await made.agent.handle(say("Theo", "Ayla, do you have coal?"));
  await until(() => theoRequests(made.relations).length === 1);
  return { ...made, runtime };
}

test("a whisper from the asked partner answers", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo(["Vex"], "ignore"));
  runtime.inbox.push(fromTheo("no coal", { channel: "whisper" }));
  await until(() => theoHeard(relations) === true);
});

test("a line naming me answers", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo(["Vex"], "ignore"));
  runtime.inbox.push(fromTheo("Ayla, no coal", { addressed: true }));
  await until(() => theoHeard(relations) === true);
});

test("a line from my conversation partner naming nobody answers", async (t) => {
  const runtime = tradingRuntime();
  const made = agentFor(t, runtime, {}, talkOptions());
  const relations = (made.agent as unknown as { relations: AgentRelations }).relations;
  made.chat.reply(ASK_THEO, readTo(["Vex"], "ignore"));
  await made.agent.handle(say("Theo", "Ayla, do you have coal?"));
  await until(() => theoRequests(relations).length === 1);
  assert.equal(made.agent.conversation?.members.includes("Theo"), true);
  runtime.inbox.push(fromTheo("I got no coal on me."));
  await until(() => theoHeard(relations) === true);
});

test("a line naming another character does not answer", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo(["Vex"], "ignore"));
  runtime.inbox.push(fromTheo("Vex, do you have coal?"));
  await until(() => chat.requests.length === 2);
  await sleep(60);
  assert.equal(theoHeard(relations), false);
});

test("a line the chat tier reads as to me answers, stamped at its read time", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  const release = chat.hold();
  chat.reply(readTo(["Ayla"]));
  runtime.inbox.push(fromTheo("got some coal?"));
  await until(() => chat.requests.length === 2);
  await sleep(10);
  relations.asked(["Theo"], "2 iron_ingot", null, runtime.snapshot);
  await until(() => theoRequests(relations).length === 2);
  release();
  await until(() => theoRequests(relations)[0]?.heard === true);
  await sleep(30);
  assert.deepEqual(theoRequests(relations).map((q) => q.heard), [true, false], "the ask sent while the model thought is not answered by a line read before it");
});

test("a line the chat tier reads as nameless answers, one read as to everyone alone does not", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo(["everyone"]));
  runtime.inbox.push(fromTheo("hello all"));
  await until(() => chat.requests.length === 2);
  await sleep(60);
  assert.equal(theoHeard(relations), false, "to everyone alone");
  chat.reply(readTo([]));
  runtime.inbox.push(fromTheo("got coal?"));
  await until(() => theoHeard(relations) === true);
});

test("a reading that answers my request closes it by that answer, even when read as to another", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply({ ...readTo(["Vex"], "ignore"), my_request: { n: 1, answer: "refused" } });
  runtime.inbox.push(fromTheo("Vex, tell her I refuse"));
  await until(() => (relations.book.get("Theo")?.ledger.length ?? 0) === 1);
  assert.equal(relations.book.get("Theo")?.ledger[0]?.kind, "request_refused");
  assert.equal(theoRequests(relations).length, 0, "the answered request is closed, not left to expire unheard");
});

test("a superseded reply's to: me still answers", async (t) => {
  const { agent, runtime, relations, chat } = await askedTheoForCoal(t);
  await sleep(5);
  const message = fromTheo("got some coal?");
  const release = chat.hold();
  // The newer line is decided first (it is not held) and takes the first scripted reply.
  chat.reply(readTo(["Vex"], "ignore"), readTo(["Ayla"]));
  const handling = agent.handle(message, heardOnce(message));
  await until(() => chat.requests.length === 2);
  runtime.inbox.push(fromTheo("Vex, never mind"));
  await until(() => chat.requests.length === 3);
  release();
  await handling;
  assert.equal(theoHeard(relations), true);
});

test("a chat tier failure on the partner's line marks it heard (nothing is scored)", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  assert.equal(chat.requests.length, 1);
  runtime.inbox.push(fromTheo("got some coal?"));
  await until(() => theoHeard(relations) === true);
});

test("a line the agent does not listen to marks nothing", async (t) => {
  const runtime = tradingRuntime();
  const { agent, chat } = agentFor(t, runtime, { listensTo: ["Steve"] });
  const relations = (agent as unknown as { relations: AgentRelations }).relations;
  relations.book.load([newRelation("Theo", Date.now(), 0)]);
  relations.asked(["Theo"], "4 coal", null, runtime.snapshot);
  await until(() => theoRequests(relations).length === 1);
  await sleep(5);
  runtime.inbox.push(fromTheo("got some coal?"));
  await sleep(80);
  assert.deepEqual([chat.requests.length, theoHeard(relations)], [0, false]);
});

test("a nameless line the chat tier leaves alone (route ignore) does not answer", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo([], "ignore"));
  runtime.inbox.push(fromTheo("hello all"));
  await until(() => chat.requests.length === 2);
  await sleep(60);
  assert.equal(theoHeard(relations), false);
});

test("a nameless line soon after its speaker named another character does not answer", async (t) => {
  const { runtime, relations, chat } = await askedTheoForCoal(t);
  chat.reply(readTo(["Vex"], "ignore"), readTo([]));
  runtime.inbox.push(fromTheo("Vex, do you have coal?"));
  await until(() => chat.requests.length === 2);
  runtime.inbox.push(fromTheo("ok then"));
  await until(() => chat.requests.length === 3);
  await sleep(60);
  assert.equal(theoHeard(relations), false);
});

/** Ayla (10 bread) with Theo `theoX` blocks away who said, a minute ago, that he needs bread; trading is the only activity she can draw. */
async function heardBreadNeed(t: Parameters<typeof agentFor>[0], theoX: number, talkRange?: number) {
  const runtime = tradingRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: theoX, y: 64, z: 0 } }] };
  runtime.durations.navigate = 5;
  const events: BrainEvent[] = [];
  const built = agentFor(t, runtime, { goal: "Forge an iron kit." }, talkOptions({ journal: (event) => events.push(event), otherAgents: others("Theo"), random: () => 0, ...(talkRange !== undefined && { localizedChat: { range: talkRange } }) }));
  const relations = (built.agent as unknown as { relations: AgentRelations }).relations;
  relations.book.load([withSaid(newRelation("Theo", Date.now(), 0), [], [{ item: "bread", count: 3 }], Date.now() - MIN)]);
  return { runtime, events, relations, ...built };
}

test("an objective drawn from a heard need opens a talk with that partner", async (t) => {
  const { planner, chat, agent } = await heardBreadNeed(t, 30);
  planner.reply({ objective: "offer Theo some bread", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "bread", length: "short", say: "Theo, I heard you need bread: want some?" });
  await until(() => planner.requests.length >= 1, 4_000);
  assert.match(JSON.stringify(planner.requests[0]), /Theo said 1 min ago they need bread; you carry 10: you could offer it for something you want/u);
  await until(() => agent.conversation?.kind === "social", 4_000);
  assert.match(JSON.stringify(chat.requests[0]), /offer them your bread: they said they need it/u);
});

test("a partner 50 blocks away keeps trading in the draw and is planned when talk carries 64", async (t) => {
  const { planner, chat, agent } = await heardBreadNeed(t, 50, 64);
  planner.reply({ objective: "offer Theo some bread", for: "trading" });
  chat.reply({ open: true, to: ["Theo"], topic: "bread", length: "short", say: "Theo, want some bread?" });
  await until(() => planner.requests.length >= 1, 4_000);
  assert.match(JSON.stringify(planner.requests[0]), /you could offer it for something you want/u, "in the draw at 50 blocks (seek reach 64)");
  await until(() => agent.conversation?.kind === "social", 4_000);
});

test("the seek reach never passes the talk range: without Localized Chat (staying distance 32) a partner 50 blocks away is not drawn", async (t) => {
  const { planner } = await heardBreadNeed(t, 50);
  planner.reply({ objective: "gather wood" });
  await until(() => planner.requests.length >= 1, 4_000);
  assert.doesNotMatch(JSON.stringify(planner.requests[0]), /you could offer it for something you want/u);
});

test("a partner beyond the seek reach is not drawn", async (t) => {
  const { planner } = await heardBreadNeed(t, 70, 64);
  planner.reply({ objective: "gather wood" });
  await until(() => planner.requests.length >= 1, 4_000);
  assert.doesNotMatch(JSON.stringify(planner.requests[0]), /you could offer it for something you want/u);
});

test("an order to trade from an agent 50 blocks away is still refused: the agreement reach stays 32 though the seek reach is 64", async (t) => {
  const { events, logs, agent, chat } = chatFromFarAgent(t, 50);
  chat.reply(ORDER);
  await agent.handle(say("Vex", "Ayla, come to me and trade iron"));
  await sleep(50);
  assert.deepEqual(takenObjectives(events), []);
  assert.ok(logs.some((line) => line.includes("Vex is too far away to trade with")), logs.join("\n"));
});
