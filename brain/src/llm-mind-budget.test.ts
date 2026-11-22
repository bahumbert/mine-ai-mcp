import assert from "node:assert/strict";
import test from "node:test";
import type { ModelCall } from "./brain-log.ts";
import { chatParts, chatSystemPrompt, LlmMind, workSystemPrompt } from "./llm-mind.ts";
import { fitPrompt, PROMPT_BUDGET } from "./prompt-budget.ts";

import { SHRINK_ORDER, workParts } from "./prompt-parts.ts";
import { chatP50, goalP50, narrateWorst, workP50, workWorst } from "./prompt-fixtures.ts";
import { ScriptedModel } from "./testing.ts";

const signal = new AbortController().signal;
const done = { done: "ok" };

/** A mind over scripted models; `calls` collects what `onCall` hears (none when `logged` is false, as the bench). */
function mindOver(logged = true) {
  const models = { chat: new ScriptedModel("chat"), action: new ScriptedModel("action"), planner: new ScriptedModel("planner") };
  const calls: ModelCall[] = [];
  return { ...models, calls, mind: new LlmMind(models, logged ? (call) => calls.push(call) : undefined) };
}

/** Characters of the median work prompt as the first call sends it: system and user message. */
function workP50Characters(): number {
  const input = workP50();
  return workSystemPrompt(input.persona, false).length + fitPrompt("", workParts(input), SHRINK_ORDER.work, Number.POSITIVE_INFINITY, 3.4).text.length;
}

test("a model with no token count fits with 3.4 characters per token", async () => {
  const { action, mind } = mindOver(false);
  action.reply(done);
  const input = workWorst();
  assert.deepEqual(await mind.next(input, signal), { kind: "done", summary: "ok" });
  const sent = action.requests[0]?.[1]?.content ?? "";
  const expected = fitPrompt(workSystemPrompt(input.persona, true), workParts(input), SHRINK_ORDER.work, PROMPT_BUDGET.work, 3.4);
  assert.equal(sent, expected.text);
  assert.ok(expected.shrunk.length > 0, "the worst case does shrink: the fit is not a no-op");
});

test("characters per token are learnt from the model's own first replies, clamped to 2.5..4", async () => {
  const chars = workP50Characters();
  /** The estimate of the second call after the first reply came with these counts. */
  const secondEstimate = async (first: { promptTokens: number | null; contextTokens: number | null }, ...before: string[]) => {
    const { action, calls, mind } = mindOver();
    action.reply(...before).replyCounted(first, done).reply(done);
    await mind.next(workP50(), signal);
    await mind.next(workP50(), signal);
    return calls[1]?.budget;
  };
  // 5 characters per token is over the clamp: 4 is used.
  assert.equal((await secondEstimate({ promptTokens: Math.round(chars / 5), contextTokens: null }))?.estimated, Math.ceil(chars / 4));
  // 3.0 is inside it.
  const three = (await secondEstimate({ promptTokens: Math.round(chars / 3), contextTokens: null }))?.estimated ?? 0;
  assert.ok(Math.abs(three - chars / 3) <= 2, `${three} tokens for ${chars} characters`);
  // 1 character per token is under the clamp: 2.5 is used.
  assert.equal((await secondEstimate({ promptTokens: chars, contextTokens: null }))?.estimated, Math.ceil(chars / 2.5));
  // A count at 95 % of the window or more is Ollama's count after cutting the prompt: not a sample.
  const cut = await secondEstimate({ promptTokens: 15_600, contextTokens: 16_384 });
  assert.equal(cut?.estimated, Math.ceil(chars / 3.4));
  assert.equal(cut?.tokens, PROMPT_BUDGET.work);
  // The count of a repair round is not a sample: only the first reply of a call is read.
  const repaired = await secondEstimate({ promptTokens: 7_000, contextTokens: null }, "not json");
  assert.equal(repaired?.estimated, Math.ceil(chars / 3.4));
});

