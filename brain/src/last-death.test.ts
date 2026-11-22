// Tests of the one `lastDeath` shape the brain reads from `view_status` (plan 2026-11-07-p4-02c T2).
import assert from "node:assert/strict";
import test from "node:test";
import { parseLastDeath } from "./last-death.ts";

/** What `view_status` returns for a death (`src/actions/view-status/view-status.ts:75-80`): the position is already rounded. */
const RAW = { dimension: "overworld", position: { x: 10, y: 64, z: -3 }, observedAt: "2026-11-07T10:00:00.000Z", cause: "Zombie" };

test("a death seen 7.5 minutes after it happened is 7 minutes ago", () => {
  assert.deepEqual(parseLastDeath(RAW, "2026-11-07T10:07:30.000Z"), { ...RAW, minutesAgo: 7 });
});

test("a death dated after the situation (a stepped wall clock) is 0 minutes ago", () => {
  assert.equal(parseLastDeath(RAW, "2026-11-07T09:50:00.000Z")?.minutesAgo, 0);
});

test("a death with no combat message keeps its null cause", () => {
  assert.equal(parseLastDeath({ ...RAW, cause: null }, "2026-11-07T10:01:00.000Z")?.cause, null);
});

test("a situation with no date still gives the death, 0 minutes ago", () => {
  assert.equal(parseLastDeath(RAW, undefined)?.minutesAgo, 0);
});

test("a missing, null or malformed death is null", () => {
  const at = "2026-11-07T10:01:00.000Z";
  for (const raw of [undefined, null, "dead", 3, [], {}, { ...RAW, position: null }, { ...RAW, position: { x: 1, y: 2 } }, { ...RAW, dimension: 4 }, { ...RAW, observedAt: 12 }, { ...RAW, cause: 5 }]) {
    assert.equal(parseLastDeath(raw, at), null, JSON.stringify(raw));
  }
});

test("an unparsable date is null, the death's own or the situation's", () => {
  assert.equal(parseLastDeath({ ...RAW, observedAt: "yesterday" }, "2026-11-07T10:01:00.000Z"), null);
  assert.equal(parseLastDeath(RAW, "later"), null);
});
