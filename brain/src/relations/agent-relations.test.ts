import assert from "node:assert/strict";
import test from "node:test";
import type { Body } from "../body.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import { AgentRelations } from "./agent-relations.ts";

function relationsWithClock() {
  const runtime = new FakeRuntime();
  let statusCalls = 0;
  const status = runtime.status.bind(runtime);
  runtime.status = async () => { statusCalls += 1; return status(); };
  const clock = { now: () => time.at, sleep: async () => {} };
  const time = { at: 1_000_000 };
  const relations = new AgentRelations({
    persona: testPersona(), mind: scriptedMind().mind, runtime, body: {} as Body, takeHandoff: () => {}, modelSlotFree: () => true,
    inConversationWith: () => false, isAgent: () => false, lacks: () => [], journal: () => {}, log: () => {}, clock,
  });
  const look = async () => { relations.look(new Set(), new Set(), new AbortController().signal); await new Promise((r) => setTimeout(r, 5)); };
  return { relations, time, look, calls: () => statusCalls };
}

test("look() answers idle with nothing busy, busy_wait inside the throttle or while a tick runs, ticked otherwise", async () => {
  const { relations, time, look } = relationsWithClock();
  const signal = new AbortController().signal;
  assert.equal(relations.look(new Set(), new Set(), signal), "idle");
  relations.trades.heardLine("Theo", Date.now(), 2);
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "a tick is running");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(relations.look(new Set(), new Set(), signal), "busy_wait", "inside the watch throttle");
  time.at += 2_000;
  assert.equal(relations.look(new Set(), new Set(), signal), "ticked");
  await look();
  assert.equal(relations.look(new Set(), new Set(), AbortSignal.abort()), "idle", "aborted");
});

test("with only a window open look() polls status at most every 2 s", async () => {
  const { relations, time, look, calls } = relationsWithClock();
  relations.trades.heardLine("Theo", Date.now(), 2);
  await look();
  await look();
  assert.equal(calls(), 1, "a second look in the same instant does not poll");
  time.at += 1_999;
  await look();
  assert.equal(calls(), 1);
  time.at += 1;
  await look();
  assert.equal(calls(), 2);
});
