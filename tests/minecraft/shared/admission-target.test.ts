// The admission target: how it backs off a lagging server, halves under a cpu breach, grows while trials wait, and what foreign load changes.
import test from "node:test";
import assert from "node:assert/strict";
import { advanceAdmissionState, EMPTY_TALLY, initialAdmissionState, noteWallBoundHit, type AdmissionSample, type AdmissionState, type AdmissionRequest } from "./admission.ts";
import { config, MARGIN_MB, server, sample, ask, refusedBound } from "./admission-fixtures.ts";

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
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 3_000 + MARGIN_MB }), state)), "server");
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

test("boot cpu of our own with no trial of ours running does not halve the target", () => {
  // Clients booted ahead are our children, so the process tree counts their boots as ours; the halving needs a trial of ours running.
  const booting = sample({ cpuBusy: 0.95, ownCpu: 0.9, ownTrials: 0 });
  assert.equal(advanceAdmissionState(initialAdmissionState(config), booting, true, config).target, config.targetStart);
});
