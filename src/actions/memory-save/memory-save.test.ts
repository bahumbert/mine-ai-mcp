import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../session/action-runner.js";
import { stubAction, started } from "../../session/action-runner-fixtures.test.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createMemorySaveAction, parseMemorySaveRequest } from "./index.js";

const farm = { kind: "farm", subject: "10,64,-3", version: 1, data: { farm: { crop: "wheat", size: 5 } }, note: "My wheat farm." };

function ayla() {
  return createFakeBot({ username: "Ayla", position: { x: 1.5, y: 64, z: -2.5 } }).bot;
}

test("saves a row with the bot's name, position and world age", async (t) => {
  const data = temporaryBotData({ botId: "Ayla", closeAfter: t });
  const bot = ayla();
  bot.time.age = 24_000;
  const save = createMemorySaveAction(bot, data);

  const result = await save.execute(save.parse(farm), {});
  save.resultSchema.parse(result);

  assert.equal(result.replaced, 0);
  assert.equal(result.memory.worldAgeTicks, 24_000);
  assert.deepEqual(data.read("SELECT world_age_ticks FROM memories"), [{ world_age_ticks: 24_000 }]);
  assert.equal(result.memory.botId, "Ayla");
  assert.equal(result.memory.dimension, "overworld");
  assert.deepEqual(result.memory.position, { x: 1.5, y: 64, z: -2.5 });
  assert.deepEqual(result.memory.data, { farm: { crop: "wheat", size: 5 } });
  assert.deepEqual(data.read("SELECT kind, subject, version, data_json, note FROM memories"), [
    { kind: "farm", subject: "10,64,-3", version: 1, data_json: '{"farm":{"crop":"wheat","size":5}}', note: "My wheat farm." },
  ]);
});

test("replace deletes this bot's older rows of the same kind and subject only", async (t) => {
  const data = temporaryBotData({ botId: "Ayla", closeAfter: t });
  const mine = createMemorySaveAction(ayla(), data);
  const other = createMemorySaveAction(createFakeBot({ username: "Vex" }).bot, data);
  await mine.execute(mine.parse(farm), {});
  await mine.execute(mine.parse(farm), {});
  await mine.execute(mine.parse({ ...farm, subject: "other centre" }), {});
  await mine.execute(mine.parse({ ...farm, kind: "place" }), {});
  await other.execute(other.parse(farm), {});

  const result = await mine.execute(mine.parse({ ...farm, replace: true }), {});

  assert.equal(result.replaced, 2);
  assert.deepEqual(
    data.read("SELECT bot_id, kind, subject FROM memories ORDER BY memory_id").map((row) => `${row.bot_id}|${row.kind}|${row.subject}`),
    ["Ayla|farm|other centre", "Ayla|place|10,64,-3", "Vex|farm|10,64,-3", "Ayla|farm|10,64,-3"],
  );
});

test("the request limits: kind spelling, data size, a note that says something, a version from 1, the subject defaulting to empty", () => {
  for (const kind of ["Farm", "my farm", "", "1farm", "a".repeat(65)]) {
    assert.throws(() => parseMemorySaveRequest({ ...farm, kind }), `kind ${JSON.stringify(kind)}`);
  }
  assert.equal(parseMemorySaveRequest({ ...farm, kind: "unfinished_house" }).kind, "unfinished_house");
  assert.throws(() => parseMemorySaveRequest({ ...farm, data: { text: "x".repeat(16 * 1024) } }), /16384|16 KiB/);
  assert.equal(parseMemorySaveRequest({ ...farm, data: { text: "x".repeat(16 * 1024 - 20) } }).replace, false);
  assert.throws(() => parseMemorySaveRequest({ ...farm, note: "  " }));
  assert.throws(() => parseMemorySaveRequest({ ...farm, version: 0 }));
  assert.equal(parseMemorySaveRequest({ kind: "place", version: 1, data: {}, note: "Home" }).subject, "");
});

test("runs beside a foreground task", async (t) => {
  const data = temporaryBotData({ botId: "Ayla", closeAfter: t });
  const runner = new ActionRunner();
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runs = { count: 0 };
  const foreground = runner.run(
    stubAction(async () => {
      runs.count += 1;
      await released;
      return { status: "succeeded" };
    }),
    { block_name: "stone" },
  );
  await started(runs, 1);

  const saved = await runner.run(createMemorySaveAction(ayla(), data), farm);

  assert.equal(saved.result.status, "succeeded");
  assert.equal(data.read("SELECT count(*) AS n FROM memories")[0]?.n, 1);
  assert.equal(runner.status().activeAction?.action, "stub", "the foreground task still owns the body");
  release();
  await foreground;
});
