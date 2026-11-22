// The value every gamerule has on a fresh server of a version, read from a pristine probe server and kept for the daemon's life.
import type { Scenario } from "mine-labs";
import { parseGameruleAnswer } from "./placement.ts";
import type { ScenarioServer } from "./scenario-server.ts";

export class ProbeFailed extends Error {
  constructor(readonly version: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export class GameruleDefaultsCache {
  readonly #byVersion = new Map<string, Record<string, string>>();

  /** `probe` starts (or returns) a pristine server of the version, made from `example`; it is called only when a rule is missing. */
  constructor(private readonly probe: (version: string, example: Scenario) => Promise<ScenarioServer>) {}

  forVersion(version: string): Readonly<Record<string, string>> {
    return this.#byVersion.get(version) ?? {};
  }

  /** Reads the rules of `names` not known yet; returns those the server answered nothing for. */
  async ensure(version: string, names: readonly string[], example: Scenario): Promise<string[]> {
    const known = this.#byVersion.get(version) ?? {};
    const missing = [...new Set(names)].filter(name => !(name in known));
    if (missing.length === 0) return [];
    const unknown: string[] = [];
    try {
      const server = await this.probe(version, example);
      for (const name of missing) {
        const value = parseGameruleAnswer(await server.command(`gamerule ${name}`));
        if (value === null) unknown.push(name);
        else known[name] = value;
      }
    } catch (error) {
      throw new ProbeFailed(version, error);
    }
    this.#byVersion.set(version, known);
    return unknown;
  }
}
