import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceAdmissionState,
  decideAdmission,
  EMPTY_TALLY,
  initialAdmissionState,
  ledgerMb,
  noteWallBoundHit,
  type AdmissionDecision,
  type AdmissionSample,
  type AdmissionState,
  type AdmissionTally,
  type AdmissionRequest,
  type ServerReading,
} from "./admission.ts";
import { loadScenarioServerConfig } from "./config.ts";

const config = loadScenarioServerConfig({});

function server(overrides: Partial<ServerReading> = {}): ServerReading {
  return { id: "s1", key: "k", status: "ready", shared: true, busy: true, msptP95: 5, heapMb: 3_072, residentMb: 1_500, ...overrides };
}

function sample(overrides: Partial<AdmissionSample> = {}): AdmissionSample {
  return { at: 100_000, cpuBusy: 0.3, memAvailableMb: 20_000, threads: 24, servers: [server()], ownTrials: 3, youngClients: 0, ...overrides };
}

function ask(
  s: AdmissionSample,
  state: AdmissionState = initialAdmissionState(config),
  tally: AdmissionTally = EMPTY_TALLY,
  request: AdmissionRequest = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb },
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

// A 2048 MB heap with 512 MB of overhead and 900 MB resident has 1660 MB still to come when it works.
const WARM = { heapMb: 2_048, residentMb: 900 } as const;
const GROWTH_MB = 1_660;
const warm = (overrides: Partial<ServerReading> = {}) => server({ ...WARM, ...overrides });

test("the ledger reserves growth only for busy servers: starting, working or holding the mutex reserve it, an idle warm one, a gone one and a server gone from the sample reserve nothing", () => {
  const ledgerWith = (...servers: ServerReading[]) => ledgerMb(sample({ memAvailableMb: 10_000, servers }), EMPTY_TALLY, config);
  assert.equal(WARM.heapMb + config.serverOverheadMb - WARM.residentMb, GROWTH_MB);
  assert.equal(ledgerWith(warm({ busy: false })), 10_000, "idle");
  assert.equal(ledgerWith(warm({ busy: true })), 10_000 - GROWTH_MB, "a trial running, or a restore clone holding it");
  assert.equal(ledgerWith(warm({ status: "starting", msptP95: null, residentMb: 0, busy: true })), 10_000 - WARM.heapMb - config.serverOverheadMb, "starting");
  assert.equal(ledgerWith(warm({ id: "a", busy: true }), warm({ id: "b", busy: false }), warm({ id: "c", busy: true })), 10_000 - 2 * GROWTH_MB, "only the busy ones are summed");
  assert.deepEqual([warm({ busy: true }), warm({ busy: false })].map(each => ledgerWith(each)), [8_340, 10_000], "goes idle between two samples");
  assert.equal(ledgerWith(), 10_000, "a server that died is no longer in the sample");
});

test("a trial reserves its client and, on an idle server, the growth it wakes (a single server the same way); on a busy server only the client", () => {
  const reserve = (candidate: ServerReading) => ask(sample({ memAvailableMb: 10_000, ownTrials: 0, servers: [candidate] }));
  assert.deepEqual(reserve(warm({ busy: false })), { admit: true, server: "s1", reserveMb: config.clientMemMb + GROWTH_MB });
  assert.deepEqual(reserve(warm({ busy: true })), { admit: true, server: "s1", reserveMb: config.clientMemMb });
  assert.deepEqual(reserve(warm({ shared: false, busy: false })), { admit: true, server: "s1", reserveMb: config.clientMemMb + GROWTH_MB });
});

test("an idle warm server is refused for memory when the ledger covers its client but not the growth the trial wakes", () => {
  const line = config.clientMemMb + GROWTH_MB;
  const idle = (memAvailableMb: number, tally: AdmissionTally = EMPTY_TALLY) =>
    ask(sample({ memAvailableMb, ownTrials: 1, servers: [warm({ busy: false })] }), initialAdmissionState(config), tally);
  assert.equal(idle(line).admit, true);
  const short = idle(line - 1);
  assert.equal(refusedBound(short), "memory");
  assert.match(short.admit ? "" : short.detail, /s1.*1660/u);
  assert.equal(refusedBound(idle(line - 1, { trials: 1, newServers: 1, reservedMb: 0 })), "memory", "still a memory refusal once the sample's one new server has started");
});

test("a busy candidate takes the trial when the idle one cannot be afforded", () => {
  const both = sample({
    memAvailableMb: 3_000, ownTrials: 1,
    servers: [warm({ id: "idle", busy: false }), warm({ id: "busy", busy: true })],
  });
  // the busy one reserves 1660 in the ledger (1340 left, one client fits); the idle one would need 250 + 1660 more
  assert.deepEqual(ask(both, initialAdmissionState(config), EMPTY_TALLY, { candidates: ["idle", "busy"], newServerHeapMb: config.sharedHeapMb }),
    { admit: true, server: "busy", reserveMb: config.clientMemMb });
});

