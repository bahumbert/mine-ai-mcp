/** Every Mine Labs scenario file of the physical test suite, loaded the way `mine-labs run` loads it (the census tests walk these). */
import { readdirSync } from "node:fs";
import path from "node:path";
import { loadScenario, type Scenario } from "mine-labs";

/** Directories with scenarios; `templates/` holds partial defaults, not scenarios. */
const SCENARIO_ROOTS = ["scenarios", "contract/scenarios"].map((directory) => path.resolve(import.meta.dirname, "..", directory));

export interface LoadedScenario {
  /** Path relative to `tests/minecraft`, for messages. */
  readonly file: string;
  readonly scenario: Scenario;
}

function yamlFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return yamlFilesUnder(full);
    return entry.name.endsWith(".yaml") ? [full] : [];
  });
}

/** A directory walk, so a scenario added later is covered without editing a list. */
export async function loadAllScenarios(): Promise<LoadedScenario[]> {
  const files = SCENARIO_ROOTS.flatMap(yamlFilesUnder).sort();
  return await Promise.all(
    files.map(async (file) => ({ file: path.relative(path.resolve(import.meta.dirname, ".."), file).replaceAll("\\", "/"), scenario: await loadScenario(file) })),
  );
}
