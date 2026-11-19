import assert from "node:assert/strict";
import test from "node:test";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createMemorySaveAction } from "../memory-save/index.js";
import { createMemoryForgetAction, parseMemoryForgetRequest } from "./index.js";

const place = { kind: "place", version: 1, data: { place: { name: "Home" } }, note: "Home." };

test("forgets own ids, reports others' and missing ids as not forgotten", async (t) => {
  using data = temporaryBotData({ botId: "Ayla" });
  const ayla = createMemorySaveAction(createFakeBot({ username: "Ayla" }).bot, data);
  const vex = createMemorySaveAction(createFakeBot({ username: "Vex" }).bot, data);
  const first = (await ayla.execute(ayla.parse(place), {})).memory.memoryId;
  const second = (await ayla.execute(ayla.parse(place), {})).memory.memoryId;
  const others = (await vex.execute(vex.parse(place), {})).memory.memoryId;
  const forget = createMemoryForgetAction(data, "Ayla");
  assert.equal(forget.execution.kind, "concurrent");

  const result = await forget.execute(forget.parse({ memory_ids: [first, others, 999, first] }), {});

  assert.deepEqual(result, { status: "succeeded", forgotten: [first], notForgotten: [others, 999] });
  forget.resultSchema.parse(result);
  assert.deepEqual(data.read("SELECT memory_id FROM memories ORDER BY memory_id").map((row) => row.memory_id), [second, others]);
});

test("memory_forget takes 1 to 500 positive integer ids", () => {
  for (const memory_ids of [[], [0], [1.5], ["1"], Array.from({ length: 501 }, (_, i) => i + 1)]) {
    assert.throws(() => parseMemoryForgetRequest({ memory_ids }));
  }
  assert.deepEqual(parseMemoryForgetRequest({ memory_ids: [3, 4] }), { memory_ids: [3, 4] });
});