test("cpu alone breached with trials running: nothing new starts", () => {
  assert.equal(refusedBound(ask(sample({ cpuBusy: 0.9 }))), "cpu");
});

test("a lagging cpu reading of none (first sample) does not refuse", () => {
  assert.equal(ask(sample({ cpuBusy: null })).admit, true);
});

test("target alone breached: running trials reach the concurrency target", () => {
  const target = config.targetStart;
  assert.equal(refusedBound(ask(sample({ ownTrials: target }))), "target");
  assert.equal(refusedBound(ask(sample({ ownTrials: target - 1 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 0 })), "target");
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
  assert.deepEqual(seen, [14, 7, 3, 1, 1, 1]);
});

test("a full memory ledger leaves the target alone (capacity, not overload): the ledger refuses admissions itself, and a draining batch must not leave the next one a target of 2", () => {
  let state = initialAdmissionState(config);
  for (let at = 0; at < 4; at++) {
    state = advanceAdmissionState(state, sample({ at: at * 5_000, memAvailableMb: 700, ownTrials: 7, servers: [server({ residentMb: 3_000 })] }), true, config);
    assert.equal(state.event, "memory full");
  }
  assert.equal(state.target, config.targetStart);
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 700, ownTrials: 7, servers: [server({ residentMb: 3_000 })] }), state)), "memory", "admission is still refused by the ledger");
});

test("a full memory ledger stops the growth: the target neither grows nor shrinks while it lasts", () => {
  const full = growthRun(initialAdmissionState(config), 120, { memAvailableMb: 700, servers: [server({ residentMb: 3_000 })] });
  assert.ok(full.every(target => target === config.targetStart));
});

test("a breach with none of our trials running leaves the target alone (foreign load says nothing about ours)", () => {
  const state = advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 1, ownTrials: 0 }), true, config);
  assert.equal(state.target, config.targetStart);
});

/** One sample per 5 s from `first`, the way a batch that keeps admitting sees them: bounds held, trials waiting at the target. */
function growthRun(from: AdmissionState, seconds: number, over: Partial<AdmissionSample> = {}): number[] {
  const targets: number[] = [];
  let state = from;
  for (let at = 0; at <= seconds * 1_000; at += 5_000) {
    state = advanceAdmissionState(state, sample({ at, ownTrials: state.target, ...over }), true, config);
    targets.push(state.target);
  }
  return targets;
}

test("a batch that admits every sample still grows: +1 at GROW_AFTER, then +1 per GROW_EVERY while trials wait at the target", () => {
  const start = config.targetStart;
  const targets = growthRun(initialAdmissionState(config), 120);
  const at = (second: number) => targets[second / 5]!;
  assert.equal(at(55), start, "not before 60 s without a breach");
  assert.equal(at(60), start + 1);
  assert.equal(at(70), start + 1, "one step per GROW_EVERY");
  assert.equal(at(75), start + 2);
  assert.equal(at(90), start + 3);
  assert.equal(at(120), start + 5);
});

test("nothing waits at the target: no growth, however long the bounds hold", () => {
  let state = initialAdmissionState(config);
  for (let at = 0; at <= 300_000; at += 5_000) state = advanceAdmissionState(state, sample({ at, ownTrials: 3 }), false, config);
  assert.equal(state.target, config.targetStart);
});

test("growth has no ceiling of its own: the bounds are the limit", () => {
  const targets = growthRun(initialAdmissionState(config), 600);
  assert.equal(targets.at(-1), config.targetStart + 1 + Math.floor((600 - 60) / 15));
});

test("a growth step that the projected cpu would carry over CPU_ADMIT is not taken", () => {
  // 28 trials use 0.84 of the machine (own 0.84): one more adds 0.03, 0.84 + 0.03 is over 0.85 only when busy is 0.83+
  const busy = growthRun(initialAdmissionState(config), 120, { cpuBusy: 0.84, ownCpu: 0.84 });
  assert.ok(busy.every(target => target === config.targetStart), "0.84 + 0.84/28 = 0.87");
  const room = growthRun(initialAdmissionState(config), 75, { cpuBusy: 0.6, ownCpu: 0.5 });
  assert.equal(room.at(-1), config.targetStart + 2);
});

test("the projection counts all the cpu as ours when our share cannot be read", () => {
  const unreadable = growthRun(initialAdmissionState(config), 120, { cpuBusy: 0.84, ownCpu: null });
  assert.equal(unreadable.at(-1), config.targetStart);
});

