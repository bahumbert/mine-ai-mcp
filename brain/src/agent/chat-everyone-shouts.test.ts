// Tests of chat lines to everyone (the nearest bot answers), shouts and whispers, distances heard, and the typing pause.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "../agent.ts";
import { HUMAN_TYPING, INSTANT_TYPING } from "../body.ts";
import { EveryoneLines } from "../everyone-lines.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import { FakeRuntime, scriptedMind, steppedClocks, testPersona, until } from "../testing.ts";
import { agentFor, floodSettings, journaledAgent, others, say, slowModel, steveAt } from "./agent-fixtures.test.ts";
import { tradingRuntime } from "./trade-fixtures.test.ts";

test("two bots claim an everyone line on its newest raw line", async (t) => {
  const everyone = new EveryoneLines();
  const greeting = { spoken_to: ["everyone"], asks: "", language: "English", say: "Hey!", route: "talk", request: "" };
  const bots = [["Ayla", 5, 8], ["Vex", 30, 1]].map(([name, at, burstMaxLines]) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, players: [steveAt(at as number)] };
    const built = agentFor(t, runtime, { id: String(name).toLowerCase(), username: String(name), settings: floodSettings(burstMaxLines as number) }, { everyone, otherAgents: others(...["Ayla", "Vex"].filter((other) => other !== name)) });
    built.chat.reply(greeting);
    slowModel(built.chat);
    return runtime;
  });
  await sleep(100); // the agents drain the chat from before they started first
  for (const runtime of bots) runtime.inbox.push(say("Steve", "hi", false), say("Steve", "everyone", false));
  await until(() => bots.some((runtime) => runtime.said.length > 0), 4_000);
  await sleep(300);
  assert.deepEqual(bots.map((runtime) => runtime.said), [["Hey!"], []], "one answer: the nearest bot's (the one that merged both lines), whatever each bot merged");
});

test("a reply that shouts is sent as a shout in public chat, and as a plain whisper to a whisperer", async (t) => {
  const runtime = new FakeRuntime();
  const tiers = scriptedMind({ range: 64 });
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0 });
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

/** Two agents (Ayla and Vex) sharing one record of the lines to everyone; each model reads the line as a greeting. */
function greetedBy(t: Parameters<typeof agentFor>[0], speakerAt: { ayla: number; vex: number }, line: ReturnType<typeof say> & { distance?: number }, hearers: { ayla: boolean; vex: boolean } = { ayla: true, vex: true }) {
  const everyone = new EveryoneLines();
  const greeting = { spoken_to: ["everyone"], asks: "", language: "English", say: "Hey!", route: "talk", request: "" };
  const make = (name: string, at: number, hears: boolean) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, players: [steveAt(at)] };
    const built = agentFor(t, runtime, { id: name.toLowerCase(), username: name }, { everyone, otherAgents: others(...["Ayla", "Vex"].filter((other) => other !== name)) });
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
    const built = agentFor(t, runtime, { id: String(name).toLowerCase(), username: String(name) }, { everyone, otherAgents: others(...["Ayla", "Vex"].filter((other) => other !== name)) });
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

test("A3: a shout with no server distance reaches the chat tier with the distance its speaker stands at", async (t) => {
  const runtime = tradingRuntime();
  const { x, y, z } = runtime.snapshot.position;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Lena", position: { x: x + 100, y, z: z + 21 } }] };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], asks: "", language: "English", say: "Hi!", route: "talk", request: "" });
  await agent.handle(say("Lena", "Ayla, anyone there?"));
  assert.match(chat.requests[0]?.at(-1)?.content ?? "", /from 121 blocks away/u);
});

test("A3: a whisper keeps its text as it was: it carries any distance, so none is added", async (t) => {
  const runtime = tradingRuntime();
  const { x, y, z } = runtime.snapshot.position;
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Lena", position: { x: x + 300, y, z } }] };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ spoken_to: ["Ayla"], asks: "", language: "English", say: "Hi!", route: "talk", request: "" });
  await agent.handle({ username: "Lena", channel: "whisper", message: "psst", addressed: true });
  assert.doesNotMatch(chat.requests[0]?.at(-1)?.content ?? "", /blocks away/u);
});

/** Steve is listed (tab list) without a position, as a player beyond the view distance is; the model's request for each line he sends. */
function farShouts(t: TestContext, lines: { at: number; line: ReturnType<typeof say> | { username: string; channel: "whisper"; message: string; addressed: boolean } }[]) {
  // No-position times are on the monotonic clock: the test moves it (and the wall clock with it).
  const clocks = steppedClocks(t);
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Steve", position: null }] };
  const { agent, chat } = agentFor(t, runtime);
  chat.reply({ say: "Hi.", route: "talk", request: "" }, { say: "Hi again.", route: "talk", request: "" });
  return { agent, chat, run: async () => {
    let now = 0;
    for (const { at, line } of lines) {
      clocks.monotonic(at - now);
      clocks.wall(at - now);
      now = at;
      await agent.handle(line);
    }
    return chat.requests.map((request) => request.at(-1)?.content ?? "");
  } };
}

test("a shout from a player listed with no position for 3 s is heard as from far away; the first sight of the gap is not", async (t) => {
  const { run } = farShouts(t, [{ at: 0, line: say("Steve", "Ayla, hello") }, { at: 3_000, line: say("Steve", "Ayla, hello?") }]);
  const [first, second] = await run();
  assert.doesNotMatch(first ?? "", /from far away/u, "listed with no position for under 3 s: a fresh login or teleport");
  assert.match(second ?? "", /Steve says in chat, naming you from far away: /u);
});

test("a whisper from a player listed with no position is not heard as from far away", async (t) => {
  const whisper = { username: "Steve", channel: "whisper" as const, message: "Ayla, psst", addressed: true };
  const { run } = farShouts(t, [{ at: 0, line: say("Steve", "Ayla, hello") }, { at: 3_000, line: whisper }]);
  const [, second] = await run();
  assert.doesNotMatch(second ?? "", /from far away/u);
});

test("a reply's typing pause counts from the read time, not from the start of the handling", async (t) => {
  // 2400 ms of typing (20 characters at 120 ms) and a 1500 ms burst window: the window already counted as typing, so only
  // about 900 ms are left once the model answered (spec 2026-11-18 D4); counted from the handling's start it was 2400.
  const runtime = new FakeRuntime();
  const { chat } = journaledAgent(t, runtime, { settings: { ...testPersona().settings, chatBurstMs: 1_500 } }, { typing: HUMAN_TYPING });
  let modelAnsweredAt = 0;
  let spokeAt = 0;
  const completeOnModel = chat.complete.bind(chat);
  chat.complete = async (...args) => {
    const reply = await completeOnModel(...args);
    modelAnsweredAt = monotonicNow();
    return reply;
  };
  const sayOnRuntime = runtime.say.bind(runtime);
  runtime.say = (...args) => {
    spokeAt = monotonicNow();
    return sayOnRuntime(...args);
  };
  chat.reply({ spoken_to: ["Ayla"], say: "twenty characters!!", route: "talk", request: "" });
  runtime.inbox.push(say("Steve", "Ayla, hello there"));
  await until(() => runtime.said.length === 1, 6_000);
  const gap = spokeAt - modelAnsweredAt;
  assert.ok(modelAnsweredAt > 0 && gap < 2_400 - 1_500 + 300, `the line was typed ${Math.round(gap)} ms after the model answered; the window counted already`);
});
