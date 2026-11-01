// Lane servers start from the template world (plan scenario-clients-ext4 P3): fake `cp` and a temp cache dir stand for the copy; the key is the one the build computes.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "mine-labs";
import { templateArea } from "../arena/template-area.ts";
import { loadScenarioServerConfig } from "./config.ts";
import type { ServerRequest } from "./pool.ts";
import type { RunOptions, RunResult } from "./run-bounded.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { templateKey } from "./world-template.ts";
import { LaneWorldTemplates, type TemplateUsePorts } from "./world-template-use.ts";

const VERSION = "1.21.4";
const GENERATOR_LINES = ["level-type=minecraft\\:flat", 'generator-settings={"layers"\\:[]}'];
const VIEW_CHUNKS = 8;
const LANES = 3;
/** What Mine Labs writes into a flat server's `server.properties` (the lines the key reads, the view distance the area reads). */
const FLAT_PROPERTIES = `server-port=25400\n${GENERATOR_LINES.join("\n")}\nview-distance=${VIEW_CHUNKS}\nmax-players=100\n`;

interface Call { readonly command: string; readonly args: readonly string[]; readonly options: RunOptions }

function request(overrides: Partial<ServerRequest> = {}): ServerRequest {
  return { id: "s2", kind: "shared", key: "k1", heapMb: 3_072, setup: [], scenario: fixtureScenario(10), ...overrides };
}

function defaultWorld(): Scenario {
  const flat = fixtureScenario(10);
  return { ...flat, world: { ...flat.world, type: "default" } } as Scenario;
}

/** The key the build would compute for the census of `scenarios`: the same functions, called on the same inputs. */
function keyOf(scenarios: readonly Scenario[]): string {
  return templateKey(VERSION, GENERATOR_LINES, templateArea(scenarios, { lanes: LANES, viewChunks: VIEW_CHUNKS }));
}

/** Makes a finished template of `key` in `cacheDir`: `template.json` and the given directories (each with one file). */
function makeTemplate(cacheDir: string, key: string, directories: readonly string[] = ["region", "entities", "poi"]): string {
  const dir = join(cacheDir, key);
  for (const name of directories) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "r.0.0.mca"), "x");
  }
  writeFileSync(join(dir, "template.json"), "{}\n");
  return dir;
}

interface Setup {
  readonly cacheDir: string;
  readonly worldDir: string;
  readonly calls: Call[];
  readonly lines: string[];
  readonly census: Scenario[];
  readonly loads: { count: number };
  readonly templates: LaneWorldTemplates;
}

/** `outcome` is what the fake `cp` does: copy what it was told to (like the real one), exit with a code, or run past its bound. */
async function withTemplates(
  body: (setup: Setup) => Promise<void>,
  options: { outcome?: "copies" | "exit-1" | "bound" | "throws"; census?: Scenario[]; loader?: () => Promise<readonly Scenario[]>; env?: Record<string, string> } = {},
): Promise<void> {
  const cacheDir = mkdtempSync(join(tmpdir(), "world-template-use-"));
  const worldDir = join(cacheDir, "servers", "s2", "world");
  mkdirSync(worldDir, { recursive: true });
  const calls: Call[] = [];
  const lines: string[] = [];
  const census = options.census ?? [fixtureScenario(10)];
  const loads = { count: 0 };
  const ports: Partial<TemplateUsePorts> = {
    scenarios: options.loader ?? (async () => { loads.count++; return census; }),
    async run(command, args, runOptions): Promise<RunResult> {
      calls.push({ command, args, options: runOptions });
      const outcome = options.outcome ?? "copies";
      if (outcome === "throws") throw new Error("spawn exploded");
      // The real `cp -r a b c world/` puts each source directory under world/; the fake does it with the names, so removal has something to remove.
      for (const source of args.slice(1, -1)) mkdirSync(join(args.at(-1)!, source.split("/").at(-1)!), { recursive: true });
      if (outcome === "exit-1") return { code: 1, stderrTail: "cp: no space left on device" };
      if (outcome === "bound") return { code: -1, stderrTail: "", timedOut: true };
      return { code: 0, stderrTail: "" };
    },
  };
  const templates = new LaneWorldTemplates({
    config: { ...loadScenarioServerConfig({ MINE_AI_SCENARIO_TEMPLATE_LANES: String(LANES), MINE_AI_SCENARIO_TEMPLATE_COPY_BOUND_MS: "40000", ...options.env }), templateDir: cacheDir },
    log: line => lines.push(line),
  }, ports);
  try {
    await body({ cacheDir, worldDir, calls, lines, census, loads, templates });
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

test("a shared flat server gets one cp -r of the three directories into its world, awaited, bounded, and the line says so", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, lines, census, templates }) => {
    const dir = makeTemplate(cacheDir, keyOf(census));
    templates.observe(request(), FLAT_PROPERTIES);
    const world = await templates.prepare(request(), worldDir);
    assert.ok(world, "the world holds the template");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, "cp");
    assert.deepEqual(calls[0]!.args, ["-r", join(dir, "region"), join(dir, "entities"), join(dir, "poi"), worldDir]);
    assert.equal(calls[0]!.options.cwd, worldDir);
    assert.equal(calls[0]!.options.boundMs, 40_000);
    assert.match(lines.join("\n"), new RegExp(`world template ${keyOf(census)} copied into s2 in \\d+ ms`, "u"));
  });
});

