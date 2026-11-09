import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createFakeBot, createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { changesObserved, releaseByTag } from "./arranged-release.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

function fixture(signal = new AbortController().signal) {
  const { bot } = createFakeBot({ entities: {
    2: { name: "enderman", position: { x: 0, y: 64, z: 0 } },
    3: { name: "enderman", position: { x: 2, y: 64, z: 0 } },
  }, overrides: { chat: () => {} } });
  const client = bot._client;
  // W3 trial: mob_flags index 15 and release metadata, scenario-timing-pitfalls.md.
  const context = { bot, signal, log: () => {} } as unknown as MineAiScenarioContext;
  const answer = (id: number, flags: number) => client.emit("entity_metadata", { entityId: id, metadata: [{ key: 15, value: flags }] });
  return { context, client, answer };
}

test("tag release binds the sole cleared mob flags answer and ignores unchanged flags", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { context, client, answer } = fixture();
  const result = releaseByTag(context, "primary", "enderman");
  answer(3, 1);
  answer(2, 0);
  await clock.advance(1_100);
  assert.equal(await result, 2);
  assert.equal(client.listenerCount("entity_metadata"), 0);
});

test("tag release rejects missing or ambiguous answers and cleans up", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  for (const ambiguous of [false, true]) {
    const { context, client, answer } = fixture();
    const result = releaseByTag(context, "primary", "enderman");
    const rejection = assert.rejects(result, ambiguous ? /ambiguous/ : /not answered/);
    if (ambiguous) { answer(2, 0); answer(3, 0); } else await clock.advance(1_100);
    await rejection;
    assert.equal(client.listenerCount("entity_metadata"), 0);
  }
});

test("tag release propagates cancellation before and during the wait", async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    if (before) controller.abort(reason);
    const { context, client } = fixture(controller.signal);
    const result = releaseByTag(context, "primary", "enderman");
    if (!before) controller.abort(reason);
    await assert.rejects(result, reason);
    assert.equal(client.listenerCount("entity_metadata"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
});

test("target changes are an ordered subsequence independent of diagnostic reasons", () => {
  const changes = [
    { fromTargetId: 1, toTargetId: 2, reason: "Target priority changed" },
    { fromTargetId: 2, toTargetId: 9, reason: "shield preparation" },
    { fromTargetId: 2, toTargetId: 1, reason: "Target priority changed" },
  ];
  const ids = { primary: 1, alternative: 2 };
  assert.equal(changesObserved(changes, [["primary", "alternative"], ["alternative", "primary"]], ids), true);
  assert.equal(changesObserved(changes, [["alternative", "primary"], ["primary", "alternative"]], ids), false);
  assert.equal(changesObserved(changes.slice(0, 2), [["primary", "alternative"], ["alternative", "primary"]], ids), false);
});
