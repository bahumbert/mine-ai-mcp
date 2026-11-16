// Per-threat reach decisions from observed positions and explicit game/monotonic times.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { judgeReach, ReachHistory, type ReachSample } from "./evade-reach.js";

type ReachInput = Parameters<typeof judgeReach>[0];

/** Three observations spanning the closing window, independent of a bot or real clock. */
function samplesOf(positions = [new Vec3(0, 64, 0), new Vec3(0, 64, 0), new Vec3(0, 64, 0)]): ReachSample[] {
  return positions.map((position, index) => ({ age: index * 20, atMs: index * 1_000, position }));
}

/** A freshly observed, stationary melee threat beyond the clear range. */
function reachInput(overrides: Partial<ReachInput> = {}): ReachInput {
  return {
    threat: { id: 7, name: "pursuer", attack: "melee", position: new Vec3(0, 64, 0), width: 0.6, height: 1.99 },
    dead: false,
    observed: true,
    distance: 17,
    samples: samplesOf(),
    botPosition: new Vec3(17, 64, 0),
    ageNow: 40,
    ageMovedAtMs: 2_000,
    staleAfterMs: 1_500,
    nowMs: 2_000,
    exposed: () => true,
    shotInWindow: false,
    policy: { evade_safe_range: 36, evade_clear_range: 16, evade_cover_range: 8 },
    ...overrides,
  };
}

test("a dead threat cannot reach, before considering range or exposure", () => {
  const verdict = judgeReach(reachInput({ dead: true, distance: 36, exposed: () => assert.fail("dead needs no ray") }));
  assert.deepEqual(verdict, { id: 7, name: "pursuer", distance: 36, basis: "dead", advancing: false });
});

test("a threat at the safe range cannot reach without a closing window", () => {
  const verdict = judgeReach(reachInput({ distance: 36, samples: [], exposed: () => assert.fail("range needs no ray") }));
  assert.equal(verdict.basis, "range");
  assert.equal(verdict.advancing, null);
});

test("a shooter hidden and still at the cover range cannot reach", () => {
  const input = reachInput();
  const threat = { ...input.threat, attack: "projectile" as const };
  for (const { distance, exposed, samples, basis } of [
    { distance: 9, exposed: false, samples: samplesOf(), basis: "cover" },
    { distance: 9, exposed: true, samples: samplesOf(), basis: null },
    { distance: 7, exposed: false, samples: samplesOf(), basis: null },
    { distance: 9, exposed: false, samples: samplesOf([new Vec3(0, 64, 0), new Vec3(2, 64, 0), new Vec3(4, 64, 0)]), basis: null },
    { distance: 8, exposed: false, samples: samplesOf(), basis: "cover" },
  ]) {
    assert.equal(judgeReach({ ...input, threat, distance, samples, exposed: () => exposed }).basis, basis);
  }
});

test("a melee threat that stopped following cannot reach beyond the clear range", () => {
  for (const [distance, basis] of [[17, "disengaged"], [16, "disengaged"], [15, null]] as const) {
    assert.equal(judgeReach(reachInput({ distance, exposed: () => assert.fail("melee needs no ray") })).basis, basis);
  }
});

test("an equal-speed pursuer at 17 blocks is advancing", () => {
  const verdict = judgeReach(reachInput({
    samples: samplesOf([new Vec3(0, 64, 0), new Vec3(4, 64, 0), new Vec3(8, 64, 0)]),
    botPosition: new Vec3(25, 64, 0),
  }));
  assert.equal(verdict.basis, null);
  assert.equal(verdict.advancing, true);
});

test("a threat walking sideways is not advancing", () => {
  const verdict = judgeReach(reachInput({
    samples: samplesOf([new Vec3(0, 64, 0), new Vec3(0, 64, 3), new Vec3(0, 64, 6)]),
  }));
  assert.equal(verdict.basis, "disengaged");
  assert.equal(verdict.advancing, false);
});

test("a shooter that shot in the window is not disengaged, but cover still protects", () => {
  const input = reachInput({ shotInWindow: true });
  const threat = { ...input.threat, attack: "projectile" as const };
  assert.equal(judgeReach({ ...input, threat }).basis, null);
  assert.equal(judgeReach({ ...input, threat, shotInWindow: false }).basis, "disengaged");
  assert.equal(judgeReach({ ...input, threat, exposed: () => false }).basis, "cover");
});

for (const observed of [false, true]) {
  test(observed ? "an unmodelled threat gets range or dead only" : "a threat no longer observed gets range or dead only", () => {
    const input = reachInput({ observed, distance: 20, exposed: () => assert.fail("no early basis needs no ray") });
    const threat = { ...input.threat, attack: observed ? "unmodelled" as const : "projectile" as const };
    assert.equal(judgeReach({ ...input, threat }).basis, null);
    assert.equal(judgeReach({ ...input, threat, distance: 36 }).basis, "range");
    assert.equal(judgeReach({ ...input, threat, dead: true }).basis, "dead");
  });
}

