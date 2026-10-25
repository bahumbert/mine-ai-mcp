// The arrangement queue as an admission bound: a server whose queue would take over 5 s is skipped, the fallbacks when no server or memory is left.
import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_TALLY, initialAdmissionState, type AdmissionDecision, type AdmissionSample, type AdmissionRequest } from "./admission.ts";
import { config, MARGIN_MB, server, sample, ask, refusedBound } from "./admission-fixtures.ts";

/** A server whose queue holds `queued` trials at `holdMs` each. */
function queued(entries: Record<string, [queued: number, holdMs?: number]>): AdmissionRequest["queues"] {
  return new Map(Object.entries(entries).map(([id, [count, holdMs]]) => [id, { queued: count, holdMs: holdMs ?? config.arrangeHoldMs }]));
}

function asking(candidates: string[], queues: AdmissionRequest["queues"]): AdmissionRequest {
  return { candidates, newServerHeapMb: config.sharedHeapMb, queues };
}

const admittedOn = (decision: AdmissionDecision): string | null => (decision.admit ? decision.server : null);
const twoServers = (over: Partial<AdmissionSample> = {}) => sample({ servers: [server(), server({ id: "s2" })], memAvailableMb: 30_000, ...over });

test("6 trials queued at 800 ms take a 7th (the queue would be 5.6 s, over 5 s): refused, the next candidate gets it", () => {
  const request = asking(["s1", "s2"], queued({ s1: [6], s2: [0] }));
  assert.deepEqual(ask(twoServers(), initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s2", reserveMb: config.clientMemMb });
  assert.deepEqual(ask(twoServers(), initialAdmissionState(config), EMPTY_TALLY, asking(["s1", "s2"], queued({ s1: [5], s2: [0] }))),
    { admit: true, server: "s1", reserveMb: config.clientMemMb }, "5 queued: the 6th waits 4.8 s, under 5 s");
});

test("no candidate with room left: a new server, when memory allows", () => {
  const decision = ask(sample({ servers: [server()], memAvailableMb: 30_000 }), initialAdmissionState(config), EMPTY_TALLY, asking(["s1"], queued({ s1: [6] })));
  assert.deepEqual(decision, { admit: true, server: "new", reserveMb: config.clientMemMb + config.sharedHeapMb + config.serverMemMarginMb });
});

test("a measured hold of 300 ms takes 16 in the queue, 2 s takes 2", () => {
  const at = (count: number, holdMs: number) => admittedOn(ask(sample({ memAvailableMb: 30_000 }), initialAdmissionState(config), EMPTY_TALLY, asking(["s1"], queued({ s1: [count, holdMs] }))));
  assert.equal(at(15, 300), "s1", "16th: 16 x 300 = 4.8 s");
  assert.equal(at(16, 300), "new", "17th: 5.1 s");
  assert.equal(at(1, 2_000), "s1", "2nd: 4 s");
  assert.equal(at(2, 2_000), "new", "3rd: 6 s");
});

test("a new server refused for memory: the trial goes to the candidate with the shortest queue instead of waiting", () => {
  const poor = twoServers({ memAvailableMb: 5_000 + MARGIN_MB });
  const request = asking(["s1", "s2"], queued({ s1: [9], s2: [7] }));
  assert.deepEqual(ask(poor, initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s2", reserveMb: config.clientMemMb });
  const tied = asking(["s1", "s2"], queued({ s1: [7], s2: [7] }));
  assert.equal(admittedOn(ask(poor, initialAdmissionState(config), EMPTY_TALLY, tied)), "s1", "a tie keeps the first candidate");
});

test("a server of the key that is also lagging or backed off is not a queue-fallback candidate", () => {
  const lagging = twoServers({ servers: [server({ msptP95: 30 }), server({ id: "s2" })], memAvailableMb: 5_000 + MARGIN_MB });
  const request = asking(["s1", "s2"], queued({ s1: [0], s2: [9] }));
  assert.deepEqual(ask(lagging, initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s2", reserveMb: config.clientMemMb },
    "s1 has the shorter queue but its tick time refuses it");
});

test("a second new server in one sample is not started: the trial takes the shortest queue, the queue bound is a preference, not a reason to run fewer trials", () => {
  const request = asking(["s1", "s2"], queued({ s1: [8], s2: [6] }));
  const decision = ask(twoServers(), initialAdmissionState(config), { trials: 1, newServers: 1, reservedMb: 4_000 }, request);
  assert.deepEqual(decision, { admit: true, server: "s2", reserveMb: config.clientMemMb });
});

test("with no queue-full candidate the one-server-per-sample refusal stands, and it names the queue refusals it saw", () => {
  const decision = ask(sample({ memAvailableMb: 30_000, servers: [server({ status: "sick" })] }), initialAdmissionState(config), { trials: 1, newServers: 1, reservedMb: 4_000 }, asking(["s1"], queued({ s1: [6] })));
  assert.equal(refusedBound(decision), "new-server-per-sample");
});

test("a server without a queue entry counts as empty, and a queue-full server still takes the trial when nothing else can", () => {
  const request = asking(["s1"], queued({ s1: [6] }));
  const decision = ask(sample({ memAvailableMb: 3_000 + MARGIN_MB, servers: [server({ shared: true })] }), initialAdmissionState(config), EMPTY_TALLY, { ...request, queues: undefined });
  assert.equal(decision.admit, true, "no queue information: no queue bound");
  const noServerFits = ask(sample({ memAvailableMb: 3_000 + MARGIN_MB }), initialAdmissionState(config), EMPTY_TALLY, { ...request, candidates: ["s1", "s3"] });
  assert.equal(noServerFits.admit, true, "s1 queue-full, s3 not in the sample: the queue-full server still takes it");
});

test("a server of its own (not shared) has no lanes: its queue entry is never read", () => {
  const own = sample({ servers: [server({ shared: false })] });
  assert.equal(ask(own, initialAdmissionState(config), EMPTY_TALLY, asking(["s1"], queued({ s1: [50] }))).admit, true);
});
