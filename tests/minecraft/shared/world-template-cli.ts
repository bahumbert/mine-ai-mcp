// The command line of the template build: `bun tests/minecraft/shared/world-template.ts build [--version v] [--lanes n] [--port p]` (world-template.ts runs `main`).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadAllScenarios } from "../arena/all-scenarios.ts";
import { chunkCount } from "../arena/template-area.ts";
import { loadScenarioServerConfig } from "./config.ts";
import { buildTemplate, generatorLinesOf, propertyOf, realTemplatePorts, templateDir, templateKey, type TemplatePorts } from "./world-template.ts";
import { templateBoxesOf } from "./world-template-use.ts";

export interface BuildArgs {
  /** Null: every version the scenarios name. */
  readonly versions: readonly string[] | null;
  readonly lanes: number;
  readonly port: number | null;
}

/** Reads `build` and its flags; an unknown flag or a value that is not a whole number is an error, never a silent default. */
export function parseBuildArgs(argv: readonly string[]): BuildArgs {
  if (argv[0] !== "build") throw new Error("usage: bun tests/minecraft/shared/world-template.ts build [--version 1.21.4] [--lanes 28] [--port 25566]");
  const values = new Map<string, string>();
  for (let i = 1; i < argv.length; i += 2) values.set(argv[i]!, argv[i + 1] ?? "");
  for (const flag of values.keys()) {
    if (!["--version", "--lanes", "--port"].includes(flag)) throw new Error(`unknown flag ${flag}; flags are --version, --lanes, --port`);
  }
  const wholeNumber = (flag: string, fallback: number | null): number | null => {
    const text = values.get(flag);
    if (text === undefined) return fallback;
    if (!/^\d+$/u.test(text)) throw new Error(`${flag} wants a whole number, got "${text}"`);
    return Number(text);
  };
  const version = values.get("--version");
  // The daemon computes its key from the same lane count (`config.templateLanes`), so a default here that differed would build a template no daemon finds.
  return { versions: version ? [version] : null, lanes: wholeNumber("--lanes", loadScenarioServerConfig().templateLanes)!, port: wholeNumber("--port", null) };
}

/**
 * Starts a throwaway server and reads what Mine Labs wrote for it: the view distance in chunks and the generator lines. The area needs the
 * first and the key needs the second, and neither is stated in our code. The server and its root are gone when this returns.
 */
export async function probeServer(ports: TemplatePorts, version: string, root: string): Promise<{ viewChunks: number; generatorLines: string[] }> {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const server = await ports.startServer(version, root, {});
  try {
    const text = readFileSync(join(root, "server.properties"), "utf8");
    const viewChunks = Number(propertyOf(text, "view-distance"));
    if (!Number.isInteger(viewChunks) || viewChunks < 0) throw new Error(`server.properties of ${root} holds no usable view-distance`);
    return { viewChunks, generatorLines: generatorLinesOf(text) };
  } finally {
    await server.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

/** Builds the template of each version (a version whose template exists is left as it is); answers the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseBuildArgs(argv);
  const { templateBuildBoundMs: boundMs, templateDir: cacheDir } = loadScenarioServerConfig();
  mkdirSync(cacheDir, { recursive: true });
  const scenarios = (await loadAllScenarios()).map(loaded => loaded.scenario);
  const versions = args.versions ?? [...new Set(scenarios.map(scenario => scenario.minecraft.version))];
  const ports = realTemplatePorts({ preferPort: args.port ?? undefined });
  let failed = false;
  for (const version of versions) {
    const { viewChunks, generatorLines } = await probeServer(ports, version, join(cacheDir, `probe.tmp-${process.pid}`));
    const boxes = templateBoxesOf(scenarios, version, args.lanes, viewChunks);
    console.log(`${version}: ${boxes.length} boxes, ${chunkCount(boxes)} chunks, lanes ${args.lanes}, view ${viewChunks}`);
    const existing = templateDir(cacheDir, templateKey(version, generatorLines, boxes));
    if (existing) {
      console.log(`${version}: template ${existing} exists`);
      continue;
    }
    const result = await buildTemplate({ cacheDir, version, boxes, boundMs, log: line => console.log(line) }, ports);
    console.log(result.ok ? `${version}: template ${result.dir}` : `${version}: build failed${result.bound ? " (bound)" : ""}: ${result.reason}`);
    failed ||= !result.ok;
  }
  return failed ? 1 : 0;
}