test("a small window cuts the budget and still sends", async () => {
  const smallest = mindOver();
  smallest.action.replyCounted({ promptTokens: null, contextTokens: 4_096 }, done).reply(done);
  await smallest.mind.next(workP50(), signal);
  await smallest.mind.next(workWorst(), signal);
  assert.equal(smallest.calls[0]?.budget?.tokens, PROMPT_BUDGET.work, "unknown window before the first answer: the table value");
  assert.equal(smallest.calls[1]?.budget?.tokens, 2_048);

  const tiny = mindOver();
  tiny.action.replyCounted({ promptTokens: null, contextTokens: 2_048 }, done).reply(done);
  await tiny.mind.next(workP50(), signal);
  const decision = await tiny.mind.next(workWorst(), signal);
  assert.equal(tiny.calls[1]?.budget?.tokens, 1_024);
  assert.equal(tiny.calls[1]?.budget?.overBudget, true);
  assert.deepEqual(decision, { kind: "done", summary: "ok" });
  assert.equal(tiny.action.requests.length, 2, "the call still went");
});

test("every model call logs its budget", async () => {
  const { action, chat, planner, calls, mind } = mindOver();
  action.reply(done);
  chat.reply({ spoken_to: "Ayla", route: "talk", say: "hi" }, { say: "" }, { lines: ["welcome"] });
  planner.reply({ objective: "Build." });
  await mind.next(workWorst(), signal);
  await mind.chat(chatP50(), signal);
  await mind.chooseObjective(goalP50(), signal);
  await mind.narrate(narrateWorst(), signal);
  await mind.signLines({ persona: narrateWorst().persona, occasion: "claim", owner: "Steve", what: "a house" }, signal);
  assert.equal(PROMPT_BUDGET.sign, 6000);
  assert.deepEqual(calls.map((call) => call.tier), ["work", "chat", "goal", "narrate", "sign"]);
  for (const call of calls) {
    assert.equal(call.budget?.tokens, PROMPT_BUDGET[call.tier]);
    assert.ok(Number.isInteger(call.budget?.estimated) && (call.budget?.estimated ?? 0) > 0, call.tier);
    assert.equal(typeof call.budget?.overBudget, "boolean");
  }
  assert.ok((calls[0]?.budget?.shrunk.length ?? 0) > 0, "the worst work prompt names what shrank");
  assert.deepEqual(calls[1]?.budget?.shrunk, []);
});

test("repair rounds resend the fitted text", async () => {
  const { action, calls, mind } = mindOver();
  action.reply("not json", done);
  await mind.next(workWorst(), signal);
  assert.ok((calls[0]?.budget?.shrunk.length ?? 0) > 0);
  assert.equal(action.requests[1]?.length, 4, "system, request, the bad reply, the repair request");
  assert.equal(action.requests[1]?.[1]?.content, action.requests[0]?.[1]?.content);
});

test("a call that fails is logged with its budget too", async () => {
  const { action, calls, mind } = mindOver();
  action.reply("nope", "still nope", "nope again");
  await assert.rejects(mind.next(workWorst(), signal), /\[LLM_BAD_REPLY\]/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0]?.error ?? "", /^\[LLM_BAD_REPLY\]/u);
  assert.equal(calls[0]?.budget?.tokens, PROMPT_BUDGET.work);
  assert.ok((calls[0]?.budget?.shrunk.length ?? 0) > 0);
});

test("the chat request is the chat parts fitted into the budget", async () => {
  const { chat, mind } = mindOver();
  chat.reply({ spoken_to: "Ayla", route: "talk", say: "hi" });
  const input = chatP50();
  await mind.chat(input, signal);
  const expected = fitPrompt(chatSystemPrompt(input.persona, true), chatParts(input, true), SHRINK_ORDER.chat, PROMPT_BUDGET.chat, 3.4);
  assert.equal(chat.requests[0]?.[1]?.content, expected.text);
});
