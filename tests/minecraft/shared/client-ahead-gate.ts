// When a scenario client may be booted before its trial: never beside a timing trial, never into a busy machine, and a spare only if the ledger holds it.
import type { ScenarioServerConfig } from "./config.ts";

export interface ClientAheadGate {
  /** The client is for a timing trial (a locked batch, a scenario tagged exclusive): it gets none, its machine stays calm. */
  readonly forTimingTrial: boolean;
  /** A timing trial runs or waits for a calm machine: nothing boots beside it. */
  readonly timingBusy: boolean;
  /** The machine's cpu share over the last sample window; null before the second sample. */
  readonly cpuBusy: number | null;
  /** What the memory ledger has left now. */
  readonly ledgerMb: number;
  /** Booted for a trial just admitted: its whole-client reserve already holds the client, the ledger needs no room of its own for it. */
  readonly forAdmittedTrial: boolean;
}

/** Why a client may not boot now, or null. Foreign load alone does not hold a trial back, but it does hold the boots we add to it. */
export function clientAheadRefusal(gate: ClientAheadGate, config: Pick<ScenarioServerConfig, "cpuAdmit" | "clientMemMb" | "clientBootedMemMb">): string | null {
  if (gate.forTimingTrial) return "a timing trial gets no client ahead: its machine stays calm";
  if (gate.timingBusy) return "a timing trial runs or waits for a calm machine: no client boots beside it";
  if (gate.cpuBusy !== null && gate.cpuBusy >= config.cpuAdmit) return `cpu ${Math.round(gate.cpuBusy * 100)}% busy, the bound is ${Math.round(config.cpuAdmit * 100)}%: a boot would add to it`;
  // After the boot the next trial must still find a whole client free, as it would without the boot.
  if (!gate.forAdmittedTrial && gate.ledgerMb - config.clientBootedMemMb < config.clientMemMb) {
    return `memory ledger ${gate.ledgerMb} MB does not hold a booted client (${config.clientBootedMemMb} MB) and a whole one (${config.clientMemMb} MB)`;
  }
  return null;
}
