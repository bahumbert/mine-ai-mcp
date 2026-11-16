// Verify the flight verdict rejects missing survival and resumed-order evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { flightEvidence, flightVerdict } from "./evade-flight.ts";

const passing = { health: 7, outcome: "safe_separation", basis: "cover", distance: 12,
  healthAfter: 3, floor: { kind: "ok" }, receipts: [], status: "succeeded", interruptions: ["[HOSTILE_CONTACT] skeleton"] } as const;

test("judges first separation, floor, survival and resumed order independently", () => {
  const pursuit = { ...passing, basis: "range", distance: 38, status: "cancelled", health: 0 };
  const cases = [
    ["living resumed order", passing, ["cover"], 20, {}, true],
    ["below floor", { ...passing, floor: { kind: "below", index: 1, y: -62 } }, ["cover"], 20, {}, false],
    ["unknown floor", { ...passing, floor: { kind: "unknown", index: 0 } }, ["cover"], 20, {}, false],
    ["pursuit first evade", pursuit, ["range"], undefined, { judge: "evade" }, true],
    ["first evade fatal", { ...pursuit, healthAfter: 0 }, ["range"], undefined, { judge: "evade" }, false],
    ["held wrong basis", { ...pursuit, distance: 12 }, ["cover"], 36, { judge: "evade" }, false],
    ["missing basis", { ...passing, basis: undefined }, ["cover"], 20, {}, false],
    ["physical without basis", { ...passing, basis: undefined }, ["cover"], 20, { requireBasis: false }, true],
    ["physical too far", { ...passing, basis: undefined, distance: 44 }, ["cover"], 20, { requireBasis: false }, false],
    ...([
      ["dead actor", { health: 0 }], ["no separation", { outcome: "capability_limit" }],
      ["wrong basis", { basis: "range" }], ["cover too far", { distance: 20 }],
      ["order cancelled", { status: "cancelled" }], ["no hostile contact", { interruptions: [] }],
    ] as const).map(([name, changes]) => [name, { ...passing, ...changes }, ["cover"], 20, {}, false] as const),
  ] as const;
  for (const [name, evidence, bases, distance, options, expected] of cases)
    assert.equal(flightVerdict(evidence, bases, distance, options), expected, name);
});
test("reads every evade receipt in page order and rejects missing positions", () => {
  // Recorded t8-fixed-after receipt fields; the second endpoint reproduces the pit at lane z=512.
  const event = (healthAfter: number, y?: number) => ({ type: "survival_outcome", payload: {
    source: "hostile_reflex", evidence: { outcome: { response: "evade", outcome: "safe_separation", healthAfter,
      ...(y === undefined ? {} : { finalPosition: { x: 34.67839066305869, y, z: 512.5 } }),
      ends: [{ id: 50, name: "zombie", distance: 36.14250199118369, basis: "range" }] } } } });
  const options = { startY: -60, deaths: 1, status: "cancelled", interruptions: [] };
  const result = flightEvidence([event(3, -60), event(0, -62)], options);
  assert.equal(result.healthAfter, 3);
  assert.deepEqual(result.floor, { kind: "below", index: 1, y: -62 });
  assert.deepEqual(flightEvidence([event(3)], options).floor, { kind: "unknown", index: 0 });
  for (const [y, kind] of [[-60.499, "ok"], [-60.5, "ok"], [-60.501, "below"]] as const) {
    const floor = flightEvidence([event(3, -60), event(0, y)], options).floor;
    assert.equal(floor.kind, kind, `floor at ${y}`);
    if (floor.kind === "below") assert.equal(floor.index, 1);
  }
  const malformed = (position: unknown) => ({ type: "survival_outcome", payload: { source: "hostile_reflex",
    evidence: { outcome: { response: "evade", outcome: "safe_separation", healthAfter: 3, finalPosition: position } } } });
  for (const position of [null, { x: 0, y: null, z: 512 }, { x: 0, y: Infinity, z: 512 }]) {
    assert.deepEqual(flightEvidence([event(3, -60), malformed(position)], options).floor, { kind: "unknown", index: 1 });
    assert.deepEqual(flightEvidence([malformed(position), event(3, -60)], options).floor, { kind: "unknown", index: 0 });
  }
});
