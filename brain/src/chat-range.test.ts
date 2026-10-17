import assert from "node:assert/strict";
import { test } from "node:test";
import { readLocalizedChat } from "./chat-range.ts";

const from = (values: Record<string, string>) => (name: string) => values[name];

test("localized chat is off unless MC_LOCALIZED_CHAT is true", () => {
  assert.equal(readLocalizedChat(from({})), undefined);
  assert.equal(readLocalizedChat(from({ MC_LOCALIZED_CHAT: "false", MC_CHAT_RANGE: "64" })), undefined);
});

test("localized chat reads the range and the shout cost, the range defaulting to 64", () => {
  assert.deepEqual(readLocalizedChat(from({ MC_LOCALIZED_CHAT: "true" })), { range: 64 });
  assert.deepEqual(readLocalizedChat(from({ MC_LOCALIZED_CHAT: "true", MC_CHAT_RANGE: "100", MC_SHOUT_FOOD_COST: "2" })), { range: 100, foodCost: 2 });
});
