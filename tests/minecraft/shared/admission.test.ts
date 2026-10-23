import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceAdmissionState,
  decideAdmission,
  EMPTY_TALLY,
  initialAdmissionState,
  noteAdmission,
  noteWallBoundHit,
  type AdmissionDecision,
  type AdmissionSample,
  type AdmissionState,
  type AdmissionTally,
  type ServerReading,
} from "./admission.ts";
import { loadScenarioServerConfig } from "./config.ts";

const config = loadScenarioServerConfig({});

function server(overrides: Partial<ServerReading> = {}): ServerReading {
  return { id: "s1", key: "k", status: "ready", shared: true, msptP95: 5, heapMb: 3_072, residentMb: 1_500, ...overrides };
}

function sample(overrides: Partial<AdmissionSample> = {}): AdmissionSample {
  return { at: 100_000, cpuBusy: 0.3, memAvailableMb: 20_000, threads: 24, servers: [server()], ownTrials: 3, youngClients: 0, ...overrides };
}

function ask(
  s: AdmissionSample,
  state: AdmissionState = initialAdmissionState(config),
  tally: AdmissionTally = EMPTY_TALLY,
  request = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb },
): AdmissionDecision {
  return decideAdmission({ sample: s, state, tally, request, config });
}

function refusedBound(decision: AdmissionDecision): string {
  assert.equal(decision.admit, false, "expected a refusal");
  return decision.admit ? "" : decision.bound;
}

test("every bound held: the trial takes a lane on the candidate server", () => {
  assert.deepEqual(ask(sample()), { admit: true, server: "s1", reserveMb: config.clientMemMb });
});

test("memory alone breached: the ledger cannot cover one more client", () => {
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 300 }))), "memory");
});

test("the ledger subtracts what servers still have to grow into and the clients still growing", () => {
  // 1500 resident of 3584 leaves 2084 still to come, plus the 2 young clients: exactly one more client fits at the line
  const base = sample({ youngClients: 2 });
  const line = 2_084 + 3 * config.clientMemMb;
  assert.equal(ask({ ...base, memAvailableMb: line }).admit, true);
  assert.equal(refusedBound(ask({ ...base, memAvailableMb: line - 1 })), "memory");
});

test("cpu alone breached with trials running: nothing new starts", () => {
  assert.equal(refusedBound(ask(sample({ cpuBusy: 0.9 }))), "cpu");
});

test("a lagging cpu reading of none (first sample) does not refuse", () => {
  assert.equal(ask(sample({ cpuBusy: null })).admit, true);
});

test("target alone breached: running trials reach the concurrency target", () => {
  assert.equal(refusedBound(ask(sample({ ownTrials: 10 }))), "target");
  assert.equal(refusedBound(ask(sample({ ownTrials: 9 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 0 })), "target");
});

test("candidate server over MSPT_ADMIT: refused naming the server tick time, a new server is the way out when memory allows", () => {
  const lagging = sample({ servers: [server({ msptP95: 26 })], memAvailableMb: 7_000 });
  const withoutRoom = ask({ ...lagging, memAvailableMb: 3_000 });
  assert.equal(refusedBound(withoutRoom), "server");
  assert.match(withoutRoom.admit ? "" : withoutRoom.detail, /s1.*26.*25/u);
  assert.deepEqual(ask(lagging), { admit: true, server: "new", reserveMb: config.clientMemMb + config.sharedHeapMb + config.serverMemMarginMb });
});

test("candidate server full: resident over RSS_FULL of heap + overhead takes no more lanes", () => {
  const full = sample({ servers: [server({ residentMb: 3_100 })], memAvailableMb: 2_000 });
  const decision = ask(full);
  assert.equal(refusedBound(decision), "server");
  assert.match(decision.admit ? "" : decision.detail, /resident/u);
});

test("a server still starting counts as a candidate with an unknown tick time", () => {
  assert.equal(ask(sample({ servers: [server({ status: "starting", msptP95: null, residentMb: 0 })], memAvailableMb: 9_000 })).admit, true);
});

test("a sick server takes nothing", () => {
  assert.equal(refusedBound(ask(sample({ servers: [server({ status: "sick" })], memAvailableMb: 3_000 }))), "server");
});

test("a new server needs the ledger to cover the client, its heap and the margin", () => {
  const request = { candidates: [], newServerHeapMb: config.sharedHeapMb };
  const need = config.clientMemMb + config.sharedHeapMb + config.serverMemMarginMb;
  assert.equal(ask(sample({ servers: [], memAvailableMb: need - 1 }), initialAdmissionState(config), EMPTY_TALLY, request).admit, false);
  assert.deepEqual(ask(sample({ servers: [], memAvailableMb: need }), initialAdmissionState(config), EMPTY_TALLY, request),
    { admit: true, server: "new", reserveMb: need });
});

test("at most one new server per sample", () => {
  const request = { candidates: [], newServerHeapMb: config.sharedHeapMb };
  const decision = ask(sample({ servers: [], memAvailableMb: 25_000 }), initialAdmissionState(config), { trials: 1, newServers: 1, reservedMb: 4_500 }, request);
  assert.equal(refusedBound(decision), "new-server-per-sample");
});

test("what this sample already admitted is subtracted from the ledger", () => {
  assert.equal(ask(sample({ memAvailableMb: 3_000, ownTrials: 1 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 0 }).admit, true);
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 3_000, ownTrials: 1 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 1_000 })), "memory");
});

