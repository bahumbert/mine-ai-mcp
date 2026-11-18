import assert from "node:assert/strict";
import test from "node:test";
import { tierCall } from "./model-lanes.ts";

test("tierCall maps every tier: the chat tier by who spoke and whether to the bot, the rest to the shared lane", () => {
  assert.deepEqual(tierCall("chat", { fromAgent: false, addressed: true }), { lane: "chat", priority: 0 });
  assert.deepEqual(tierCall("chat", { fromAgent: false, addressed: false }), { lane: "chat", priority: 1 });
  assert.deepEqual(tierCall("chat", { fromAgent: true, addressed: true }), { lane: "shared", priority: 2 });
  assert.deepEqual(tierCall("chat", { fromAgent: true, addressed: false }), { lane: "shared", priority: 2 });
  assert.deepEqual(tierCall("chat"), { lane: "chat", priority: 0 }, "no line facts: as a person's addressed line");
  assert.deepEqual(tierCall("conversation"), { lane: "shared", priority: 3 });
  assert.deepEqual(tierCall("narrate"), { lane: "shared", priority: 3 });
  assert.deepEqual(tierCall("goal"), { lane: "shared", priority: 4 });
  assert.deepEqual(tierCall("work"), { lane: "shared", priority: 4 });
});
