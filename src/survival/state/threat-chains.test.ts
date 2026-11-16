// Response chains retain observed distances and elapsed time across nearby responses.
import assert from "node:assert/strict";
import test from "node:test";
import type { HostileSettlement } from "../control/combat/response-result.js";
import { chainSuffix, ThreatChains } from "./threat-chains.js";

/** A settled response with explicit observations, independent of the bot and its clock. */
function entry(startedAtMs: number, endedAtMs: number, ids = [12], response: "fight" | "evade" = "evade") {
  const settlement: HostileSettlement = {
    response, kind: "cancelled", reason: "Stopped by caller.", physical: null, chain: null,
    evidence: {
      reason: "hurt", threats: ids.map((id) => ({ id, name: "zombie", distance: 4, position: { x: 4, y: 64, z: 0 } })),
      healthBefore: 10, healthAfter: 10, finalPosition: { x: 0, y: 64, z: 0 },
      finalDistances: ids.map((id) => ({ id, distance: 16 })), killedTargetIds: [], attacks: 0,
      combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
    },
  };
  return { generation: 0, startedAtMs, endedAtMs, settlement, firstDistances: new Map(ids.map((id) => [id, 4])) };
}

test("a second response 60 s after the first one's end is a chain of 2", () => {
  for (const [start, responses] of [[75_000, 2], [75_001, null]] as const) {
    const chains = new ThreatChains();
    assert.equal(chains.record(entry(0, 15_000)), null);
    const next = entry(start, start + 1_000, [12], "fight");
    next.firstDistances.set(12, 10);
    const result = chains.record(next);
    assert.equal(result?.responses ?? null, responses);
    if (result) assert.deepEqual(result, { threatId: 12, name: "zombie", responses: 2, evades: 1, seconds: 76, gained: 12 });
  }
});

test("a long first response counts in the chain's seconds", () => {
  for (const [endedAtMs, seconds] of [[120_000, 120], [120_500, 121]] as const) {
    const chains = new ThreatChains();
    chains.record(entry(0, 15_000));
    assert.equal(chains.record(entry(50_000, endedAtMs))?.seconds, seconds);
  }
});

test("the longest chain among the threats is reported", () => {
  const chains = new ThreatChains();
  chains.record(entry(0, 1_000, [12]));
  chains.record(entry(2_000, 3_000, [12, 13]));
  assert.deepEqual(chains.record(entry(4_000, 5_000, [13, 12])), {
    threatId: 12, name: "zombie", responses: 3, evades: 3, seconds: 5, gained: 12,
  });
});

test("a record from an old generation is dropped", () => {
  const chains = new ThreatChains();
  chains.record(entry(0, 1_000));
  const old = entry(2_000, 3_000);
  old.generation = chains.generation;
  chains.clear();
  assert.equal(chains.record(old), null);
  assert.equal(chains.record({ ...entry(4_000, 5_000), generation: chains.generation }), null);
  assert.equal(chains.record({ ...entry(6_000, 7_000), generation: chains.generation })?.responses, 2);
});

test("chain suffix uses English ordinals including the teen exceptions", () => {
  for (const [responses, ordinal] of [[2, "2nd"], [3, "3rd"], [4, "4th"], [11, "11th"], [12, "12th"],
    [13, "13th"], [21, "21st"], [22, "22nd"], [23, "23rd"], [111, "111th"]] as const) {
    assert.equal(chainSuffix({ threatId: 12, name: "zombie", responses, evades: 2, seconds: 41, gained: 12 }),
      `; ${ordinal} response to zombie#12 in 41 s, 2 evades, gained 12.0 blocks overall`);
  }
});
