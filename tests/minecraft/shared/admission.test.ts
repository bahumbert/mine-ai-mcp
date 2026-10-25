// The admission bounds: memory ledger and its margin, cpu, target, server tick time and fullness, one new server per sample, what a sample already admitted.
import test from "node:test";
import assert from "node:assert/strict";
import { advanceAdmissionState, decideAdmission, EMPTY_TALLY, initialAdmissionState, ledgerMb, type AdmissionDecision, type AdmissionTally, type AdmissionRequest, type ServerReading } from "./admission.ts";
import { config, MARGIN_MB, server, sample, ask, refusedBound } from "./admission-fixtures.ts";

test("every bound held: the trial takes a lane on the candidate server", () => {
  assert.deepEqual(ask(sample()), { admit: true, server: "s1", reserveMb: config.clientMemMb });
});

test("memory alone breached: the ledger cannot cover one more client", () => {
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 300 }))), "memory");
});

test("the ledger subtracts what servers still have to grow into and the clients still growing", () => {
  // 1500 resident of 3584 leaves 2084 still to come, plus the 2 young clients: exactly one more client and the margin fit at the line
  const base = sample({ youngClients: 2 });
  const line = 2_084 + 3 * config.clientMemMb + MARGIN_MB;
  assert.equal(ask({ ...base, memAvailableMb: line }).admit, true);
  const short = ask({ ...base, memAvailableMb: line - 1 });
  assert.equal(refusedBound(short), "memory");
  assert.match(refusalDetail(short), /server margin \(1024 MB\)/u);
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

// Every admission keeps the server margin free (review 2026-10-25 #4): the margin is the reserve that other daemons and a live run sharing the machine draw on.
const refusalDetail = (decision: AdmissionDecision) => (decision.admit ? "" : decision.detail);

test("a ledger under a client plus the margin counts as memory full: the target stays and the sample is a breach", () => {
  const underMargin = sample({ memAvailableMb: GROWTH_MB + config.clientMemMb + MARGIN_MB - 1, ownTrials: 7, servers: [warm({ busy: true })] });
  assert.equal(advanceAdmissionState(initialAdmissionState(config), underMargin, true, config).event, "memory full");
  const atMargin = { ...underMargin, memAvailableMb: underMargin.memAvailableMb + 1 };
  assert.notEqual(advanceAdmissionState(initialAdmissionState(config), atMargin, true, config).event, "memory full");
});

test("a trial reserves its client and, on an idle server, the growth it wakes (a single server the same way); on a busy server only the client", () => {
  const reserve = (candidate: ServerReading) => ask(sample({ memAvailableMb: 10_000, ownTrials: 0, servers: [candidate] }));
  assert.deepEqual(reserve(warm({ busy: false })), { admit: true, server: "s1", reserveMb: config.clientMemMb + GROWTH_MB });
  assert.deepEqual(reserve(warm({ busy: true })), { admit: true, server: "s1", reserveMb: config.clientMemMb });
  assert.deepEqual(reserve(warm({ shared: false, busy: false })), { admit: true, server: "s1", reserveMb: config.clientMemMb + GROWTH_MB });
});

test("an idle warm server is refused for memory when the ledger covers its client but not the growth the trial wakes and the margin after it", () => {
  const line = config.clientMemMb + GROWTH_MB + MARGIN_MB;
  const idle = (memAvailableMb: number, tally: AdmissionTally = EMPTY_TALLY) =>
    ask(sample({ memAvailableMb, ownTrials: 1, servers: [warm({ busy: false })] }), initialAdmissionState(config), tally);
  assert.equal(idle(line).admit, true);
  const short = idle(line - 1);
  assert.equal(refusedBound(short), "memory");
  assert.match(refusalDetail(short), /s1's client and the 1660 MB it grows by.*margin \(1024 MB\)/u);
  assert.equal(refusedBound(idle(line - 1, { trials: 1, newServers: 1, reservedMb: 0 })), "memory", "still a memory refusal once the sample's one new server has started");
});

test("a busy candidate takes the trial when the idle one cannot be afforded", () => {
  const both = sample({
    memAvailableMb: 3_000 + MARGIN_MB, ownTrials: 1,
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
  const withoutRoom = ask({ ...lagging, memAvailableMb: 3_000 + MARGIN_MB });
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
  assert.equal(refusedBound(ask(sample({ servers: [server({ status: "sick" })], memAvailableMb: 3_000 + MARGIN_MB }))), "server");
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
  assert.equal(ask(sample({ memAvailableMb: 3_000 + MARGIN_MB, ownTrials: 1 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 0 }).admit, true);
  assert.equal(refusedBound(ask(sample({ memAvailableMb: 3_000 + MARGIN_MB, ownTrials: 1 }), initialAdmissionState(config), { trials: 1, newServers: 0, reservedMb: 1_000 })), "memory");
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

test("a refusal for lack of room for a new server says so, one for any other bound does not", () => {
  const request = { candidates: [], newServerHeapMb: config.sharedHeapMb };
  const noRoom = ask(sample({ servers: [], memAvailableMb: 3_000 + MARGIN_MB }), initialAdmissionState(config), EMPTY_TALLY, request);
  assert.equal(!noRoom.admit && noRoom.waitsForServerRoom, true);
  const cpu = ask(sample({ cpuBusy: 0.9 }));
  assert.equal(!cpu.admit && cpu.waitsForServerRoom, false);
  const perSample = ask(sample({ servers: [], memAvailableMb: 25_000 }), initialAdmissionState(config), { trials: 1, newServers: 1, reservedMb: 4_500 }, request);
  assert.equal(!perSample.admit && perSample.waitsForServerRoom, false, "losing the one-server-per-sample race is not a lack of room");
});

// A client booted ahead is already in MemAvailable: its trial reserves only what a logged-in client adds (T7h-b).
test("a trial whose client was booted ahead reserves the difference to a logged-in client, not the whole client", () => {
  const difference = config.clientMemMb - config.clientBootedMemMb;
  const request: AdmissionRequest = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, clientReserveMb: difference };
  assert.deepEqual(ask(sample(), initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s1", reserveMb: difference });
  // The memory line moves down by the booted size: the ledger needs the difference, not the whole client.
  const line = 2_084 + difference + MARGIN_MB;
  assert.equal(ask(sample({ memAvailableMb: line }), initialAdmissionState(config), EMPTY_TALLY, request).admit, true);
  assert.equal(refusedBound(ask(sample({ memAvailableMb: line - 1 }), initialAdmissionState(config), EMPTY_TALLY, request)), "memory");
});

test("an idle server's growth and a new server's need are added to the reduced client reserve, not to a whole client", () => {
  const difference = config.clientMemMb - config.clientBootedMemMb;
  const idle = server({ busy: false, heapMb: 2_048, residentMb: 900 });
  const request: AdmissionRequest = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb, clientReserveMb: difference };
  assert.deepEqual(ask(sample({ servers: [idle] }), initialAdmissionState(config), EMPTY_TALLY, request), { admit: true, server: "s1", reserveMb: difference + 1_660 });
  const fresh = ask(sample({ servers: [] }), initialAdmissionState(config), EMPTY_TALLY, { ...request, candidates: [] });
  assert.deepEqual(fresh, { admit: true, server: "new", reserveMb: difference + config.sharedHeapMb + config.serverMemMarginMb });
});

test("the ledger counts the memory clients booted ahead are still growing into, beside the young clients of trials", () => {
  const base = sample({ youngClients: 2, youngClientsMb: 2 * config.clientMemMb + 3 * config.clientBootedMemMb, memAvailableMb: 20_000 });
  assert.equal(ledgerMb(base, EMPTY_TALLY, config), 20_000 - 2_084 - 2 * config.clientMemMb - 3 * config.clientBootedMemMb);
  assert.equal(ledgerMb(sample({ youngClients: 2, memAvailableMb: 20_000 }), EMPTY_TALLY, config), 20_000 - 2_084 - 2 * config.clientMemMb, "absent: the young clients are whole ones, as before");
});