test("no own trial running and the machine at 100% cpu from others: one is admitted, the second of the sample is not", () => {
  const busy = sample({ cpuBusy: 1, ownTrials: 0 });
  assert.equal(ask(busy).admit, true);
  assert.equal(refusedBound(ask(busy, initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 400 })), "cpu");
});

test("no own trial running: memory still decides", () => {
  assert.equal(refusedBound(ask(sample({ cpuBusy: 1, ownTrials: 0, memAvailableMb: 100 }))), "memory");
});

test("10 queued keys on a 30 GB sample start servers one per sample and stop where the ledger ends", () => {
  let servers: ServerReading[] = [];
  let ownTrials = 0;
  const state = initialAdmissionState(config);
  const started: number[] = [];
  let lastRefusal = "";
  for (let at = 0; at < 10; at++) {
    const current = sample({ at: at * 5_000, servers, ownTrials, youngClients: ownTrials, memAvailableMb: 30_000, cpuBusy: 0.2 });
    let tally = EMPTY_TALLY;
    for (let queued = 0; queued < 10; queued++) {
      const decision = decideAdmission({ sample: current, state, tally, config, request: { candidates: [], newServerHeapMb: config.sharedHeapMb } });
      if (!decision.admit) { lastRefusal = decision.bound; continue; }
      tally = { trials: tally.trials + 1, newServers: tally.newServers + 1, reservedMb: tally.reservedMb + decision.reserveMb };
      servers = [...servers, server({ id: `n${servers.length}`, key: `k${servers.length}`, status: "starting", residentMb: 0 })];
      ownTrials += 1;
    }
    started.push(tally.newServers);
  }
  assert.ok(started.every(count => count <= 1), `one new server per sample: ${started.join(",")}`);
  assert.equal(servers.length, 7, "(30000 - 3984 per server and client) leaves room for the 7th, not the 8th");
  assert.equal(lastRefusal, "memory");
});

test("a server over MSPT_STOP twice in a row backs off until three samples under MSPT_ADMIT, while another server still admits", () => {
  let state = initialAdmissionState(config);
  const lag = (at: number, p95: number) => sample({ at, servers: [server({ msptP95: p95 }), server({ id: "s2", msptP95: 4 })] });
  state = advanceAdmissionState(state, lag(0, 40), false, config);
  assert.equal(state.servers.s1?.backedOff ?? false, false, "once is not twice");
  state = advanceAdmissionState(state, lag(5_000, 40), false, config);
  assert.equal(state.servers.s1?.backedOff, true);
  const both = { candidates: ["s1", "s2"], newServerHeapMb: config.sharedHeapMb };
  assert.deepEqual(ask(lag(5_000, 10), state, EMPTY_TALLY, both), { admit: true, server: "s2", reserveMb: config.clientMemMb });
  assert.equal(refusedBound(ask({ ...lag(5_000, 10), memAvailableMb: 6_000 }, state, EMPTY_TALLY, { ...both, candidates: ["s1"] })), "server");
  for (const at of [10_000, 15_000]) state = advanceAdmissionState(state, lag(at, 10), false, config);
  assert.equal(state.servers.s1?.backedOff, true, "two good samples are not three");
  state = advanceAdmissionState(state, lag(20_000, 10), false, config);
  assert.equal(state.servers.s1?.backedOff, false);
});

