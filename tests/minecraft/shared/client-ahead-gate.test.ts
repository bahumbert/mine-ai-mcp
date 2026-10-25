import test from "node:test";
import assert from "node:assert/strict";
import { clientAheadRefusal, type ClientAheadGate } from "./client-ahead-gate.ts";
import { loadScenarioServerConfig } from "./config.ts";

const config = loadScenarioServerConfig({});
const open: ClientAheadGate = { forTimingTrial: false, timingBusy: false, cpuBusy: 0.3, ledgerMb: 10_000, forAdmittedTrial: false };
const LEDGER_LINE = config.clientBootedMemMb + config.clientMemMb + config.serverMemMarginMb;

const CASES: readonly { readonly name: string; readonly gate: Partial<ClientAheadGate>; readonly refusal: RegExp | null }[] = [
  { name: "nothing holds it", gate: {}, refusal: null },
  { name: "no cpu reading yet: admission does not wait for one either", gate: { cpuBusy: null }, refusal: null },
  { name: "a timing trial gets no client ahead", gate: { forTimingTrial: true }, refusal: /timing trial gets no client/u },
  { name: "a timing trial runs or waits for calm", gate: { timingBusy: true }, refusal: /no client boots beside it/u },
  { name: "just under the cpu bound", gate: { cpuBusy: config.cpuAdmit - 0.01 }, refusal: null },
  { name: "at the cpu bound", gate: { cpuBusy: config.cpuAdmit }, refusal: /cpu 85% busy/u },
  { name: "the ledger holds the booted size, a whole client and the margin after it", gate: { ledgerMb: LEDGER_LINE }, refusal: null },
  { name: "one MB short of that", gate: { ledgerMb: LEDGER_LINE - 1 }, refusal: /does not cover a booted client and a whole one.*margin \(1024 MB\)/u },
  { name: "a full ledger less the margin boots no spare", gate: { ledgerMb: config.serverMemMarginMb }, refusal: /margin/u },
  { name: "a client for an admitted trial needs no room of its own", gate: { ledgerMb: 0, forAdmittedTrial: true }, refusal: null },
];

for (const { name, gate, refusal } of CASES) {
  test(`a client may boot ahead: ${name}`, () => {
    const answer = clientAheadRefusal({ ...open, ...gate }, config);
    if (refusal === null) assert.equal(answer, null);
    else assert.match(answer ?? "", refusal);
  });
}
