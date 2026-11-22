// The legacy host reports absent or mismatching player updates before Mine Labs times out.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { prepareScenarioPlayer } from "./player-preparation.ts";

test("arrangement time is excluded, then missing player updates fail with diagnostics and release observers", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot } = createFakeBot({ username: "Actor", clock });
  const added = listenersAddedSince(bot);
  const controller = new AbortController();
  const arranged = Promise.withResolvers<void>();
  const scenario = scenarioDefinitionSchema.parse({ players: [{ name: "Actor", pos: [0, 0, 0] }], goal: { kind: "completion" } });
  let failure: unknown;
  const prepared = prepareScenarioPlayer(bot, { scenario, signal: controller.signal, ready() {}, arranged: arranged.promise }, { wallMs: 100 })
    .catch(cause => { failure = cause; });
  try {
    await clock.advance(200);
    assert.equal(failure, undefined);
    arranged.resolve();
    await clock.advance(0);
    await clock.advance(100);
    assert.match(String(failure), /not prepared within 0\.1 s.*arranged player.*position update: never seen/u);
    assert.equal(added("forcedMove"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    controller.abort(new Error("test finished"));
    await prepared;
  }
});
