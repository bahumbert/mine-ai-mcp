// Observed response chains for each threat, scoped to one life and dimension.
import type { HostileSettlement } from "../control/combat/response-result.js";

export const CHAIN_GAP_MS = 60_000;

export interface ChainFacts {
  readonly threatId: number;
  readonly name: string;
  readonly responses: number;
  readonly evades: number;
  readonly seconds: number;
  readonly gained: number;
}

interface ThreatChain {
  readonly firstStartMs: number;
  readonly firstDistance: number;
  readonly endedAtMs: number;
  readonly responses: number;
  readonly evades: number;
}

interface ChainEntry {
  readonly generation: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly settlement: HostileSettlement;
  readonly firstDistances: ReadonlyMap<number, number>;
}

/** Retain nearby responses without making any decision about the threat. */
export class ThreatChains {
  readonly #chains = new Map<number, ThreatChain>();
  #generation = 0;

  get generation(): number { return this.#generation; }

  /** Drop late cleanup from an old life or dimension and return the longest participating chain. */
  record({ generation, startedAtMs, endedAtMs, settlement, firstDistances }: ChainEntry): ChainFacts | null {
    if (generation !== this.#generation) return null;
    for (const [id, chain] of this.#chains)
      if (startedAtMs - chain.endedAtMs > CHAIN_GAP_MS) this.#chains.delete(id);
    let longest: ChainFacts | null = null;
    for (const threat of settlement.evidence.threats) {
      const firstDistance = firstDistances.get(threat.id);
      const distance = settlement.evidence.finalDistances.find((entry) => entry.id === threat.id)?.distance;
      if (firstDistance === undefined || distance === undefined) continue;
      const previous = this.#chains.get(threat.id);
      const chain: ThreatChain = {
        firstStartMs: previous?.firstStartMs ?? startedAtMs,
        firstDistance: previous?.firstDistance ?? firstDistance,
        endedAtMs,
        responses: (previous?.responses ?? 0) + 1,
        evades: (previous?.evades ?? 0) + Number(settlement.response === "evade"),
      };
      this.#chains.set(threat.id, chain);
      if (chain.responses < 2) continue;
      const facts: ChainFacts = { threatId: threat.id, name: threat.name, responses: chain.responses,
        evades: chain.evades, seconds: Math.round((endedAtMs - chain.firstStartMs) / 1_000),
        gained: distance - chain.firstDistance };
      if (!longest || facts.responses > longest.responses
        || (facts.responses === longest.responses && facts.seconds > longest.seconds)) longest = facts;
    }
    return longest;
  }

  /** Invalidate responses still cleaning up as well as the settled records. */
  clear(): void {
    this.#chains.clear();
    this.#generation++;
  }
}

/** The same factual phrase is used in the model's settle text and the monitor's outcome line. */
export function chainSuffix(chain: ChainFacts): string {
  const teen = chain.responses % 100;
  const last = chain.responses % 10;
  const suffix = teen >= 11 && teen <= 13 ? "th" : last === 1 ? "st" : last === 2 ? "nd" : last === 3 ? "rd" : "th";
  return `; ${chain.responses}${suffix} response to ${chain.name}#${chain.threatId} in ${chain.seconds} s, ${chain.evades} evades, gained ${chain.gained.toFixed(1)} blocks overall`;
}
