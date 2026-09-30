import assert from "node:assert/strict";
import test from "node:test";
import { chatSystemPrompt, MAX_ACTION_STEPS } from "./llm-mind.ts";
import type { ChatInput, TaskInput } from "./mind.ts";
import { FakeRuntime, scriptedMind, testPersona } from "./testing.ts";

const signal = new AbortController().signal;

function chatInput(message: string, addressed = false): ChatInput {
  return {
    persona: testPersona(),
    message: { username: "Steve", channel: "chat", message, addressed },
    history: [],
    snapshot: new FakeRuntime().snapshot,
    activity: "idle",
  };
}

function taskInput(request: string): TaskInput {
  return { persona: testPersona(), request, requester: "Steve", snapshot: new FakeRuntime().snapshot, activity: "idle" };
}

test("the chat tier reads a fenced JSON reply as an answer plus a route", async () => {
  const { chat, mind } = scriptedMind();
  chat.reply("Sure!\n```json\n{\"say\":\"Right behind you!\",\"route\":\"act\",\"request\":\"follow Steve\"}\n```");
  const decision = await mind.chat(chatInput("yo Ayla stick with me", true), signal);
  assert.deepEqual(decision, { say: "Right behind you!", route: "act", request: "follow Steve" });
  assert.match(chat.requests[0]?.[1]?.content ?? "", /Steve says in chat, naming you: "yo Ayla stick with me"/u);
});

test("a request route without the restated request is repaired once", async () => {
  const { chat, mind } = scriptedMind();
  chat.reply({ say: "On it.", route: "act" }, { say: "On it.", route: "act", request: "collect 3 dirt" });
  assert.equal((await mind.chat(chatInput("grab me some dirt"), signal)).request, "collect 3 dirt");
  assert.equal(chat.requests[1]?.length, 4);
});

test("the action tier returns validated steps with defaults", async () => {
  const { action, mind } = scriptedMind();
  action.reply({ steps: [{ skill: "collect_block", block: "oak_log", count: 5 }, { skill: "give_item", player: "Steve", item: "oak_log", count: 5 }] });
  assert.deepEqual(await mind.resolve(taskInput("give Steve 5 oak_log"), signal), {
    kind: "steps",
    steps: [{ skill: "collect_block", block: "oak_log", count: 5 }, { skill: "give_item", player: "Steve", item: "oak_log", count: 5 }],
  });
});

test("a skill outside the catalog is rejected after the repair round", async () => {
  const { action, mind } = scriptedMind();
  const bad = { steps: [{ skill: "op_player", player: "Steve" }] };
  action.reply(bad, bad);
  await assert.rejects(mind.resolve(taskInput("op me"), signal), /LLM_BAD_REPLY/u);
});

test("a long action-tier answer is escalated to the planner", async () => {
  const { action, mind } = scriptedMind();
  action.reply({ steps: Array.from({ length: MAX_ACTION_STEPS + 1 }, () => ({ skill: "collect_block", block: "dirt" })) });
  assert.equal((await mind.resolve(taskInput("dig a lot"), signal)).kind, "escalate");
});

test("the planner may not follow before other steps", async () => {
  const { planner, mind } = scriptedMind();
  planner.reply(
    { steps: [{ skill: "follow_player", player: "Steve" }, { skill: "collect_block", block: "dirt" }] },
    { thought: "Dirt first.", steps: [{ skill: "collect_block", block: "dirt" }, { skill: "follow_player", player: "Steve" }] },
  );
  const plan = await mind.plan(taskInput("get dirt then follow me"), signal);
  assert.equal(plan.kind === "steps" && plan.steps.at(-1)?.skill, "follow_player");
  assert.match(planner.requests[1]?.[3]?.content ?? "", /only be the last step/u);
});

test("the chat prompt offers abilities only to stances that take requests", () => {
  assert.match(chatSystemPrompt(testPersona()), /you can: follow player/u);
  assert.match(chatSystemPrompt(testPersona({ stance: "rival" })), /never use the "act" or "plan" routes/u);
});
