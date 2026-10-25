// The server readings, samples and asks the admission tests build their cases from.
import assert from "node:assert/strict";
import { decideAdmission, EMPTY_TALLY, initialAdmissionState, type AdmissionDecision, type AdmissionSample, type AdmissionState, type AdmissionTally, type AdmissionRequest, type ServerReading } from "./admission.ts";
import { loadScenarioServerConfig } from "./config.ts";

/** The default scenario-server config. */
export const config = loadScenarioServerConfig({});
/** The memory the ledger keeps free for others. */
export const MARGIN_MB = config.serverMemMarginMb;

/** A ready, busy shared server reading, as the sampler would give it. */
export function server(overrides: Partial<ServerReading> = {}): ServerReading {
  return { id: "s1", key: "k", status: "ready", shared: true, busy: true, msptP95: 5, heapMb: 3_072, residentMb: 1_500, ...overrides };
}

/** A machine sample with one server and three of our trials running. */
export function sample(overrides: Partial<AdmissionSample> = {}): AdmissionSample {
  return { at: 100_000, cpuBusy: 0.3, memAvailableMb: 20_000, threads: 24, servers: [server()], ownTrials: 3, youngClients: 0, ...overrides };
}

/** What the admission decides for the sample, the state, the tally so far and the request. */
export function ask(
  s: AdmissionSample,
  state: AdmissionState = initialAdmissionState(config),
  tally: AdmissionTally = EMPTY_TALLY,
  request: AdmissionRequest = { candidates: ["s1"], newServerHeapMb: config.sharedHeapMb },
): AdmissionDecision {
  return decideAdmission({ sample: s, state, tally, request, config });
}

/** The bound that refused the trial; fails when it was admitted. */
export function refusedBound(decision: AdmissionDecision): string {
  assert.equal(decision.admit, false, "expected a refusal");
  return decision.admit ? "" : decision.bound;
}
