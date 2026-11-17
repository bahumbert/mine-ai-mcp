import assert from "node:assert/strict";
import test from "node:test";
import { assessBowWindow } from "./bow-window.js";
import type { observeProjectileDefence } from "./shield-facing.js";

function forecast(ticks: number | null, name = "arrow", id = 7) {
  return { projectiles: [{ entity: { id, name }, impactInTicks: ticks }],
    windupForecasts: [], holdRemainingTicks: 0 } as unknown as NonNullable<ReturnType<typeof observeProjectileDefence>>;
}

test("a shooting window includes shield readiness, turning and margin after release", () => {
  assert.equal(assessBowWindow(forecast(30), 20).safe, false);
  assert.equal(assessBowWindow(forecast(31), 20).safe, true);
  assert.equal(assessBowWindow(forecast(10), 0).safe, false);
  assert.equal(assessBowWindow(forecast(11), 0).safe, true);
});

test("bow vetoes retain the responsible timing and threat through mixed contacts and disappearance", () => {
  const unknown = forecast(null, "fireball");
  const mixed = forecast(50);
  mixed.projectiles.push(forecast(null, "fireball", 8).projectiles[0]!);
  const known = forecast(50);
  known.windupForecasts.push({ entity: { id: 8 }, impactInTicks: 4, releaseInTicks: 0 } as typeof known.windupForecasts[number]);
  const windup = { ...unknown, projectiles: [], windupForecasts: [
    { entity: { id: 9 }, releaseInTicks: null, impactInTicks: null } as typeof unknown.windupForecasts[number],
  ] };
  for (const { defence, uncertain = false, safe = false, reason, ticks, id } of [
    { defence: known, reason: "predicted_impact", ticks: 4, id: 8 },
    { defence: forecast(null, "small_fireball"), reason: "unknown_impact", ticks: null, id: 7 },
    { defence: unknown, reason: "unknown_impact", ticks: null, id: 7 },
    { defence: mixed, reason: "unknown_impact", ticks: null, id: 8 },
    { defence: windup, reason: "unknown_impact", ticks: null, id: 9 },
    { defence: { ...forecast(50), holdRemainingTicks: 1 }, reason: "held_impact", ticks: 50, id: 7 },
    { defence: { ...unknown, holdRemainingTicks: 1 }, reason: "held_impact", ticks: null, id: 7 },
    { defence: unknown, uncertain: true, reason: "uncertain_volley", ticks: null, id: 7 },
    { defence: null, uncertain: true, reason: "uncertain_volley", ticks: null, id: null },
    { defence: null, safe: true, reason: "clear", ticks: null, id: null },
  ]) {
    assert.deepEqual(assessBowWindow(defence, 0, uncertain), { safe, requiredTicks: 10,
      impactInTicks: ticks, threatId: id, reason });
  }
});