test("no cpu reading, no growth (the first sample has no window)", () => {
  const blind = growthRun(initialAdmissionState(config), 120, { cpuBusy: null });
  assert.equal(blind.at(-1), config.targetStart);
});

test("a breach in the middle of the wait starts the 60 s again", () => {
  let state = initialAdmissionState(config);
  const run = (at: number, over: Partial<AdmissionSample> = {}) => { state = advanceAdmissionState(state, sample({ at, ownTrials: state.target, ...over }), true, config); return state.target; };
  run(0);
  run(40_000, { servers: [server({ msptP95: 30 })] });
  assert.equal(run(65_000), config.targetStart, "60 s from the start, but only 25 s from the lagging server");
  assert.equal(run(100_000), config.targetStart + 1, "60 s after the breach");
});

test("a server that backs off after lagging is a breach: no growth while it lags", () => {
  const lagging = growthRun(initialAdmissionState(config), 120, { servers: [server({ msptP95: 40 })] });
  assert.equal(lagging.at(-1), config.targetStart);
});

test("a server over its arrangement queue is no breach: its refusal reaches no state, so the target grows and halves as before", () => {
  const full = sample({ servers: [server()], ownTrials: 3 });
  const request: AdmissionRequest = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, queues: new Map([["s1", { queued: 40, holdMs: 800 }]]) };
  assert.equal(ask(full, initialAdmissionState(config), EMPTY_TALLY, request).admit, true, "a new server takes it");
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

const CALM = config.cpuCalm;
const timing = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, timing: true };

test("a timing trial starts only on a calm machine, even with none of ours running (no skip of the cpu bound)", () => {
  const idleOwn = { ownTrials: 0 };
  assert.equal(refusedBound(ask(sample({ ...idleOwn, cpuBusy: CALM + 0.05 }), initialAdmissionState(config), EMPTY_TALLY, timing)), "cpu");
  assert.equal(ask(sample({ ...idleOwn, cpuBusy: CALM - 0.05 }), initialAdmissionState(config), EMPTY_TALLY, timing).admit, true);
});

test("a timing trial waits for a cpu reading: the first sample has no window", () => {
  const decision = ask(sample({ cpuBusy: null, ownTrials: 0 }), initialAdmissionState(config), EMPTY_TALLY, timing);
  assert.equal(refusedBound(decision), "cpu");
  assert.match(decision.admit ? "" : decision.detail, /reading/u);
});

test("while a timing trial runs, other trials start only under CPU_CALM, and the refusal names the timing trial", () => {
  const withTiming = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, timingRunning: 1 };
  const decision = ask(sample({ cpuBusy: CALM + 0.05 }), initialAdmissionState(config), EMPTY_TALLY, withTiming);
  assert.equal(refusedBound(decision), "cpu");
  assert.match(decision.admit ? "" : decision.detail, /timing/u);
  assert.equal(ask(sample({ cpuBusy: CALM - 0.05 }), initialAdmissionState(config), EMPTY_TALLY, withTiming).admit, true);
});

test("CPU_CALM is under CPU_ADMIT and is read from MINE_AI_SCENARIO_CPU_CALM", () => {
  assert.ok(config.cpuCalm < config.cpuAdmit);
  assert.equal(loadScenarioServerConfig({ MINE_AI_SCENARIO_CPU_CALM: "0.4" }).cpuCalm, 0.4);
});

test("a refusal for lack of room for a new server says so, one for any other bound does not", () => {
  const request = { candidates: [], newServerHeapMb: config.sharedHeapMb };
  const noRoom = ask(sample({ servers: [], memAvailableMb: 3_000 }), initialAdmissionState(config), EMPTY_TALLY, request);
  assert.equal(!noRoom.admit && noRoom.waitsForServerRoom, true);
  const cpu = ask(sample({ cpuBusy: 0.9 }));
  assert.equal(!cpu.admit && cpu.waitsForServerRoom, false);
  const perSample = ask(sample({ servers: [], memAvailableMb: 25_000 }), initialAdmissionState(config), { trials: 1, newServers: 1, reservedMb: 4_500 }, request);
  assert.equal(!perSample.admit && perSample.waitsForServerRoom, false, "losing the one-server-per-sample race is not a lack of room");
});

test("foreign cpu 90% with our own 20% keeps the target: the cpu bound alone holds admission, and the state says foreign load", () => {
  const breach = sample({ cpuBusy: 0.9, ownCpu: 0.2, ownTrials: 5 });
  const state = advanceAdmissionState(initialAdmissionState(config), breach, true, config);
  assert.equal(state.target, config.targetStart);
  assert.equal(state.event, "foreign load");
  assert.equal(state.lastBreachAt, breach.at, "still a breach: no growth and the 60 s start again");
  assert.equal(refusedBound(ask(breach)), "cpu");
});

