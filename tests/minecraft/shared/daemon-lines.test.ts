import test from "node:test";
import assert from "node:assert/strict";
import { sampleLine, trialLine, type SampleReport } from "./daemon-lines.ts";

const phases = { mutexWaitMs: 120, arrangeMs: 450, joinMs: 5_100, trialMs: 12_000, restoreWaitMs: 30, restoreMs: 350 };

test("a trial line names the trial, its lane and server, the waits before it started, the six phases in order and the hold", () => {
  assert.equal(
    trialLine({ name: "air-supply", lane: 3, serverId: "s2", queueMs: 14_000, serverWaitMs: 0, phases, holdMs: 19_800 }),
    "trial air-supply lane 3 server s2 queue=14000 serverWait=0 mutexWait=120 arrange=450 join=5100 trial=12000 restoreWait=30 restore=350 hold=19800",
  );
});

test("a trial on a server of its own has lane own", () => {
  assert.match(trialLine({ name: "n", lane: null, serverId: "s9", queueMs: 0, serverWaitMs: 7_800, phases, holdMs: 1 }), /^trial n lane own server s9 queue=0 serverWait=7800 /u);
});

test("a trial that never ran (its server did not start) says its phases are none", () => {
  assert.equal(
    trialLine({ name: "f", lane: 1, serverId: "s4", queueMs: 5_000, serverWaitMs: 40, phases: undefined, holdMs: 40 }),
    "trial f lane 1 server s4 queue=5000 serverWait=40 phases=none hold=40",
  );
});

const report: SampleReport = {
  cpuBusy: 0.634, ownCpu: 0.5, load1: 11.256, memAvailableMb: 18_204, ledgerMb: 9_871, target: 28, running: 24, queued: 28, servers: 3, starts: 5,
  held: { target: 4, "new-server-per-sample": 2 }, event: null,
};

test("a sample line keeps today's text and adds cpu, own, load1, mem, ledger, target, counts, starts and the trials held per bound", () => {
  assert.equal(
    sampleLine(report, [4.5, null, 11]),
    "sample: 24 running, 28 queued, cpu 63%, 3 servers, p95 ms 4.5/-/11 | cpu=63% own=50% load1=11.26 mem=18204 ledger=9871 target=28 running=24 queued=28 servers=3 starts=5 held=target:4,new-server-per-sample:2",
  );
});

test("a sample line with nothing read yet shows dashes, and no held trials shows held=none", () => {
  const blank: SampleReport = { ...report, cpuBusy: null, ownCpu: null, load1: null, held: {} };
  assert.equal(
    sampleLine(blank, []),
    "sample: 24 running, 28 queued, cpu -, 3 servers, p95 ms  | cpu=- own=- load1=- mem=18204 ledger=9871 target=28 running=24 queued=28 servers=3 starts=5 held=none",
  );
});

test("a target change of the sample is said at the end of the line", () => {
  assert.match(sampleLine({ ...report, event: "foreign load" }, []), / held=target:4,new-server-per-sample:2 target change: foreign load$/u);
  assert.match(sampleLine({ ...report, event: "grew" }, []), / target change: grew$/u);
});

test("a trial that asked for a client has its settle phase between arrange and join", () => {
  assert.equal(
    trialLine({ name: "air-supply", lane: 3, serverId: "s2", queueMs: 14_000, serverWaitMs: 0, phases: { ...phases, settleMs: 1_500, joinMs: 3_600 }, holdMs: 19_800 }),
    "trial air-supply lane 3 server s2 queue=14000 serverWait=0 mutexWait=120 arrange=450 settle=1500 join=3600 trial=12000 restoreWait=30 restore=350 hold=19800",
  );
});