test("a template without entities and poi (the server made none) is copied with the directories it has", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, census, templates }) => {
    const dir = makeTemplate(cacheDir, keyOf(census), ["region"]);
    templates.observe(request(), FLAT_PROPERTIES);
    assert.ok(await templates.prepare(request(), worldDir));
    assert.deepEqual(calls[0]!.args, ["-r", join(dir, "region"), worldDir]);
  });
});

const OTHER_VERSION = { ...fixtureScenario(10), minecraft: { ...fixtureScenario(10).minecraft, version: "1.20.4" } } as Scenario;
for (const [name, overrides] of [
  ["a server of its own: the copy is for lane servers only", { kind: "single" }],
  ["the gamerule probe server (key probe:<version>), though it is a shared flat server", { key: `probe:${VERSION}` }],
  ["a template of another version is not used", { scenario: OTHER_VERSION }],
] as const) {
  test(`${name} gets nothing`, async () => {
    await withTemplates(async ({ cacheDir, worldDir, calls, census, templates }) => {
      makeTemplate(cacheDir, keyOf(census));
      templates.observe(request(overrides), FLAT_PROPERTIES);
      assert.equal(await templates.prepare(request(overrides), worldDir), null);
      assert.equal(calls.length, 0);
    });
  });
}

test("a default world gets nothing, and its server.properties (level-type normal) is never taken for the flat generator lines", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, census, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    const normal = `level-type=minecraft\\:normal\nview-distance=${VIEW_CHUNKS}\n`;
    templates.observe(request({ scenario: defaultWorld() }), normal);
    assert.equal(await templates.prepare(request({ scenario: defaultWorld() }), worldDir), null);
    // Nothing flat was observed, so a flat server finds no facts either.
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(calls.length, 0);
  });
});

test("no template of the key: nothing copied, no error, and the daemon log says once that servers start empty", async () => {
  await withTemplates(async ({ worldDir, calls, lines, census, templates }) => {
    templates.observe(request(), FLAT_PROPERTIES);
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(await templates.prepare(request({ id: "s3" }), worldDir), null);
    assert.equal(calls.length, 0);
    const missing = lines.filter(line => line.includes("missing"));
    assert.equal(missing.length, 1, lines.join("\n"));
    assert.match(missing[0]!, new RegExp(`world template ${keyOf(census)} missing \\(servers start empty until it is built\\)`, "u"));
  });
});

test("a template built while the daemon runs is used by the next server (the directory is looked up at each server, the key is not recomputed)", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, census, templates }) => {
    templates.observe(request(), FLAT_PROPERTIES);
    assert.equal(await templates.prepare(request(), worldDir), null);
    makeTemplate(cacheDir, keyOf(census));
    assert.ok(await templates.prepare(request({ id: "s3" }), worldDir));
    assert.equal(calls.length, 1);
  });
});

test("before any flat server wrote its server.properties the facts are unknown: nothing copied, said once", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, lines, census, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(await templates.prepare(request({ id: "s3" }), worldDir), null);
    assert.equal(calls.length, 0);
    assert.equal(lines.filter(line => line.includes(`${VERSION} not known yet`)).length, 1, lines.join("\n"));
  });
});

test("templates off (MINE_AI_SCENARIO_WORLD_TEMPLATE=0): nothing copied", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, census, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    templates.observe(request(), FLAT_PROPERTIES);
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(calls.length, 0);
  }, { env: { MINE_AI_SCENARIO_WORLD_TEMPLATE: "0" } });
});

for (const [name, outcome, reason] of [
  ["a copy exiting 1", "exit-1", /failed: cp exited 1: cp: no space left on device/u],
  ["a copy past its bound (killed)", "bound", /failed: cut at 40000 ms/u],
  ["a copy that cannot even start (run throws)", "throws", /failed: spawn exploded/u],
] as const) {
  test(`${name} leaves an empty world and says why; the server starts`, async () => {
    await withTemplates(async ({ cacheDir, worldDir, lines, census, templates }) => {
      makeTemplate(cacheDir, keyOf(census));
      templates.observe(request(), FLAT_PROPERTIES);
      assert.equal(await templates.prepare(request(), worldDir), null);
      for (const directory of ["region", "entities", "poi"]) assert.equal(existsSync(join(worldDir, directory)), false, `${directory} is gone`);
      assert.ok(existsSync(worldDir), "the world directory itself stays: the server writes its world there");
      assert.match(lines.join("\n"), new RegExp(`world template copy into s2 ${reason.source}`, "u"));
    }, { outcome });
  });
}

