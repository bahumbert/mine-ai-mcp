import assert from "node:assert/strict";
import test from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { SqlBotData } from "../bot-data/index.js";
import type { NavigationEvent } from "../navigation/index.js";
import { captureStderr } from "../test-support/stderr.js";
import { observeNavigationEvents } from "./navigation-events.js";

test("a search that opened the bot's own regions is recorded once, with where it started", (t) => {
  const listeners = new Set<(event: NavigationEvent) => void>();
  const navigation = { onEvent: (listener: (event: NavigationEvent) => void) => (listeners.add(listener), () => listeners.delete(listener)) };
  const data = SqlBotData.create({ storage: { kind: "temporary" }, identity: { worldId: "navigation-events", scope: { kind: "bot", botId: "Theo" } } });
  const stop = observeNavigationEvents(navigation, "Theo", data);
  t.after(() => { stop(); data.close(); });
  const emit = (event: NavigationEvent) => listeners.forEach((listener) => listener(event));

  emit({ kind: "goal_arrived", runId: "r1", result: "completed", atMs: 1 });
  assert.equal(readRecentEvents(data, "Theo", 50).events.length, 0, "other navigation events are not recorded");
  emit({ kind: "own_regions_opened", runId: "r1", atMs: 2, start: { x: 10, y: 64, z: -3 } });

  const [event] = readRecentEvents(data, "Theo", 50).events;
  assert.equal(event?.type, "navigation_own_regions_opened");
  assert.match(event?.summary ?? "", /own protected regions.*10 64 -3/u);
  assert.deepEqual(event?.payload, { runId: "r1", start: { x: 10, y: 64, z: -3 } });
  stop();
  assert.equal(listeners.size, 0);
});

test("an own_regions_opened event with a failing write does not throw", (t) => {
  const listeners = new Set<(event: NavigationEvent) => void>();
  const navigation = { onEvent: (listener: (event: NavigationEvent) => void) => (listeners.add(listener), () => listeners.delete(listener)) };
  const data = SqlBotData.create({ storage: { kind: "temporary" }, identity: { worldId: "navigation-events-failing", scope: { kind: "bot", botId: "Theo" } } });
  const stderr = captureStderr(t);
  const stop = observeNavigationEvents(navigation, "Theo", data);
  t.after(() => { stop(); data.close(); });
  t.mock.method(data, "transaction", () => { throw new Error("database or disk is full"); });

  assert.doesNotThrow(() => listeners.forEach((listener) => listener({ kind: "own_regions_opened", runId: "r1", atMs: 2, start: { x: 10, y: 64, z: -3 } })));
  assert.deepEqual(stderr, ["[navigation-events] database or disk is full\n"]);
});