test("a good sample between two bad ones resets the over-stop streak", () => {
  let state = initialAdmissionState(config);
  for (const [at, p95] of [[0, 40], [5_000, 10], [10_000, 40]] as const) {
    state = advanceAdmissionState(state, sample({ at, servers: [server({ msptP95: p95 })] }), false, config);
  }
  assert.equal(state.servers.s1?.backedOff ?? false, false);
});

test("a trial that hit its wall bound backs its server off at once", () => {
  const state = noteWallBoundHit(initialAdmissionState(config), "s1");
  assert.equal(state.servers.s1?.backedOff, true);
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 3_000 }), state)), "server");
});

test("a machine breach with trials running halves the target down to the floor of 1", () => {
  let state = initialAdmissionState(config);
  const seen: number[] = [];
  for (let at = 0; at < 6; at++) {
    state = advanceAdmissionState(state, sample({ at: at * 5_000, cpuBusy: 0.95 }), true, config);
    seen.push(state.target);
  }
  assert.deepEqual(seen, [5, 2, 1, 1, 1, 1]);
});

test("a full memory ledger caps the target at the trials running (capacity, not overload): it does not collapse to 1 sample after sample", () => {
  let state = initialAdmissionState(config);
  for (let at = 0; at < 4; at++) {
    state = advanceAdmissionState(state, sample({ at: at * 5_000, memAvailableMb: 700, ownTrials: 7, servers: [server({ residentMb: 3_000 })] }), true, config);
  }
  assert.equal(state.target, 7);
});

test("a breach with none of our trials running leaves the target alone (foreign load says nothing about ours)", () => {
  const state = advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 1, ownTrials: 0 }), true, config);
  assert.equal(state.target, config.targetStart);
});

test("the target grows by one only when demand waits and the last admission and breach are GROW_AFTER old", () => {
  let state: AdmissionState = { ...initialAdmissionState(config), target: 3 };
  state = noteAdmission(state, 100_000);
  const at = (ms: number) => sample({ at: 100_000 + ms, ownTrials: 3 });
  assert.equal(advanceAdmissionState(state, at(59_000), true, config).target, 3);
  assert.equal(advanceAdmissionState(state, at(60_000), false, config).target, 3, "nothing waits: no need to grow");
  state = advanceAdmissionState(state, at(60_000), true, config);
  assert.equal(state.target, 4);
  assert.equal(advanceAdmissionState(state, at(65_000), true, config).target, 4, "one step per GROW_AFTER");
  assert.equal(advanceAdmissionState(state, at(120_000), true, config).target, 5);
});

test("a cpu breach resets the growth clock: halve, then wait GROW_AFTER from the breach", () => {
  let state: AdmissionState = { ...initialAdmissionState(config), target: 8 };
  state = advanceAdmissionState(state, sample({ at: 10_000, cpuBusy: 0.95 }), true, config);
  assert.equal(state.target, 4);
  state = advanceAdmissionState(state, sample({ at: 15_000, cpuBusy: 0.3 }), true, config);
  assert.equal(state.target, 4);
  state = advanceAdmissionState(state, sample({ at: 70_000, cpuBusy: 0.3 }), true, config);
  assert.equal(state.target, 5);
});

test("a server lagging past MSPT_ADMIT also stops the growth", () => {
  const state: AdmissionState = { ...initialAdmissionState(config), target: 3 };
  const lagging = sample({ at: 200_000, servers: [server({ msptP95: 30 })] });
  assert.equal(advanceAdmissionState(state, lagging, true, config).target, 3);
});

test("the first sample only starts the growth clock: a target is never raised before it has held for GROW_AFTER", () => {
  const state = initialAdmissionState(config);
  const first = advanceAdmissionState(state, sample({ at: 1_000 }), true, config);
  assert.equal(first.target, config.targetStart);
  assert.equal(advanceAdmissionState(first, sample({ at: 1_000 + config.growAfterMs }), true, config).target, config.targetStart + 1);
});
