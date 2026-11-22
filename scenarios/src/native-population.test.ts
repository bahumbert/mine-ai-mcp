import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createWaveTracker } from "./native-population.ts";

test("dead valid bodies do not delay replenishment and two deaths send only one wave", () => {
  const tracker = createWaveTracker(3);
  const entities = [
    { id: 1, name: "enderman", isValid: true },
    { id: 2, name: "enderman", isValid: true },
    { id: 3, name: "enderman", isValid: true },
    { id: 4, name: "piglin", isValid: true },
    { id: 5, name: "enderman", isValid: false },
  ];
  tracker.observeDeath(1);
  assert.equal(tracker.due(tracker.alive(entities, "enderman")), false);
  tracker.observeDeath(2);
  assert.equal(tracker.alive(entities, "enderman"), 1);
  assert.equal(tracker.due(1), true);
  tracker.observeDeath(3);
  assert.equal(tracker.due(0), false);
  tracker.observeSpawn(6);
  assert.equal(tracker.due(0), false);
  tracker.observeSpawn(6);
  assert.equal(tracker.pending, true);
  tracker.observeSpawn(7);
  tracker.observeSpawn(8);
  assert.equal(tracker.due(2), false);
  assert.equal(tracker.due(1), true);
  tracker.observeSpawn(6);
  tracker.observeSpawn(7);
  tracker.observeSpawn(8);
  assert.equal(tracker.pending, true);
});