// The freshness limit is the caller's, measured from the server's own packet cadence: 30 ticks = 1 500 ms at 20 tps, 3 000 ms at 10, 4 500 backstop.
const FRESHNESS_LIMITS = [1_500, 3_000, 4_500] as const;

test("stale or incomplete world-age windows give no early basis, whatever the freshness limit", () => {
  const cases: readonly [string, Partial<ReachInput>, readonly number[]][] = [
    // At nowMs 2 000 an age that last moved at 0 is stale only for the 1 500 ms limit.
    ["a stall after a full window", { ageMovedAtMs: 0 }, [1_500]],
    ["a missing world age", { ageMovedAtMs: null }, FRESHNESS_LIMITS],
    ["an old newest sample", { ageNow: 60 }, FRESHNESS_LIMITS],
    ["fewer than three samples", { samples: [samplesOf()[0]!, samplesOf()[2]!] }, FRESHNESS_LIMITS],
    ["less than forty ticks", { samples: samplesOf().map((sample) => ({ ...sample, age: 20 + sample.age / 2 })) }, FRESHNESS_LIMITS],
  ];
  for (const [label, overrides, limits] of cases) for (const staleAfterMs of limits) {
    const verdict = judgeReach(reachInput({ ...overrides, staleAfterMs }));
    assert.equal(verdict.basis, null, `${label} at ${staleAfterMs}`);
    assert.equal(verdict.advancing, null, `${label} at ${staleAfterMs}`);
  }
});

for (const staleAfterMs of [1_500, 3_000]) {
  test(`the age freshness boundary is inclusive at ${staleAfterMs} ms, and so is the advance tolerance`, () => {
    // The age last moved exactly `staleAfterMs` before the judgement: fresh; one ms more: unknown.
    const nowMs = 10_000;
    const at = (agoMs: number, moved = 2) => judgeReach(reachInput({ staleAfterMs, nowMs, ageMovedAtMs: nowMs - agoMs,
      samples: samplesOf([new Vec3(0, 64, 0), new Vec3(moved / 2, 64, 0), new Vec3(moved, 64, 0)]) }));
    assert.equal(at(staleAfterMs - 1).advancing, true);
    assert.equal(at(staleAfterMs).advancing, true);
    assert.equal(at(staleAfterMs + 1).advancing, null);
    assert.equal(at(staleAfterMs + 1).basis, null);
    for (const [moved, basis, advancing] of [[1, "disengaged", false], [1.01, null, true]] as const) {
      const verdict = at(staleAfterMs, moved);
      assert.equal(verdict.basis, basis);
      assert.equal(verdict.advancing, advancing);
    }
  });
}

test("only movement within the closing window determines whether pursuit stopped", () => {
  const samples = [
    { age: 0, atMs: 0, position: new Vec3(0, 64, 0) },
    { age: 20, atMs: 1_000, position: new Vec3(8, 64, 0) },
    { age: 40, atMs: 2_000, position: new Vec3(8, 64, 0) },
    { age: 60, atMs: 3_000, position: new Vec3(8, 64, 0) },
  ];
  assert.equal(judgeReach(reachInput({ samples, ageNow: 60, ageMovedAtMs: 3_000, nowMs: 3_000 })).basis, "disengaged");
});

test("clear and cover ranges above the safe range use the safe range", () => {
  for (const attack of ["melee", "projectile"] as const) {
    const input = reachInput({ policy: { evade_safe_range: 36, evade_clear_range: 40, evade_cover_range: 40 }, exposed: () => false });
    const threat = { ...input.threat, attack };
    assert.equal(judgeReach({ ...input, threat, distance: 36.5 }).basis, "range");
    assert.equal(judgeReach({ ...input, threat, distance: 35 }).basis, null);
  }
});

test("a frozen world age never fills the closing window", () => {
  const history = new ReachHistory();
  for (const atMs of [0, 1_000, 2_000]) history.record(7, 0, atMs, new Vec3(0, 64, 0));
  assert.equal(history.samples(7).length, 1);
  const verdict = judgeReach(reachInput({ samples: history.samples(7), ageNow: 0, ageMovedAtMs: 0 }));
  assert.equal(verdict.basis, null);
  assert.equal(verdict.advancing, null);
});

test("samples older than two windows are dropped independently for each threat", () => {
  const history = new ReachHistory();
  history.record(8, 0, 0, new Vec3(0, 64, 0));
  for (let age = 0; age <= 200; age += 20) history.record(7, age, age * 50, new Vec3(0, 64, 0));
  assert.deepEqual(history.samples(7).map((sample) => sample.age), [120, 140, 160, 180, 200]);
  assert.equal(history.samples(8).length, 1);
});

test("history owns position snapshots and forgets only the specified threat", () => {
  const history = new ReachHistory();
  const position = new Vec3(0, 64, 0);
  history.record(7, 0, 0, position);
  position.x = 8;
  history.record(7, 20, 1_000, position);
  history.record(8, 0, 0, position);
  assert.equal(history.samples(7)[0]!.position.x, 0);
  history.forget(7);
  assert.deepEqual(history.samples(7), []);
  assert.equal(history.samples(8).length, 1);
});