test("our own 60% of a 90% busy machine halves the target", () => {
  const state = advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 0.9, ownCpu: 0.6, ownTrials: 20 }), true, config);
  assert.equal(state.target, config.targetStart / 2);
  assert.equal(state.event, "halved");
});

test("our share exactly at OWN_SHARE_HALVE of the busy cpu halves; just under keeps", () => {
  const at = (ownCpu: number) => advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 0.9, ownCpu, ownTrials: 20 }), true, config).target;
  assert.equal(at(0.9 * config.ownShareHalve), config.targetStart / 2);
  assert.equal(at(0.9 * config.ownShareHalve - 0.01), config.targetStart);
});

test("our share unreadable (null or absent): today's halving", () => {
  assert.equal(advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 0.9, ownCpu: null, ownTrials: 20 }), true, config).target, config.targetStart / 2);
  assert.equal(advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 0.9, ownTrials: 20 }), true, config).target, config.targetStart / 2);
});

test("foreign load with a full memory ledger keeps the target too", () => {
  const state = advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 0.9, ownCpu: 0.1, ownTrials: 7, memAvailableMb: 700, servers: [server({ residentMb: 3_000 })] }), true, config);
  assert.equal(state.target, config.targetStart);
});

test("foreign load while none of our trials runs says nothing: no event, target kept", () => {
  const state = advanceAdmissionState(initialAdmissionState(config), sample({ cpuBusy: 1, ownCpu: 0, ownTrials: 0 }), true, config);
  assert.equal(state.target, config.targetStart);
  assert.equal(state.event, null);
});

test("a timing trial still starts only under CPU_CALM while the target is kept for foreign load", () => {
  const busy = sample({ cpuBusy: CALM + 0.05, ownCpu: 0.01, ownTrials: 0 });
  assert.equal(refusedBound(ask(busy, initialAdmissionState(config), EMPTY_TALLY, timing)), "cpu");
});

/** A server whose queue holds \`queued\` trials at \`holdMs\` each. */
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
  const poor = twoServers({ memAvailableMb: 5_000 });
  const request = asking(["s1", "s2"], queued({ s1: [9], s2: [7] }));
  assert.deepEqual(ask(poor, initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s2", reserveMb: config.clientMemMb });
  const tied = asking(["s1", "s2"], queued({ s1: [7], s2: [7] }));
  assert.equal(admittedOn(ask(poor, initialAdmissionState(config), EMPTY_TALLY, tied)), "s1", "a tie keeps the first candidate");
});

test("a server of the key that is also lagging or backed off is not a queue-fallback candidate", () => {
  const lagging = twoServers({ servers: [server({ msptP95: 30 }), server({ id: "s2" })], memAvailableMb: 5_000 });
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
  const decision = ask(sample({ memAvailableMb: 3_000, servers: [server({ shared: true })] }), initialAdmissionState(config), EMPTY_TALLY, { ...request, queues: undefined });
  assert.equal(decision.admit, true, "no queue information: no queue bound");
  const noServerFits = ask(sample({ memAvailableMb: 3_000 }), initialAdmissionState(config), EMPTY_TALLY, { ...request, candidates: ["s1", "s3"] });
  assert.equal(noServerFits.admit, true, "s1 queue-full, s3 not in the sample: the queue-full server still takes it");
});

test("a server of its own (not shared) has no lanes: its queue entry is never read", () => {
  const own = sample({ servers: [server({ shared: false })] });
  assert.equal(ask(own, initialAdmissionState(config), EMPTY_TALLY, asking(["s1"], queued({ s1: [50] }))).admit, true);
});

test("a server backed off after a wall-bound hit (its tick time fine) stops the growth until it recovers", () => {
  let state = noteWallBoundHit(advanceAdmissionState(initialAdmissionState(config), sample({ at: 0 }), true, config), "s1");
  const targets: number[] = [];
  for (let at = 5_000; at <= 120_000; at += 5_000) {
    state = advanceAdmissionState(state, sample({ at, ownTrials: state.target, servers: [server({ msptP95: 5 })] }), true, config);
    targets.push(state.target);
  }
  assert.equal(state.servers.s1?.backedOff, false, "three good samples end the back-off");
  assert.equal(targets[3], config.targetStart, "backed off at 20 s");
  assert.equal(targets.at(-1)! > config.targetStart, true, "growth resumes once it recovered and 60 s passed");
});
