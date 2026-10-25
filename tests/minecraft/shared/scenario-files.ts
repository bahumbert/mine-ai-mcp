// Finds and loads the scenario YAML files of a submission, one error per file that fails and the rest still load.
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { loadScenario, type Scenario } from "mine-labs";

export interface LoadedScenario { readonly id: string; readonly file: string; readonly scenario: Scenario }

async function yamlFilesIn(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await yamlFilesIn(path));
    else if (entry.isFile() && /\.ya?ml$/iu.test(entry.name)) files.push(path);
  }
  return files;
}

/** The ids Mine Labs prints: the path under the input directory without its extension, prefixed by the input's number when there are several. */
export async function loadScenarioFiles(inputs: readonly string[]): Promise<{ scenarios: LoadedScenario[]; errors: string[] }> {
  const scenarios: LoadedScenario[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const [index, input] of inputs.entries()) {
    let files: string[];
    let root: string;
    try {
      const info = await stat(input);
      files = info.isDirectory() ? await yamlFilesIn(input) : [input];
      root = info.isDirectory() ? input : join(input, "..");
    } catch (error) {
      errors.push(`cannot read ${input}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (files.length === 0) errors.push(`no scenario files found in ${input}`);
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      const local = (file === input ? basename(file) : relative(root, file)).replaceAll("\\", "/").slice(0, -extname(file).length);
      try {
        scenarios.push({ id: inputs.length > 1 ? `${index + 1}/${local}` : local, file, scenario: await loadScenario(file) });
      } catch (error) {
        errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { scenarios, errors };
}
