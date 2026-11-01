// A shared server with no tick sample yet takes a bounded number of lanes (T10): the P95 gate cannot hold back what it has not read.
import test from "node:test";
import assert from "node:assert/strict";
import { initialAdmissionState, EMPTY_TALLY } from "./admission.ts";
import { config, server, sample, ask, refusedBound } from "./admission-fixtures.ts";

const BOUND = config.freshServerLanes;
const fresh = (lanes: number) => sample({ servers: [server({ msptP95: null, lanes })] });

test("a fresh shared server takes lanes up to the bound, the next one waits for its first sample", () => {
  assert.equal(ask(fresh(BOUND - 1)).admit, true, "one lane below the bound");
  const decision = ask(fresh(BOUND));
  assert.equal(refusedBound(decision), "fresh-server");
  assert.match(decision.admit ? "" : decision.detail, new RegExp(`s1.*no tick sample.*${BOUND} lanes`, "u"));
});

test("the trial held for a fresh server waits for the sample: no second server starts for it, though memory allows one", () => {
  assert.equal(refusedBound(ask(sample({ servers: [server({ msptP95: null, lanes: BOUND })], memAvailableMb: 28_000 }))), "fresh-server");
});

test("a sample under MSPT_ADMIT lifts the bound", () => {
  const read = sample({ servers: [server({ msptP95: config.msptAdmitMs - 1, lanes: BOUND })] });
  assert.deepEqual(ask(read), { admit: true, server: "s1", reserveMb: config.clientMemMb });
});

test("a server of its own has no lane bound", () => {
  const own = sample({ servers: [server({ shared: false, msptP95: null, lanes: BOUND + 5 })] });
  assert.equal(ask(own).admit, true);
});

test("another candidate that fits takes the trial while the fresh one waits", () => {
  const two = sample({ servers: [server({ msptP95: null, lanes: BOUND }), server({ id: "s2", msptP95: 5, lanes: 3 })] });
  const decision = ask(two, initialAdmissionState(config), undefined, { candidates: ["s1", "s2"], newServerHeapMb: config.sharedHeapMb });
  assert.equal(decision.admit && decision.server, "s2");
});

test("a warm server refused only for its arrangement queue still takes the trial when the fresh one is at its bound and no new server fits", () => {
  const two = sample({ servers: [server({ msptP95: null, lanes: BOUND }), server({ id: "s2", msptP95: 5, lanes: 3 })], memAvailableMb: 6_168 });
  const queues = new Map([["s2", { queued: 10, holdMs: config.arrangeHoldMs }]]);
  const decision = ask(two, initialAdmissionState(config), EMPTY_TALLY, { candidates: ["s1", "s2"], queues, newServerHeapMb: config.sharedHeapMb });
  assert.equal(decision.admit && decision.server, "s2");
});