test("a census that cannot be loaded costs the template, never the server", async () => {
  await withTemplates(async ({ worldDir, calls, lines, templates }) => {
    templates.observe(request(), FLAT_PROPERTIES);
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(calls.length, 0);
    assert.match(lines.join("\n"), /world template for 1\.21\.4 unavailable: yaml broke/u);
  }, { loader: async () => { throw new Error("yaml broke"); } });
});

test("a server.properties without a usable view-distance is not taken as the facts", async () => {
  await withTemplates(async ({ cacheDir, worldDir, calls, lines, census, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    templates.observe(request(), `${GENERATOR_LINES.join("\n")}\nview-distance=far\n`);
    assert.equal(await templates.prepare(request(), worldDir), null);
    assert.equal(calls.length, 0);
    assert.match(lines.join("\n"), /no usable view-distance/u);
  });
});

test("two servers asking at once share one census load", async () => {
  await withTemplates(async ({ cacheDir, worldDir, census, loads, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    templates.observe(request(), FLAT_PROPERTIES);
    const [first, second] = await Promise.all([templates.prepare(request(), worldDir), templates.prepare(request({ id: "s3" }), worldDir)]);
    assert.ok(first && second);
    assert.equal(loads.count, 1);
  });
});

test("a templated server's world is gone once the factory's stop calls remove (an empty server has no handle, so its world is kept as before)", async () => {
  await withTemplates(async ({ cacheDir, worldDir, census, templates }) => {
    makeTemplate(cacheDir, keyOf(census));
    templates.observe(request(), FLAT_PROPERTIES);
    const world = await templates.prepare(request(), worldDir);
    assert.ok(world);
    writeFileSync(join(worldDir, "level.dat"), "x"); // what the server added while it ran
    await world.remove();
    assert.equal(existsSync(worldDir), false);
    await world.remove(); // a second stop call finds nothing and fails nothing
  });
});

test("buildStatus: nothing before a flat server wrote its server.properties", async () => {
  await withTemplates(async ({ templates }) => {
    assert.deepEqual(await templates.buildStatus(), []);
  });
});

test("buildStatus: one entry per version with its key and boxes, present or missing; two servers of a version make one entry", async () => {
  await withTemplates(async ({ cacheDir, census, templates }) => {
    templates.observe(request(), FLAT_PROPERTIES);
    templates.observe(request({ id: "s3" }), FLAT_PROPERTIES);
    const key = keyOf(census);
    const [missing] = await templates.buildStatus();
    assert.deepEqual({ version: missing?.version, key: missing?.key, present: missing?.present }, { version: VERSION, key, present: false });
    assert.deepEqual(missing?.boxes, templateArea(census, { lanes: LANES, viewChunks: VIEW_CHUNKS }), "the boxes the build is given are the ones the key was made of");
    makeTemplate(cacheDir, key);
    const found = await templates.buildStatus();
    assert.equal(found.length, 1);
    assert.equal(found[0]?.present, true);
  });
});

test("buildStatus: a census that cannot be loaded gives no entry (the log says why, once per version)", async () => {
  await withTemplates(async ({ lines, templates }) => {
    templates.observe(request(), FLAT_PROPERTIES);
    assert.deepEqual(await templates.buildStatus(), []);
    assert.deepEqual(await templates.buildStatus(), []);
    assert.equal(lines.filter(line => line.includes("unavailable: census exploded")).length, 1);
  }, { loader: async () => { throw new Error("census exploded"); } });
});

for (const outcome of ["copies", "exit-1"] as const) {
  test(`a copy that ${outcome === "copies" ? "works" : "fails"} touches the template's .last-used, so the prune keeps a template a daemon asked for`, async () => {
    await withTemplates(async ({ cacheDir, worldDir, census, templates }) => {
      const dir = makeTemplate(cacheDir, keyOf(census));
      templates.observe(request(), FLAT_PROPERTIES);
      assert.equal(existsSync(join(dir, ".last-used")), false);
      assert.equal((await templates.prepare(request(), worldDir)) !== null, outcome === "copies");
      assert.ok(Date.now() - statSync(join(dir, ".last-used")).mtimeMs < 5_000);
    }, { outcome });
  });
}
