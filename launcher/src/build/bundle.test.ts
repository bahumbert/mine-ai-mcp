import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { APP_ASSETS, bundleEntries, copyAssets, ENTRY_POINTS, minecraftDataFiles, packageApp, WORKER_ENTRY_POINTS, WORKER_FOLDER } from "./bundle.ts";

// Real `Bun.build` of the repository into a temp folder under the OS temp dir: no `node_modules` above it, so a module
// the bundle needs and lacks fails here as it would on the player's PC.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const MINECRAFT_VERSION = "1.21.4";
const PROBE = "launcher/src/build/bundle-probe.ts";
const RUN_LIMIT_MS = 60_000;

/** The checkout has no `bun.exe` (the release build downloads it) and no personas (private): `copyAssets` is tested on its own below. */
const CHECKOUT_ASSETS = APP_ASSETS.filter((asset) => asset !== "bun.exe" && asset !== "personas");
// One `packageApp` on the real repository takes 2.0-3.4 s here (/mnt/d, 5 runs, 2026-10-31) and Bun ends a hook at 5 s by
// default (node:test's `{ timeout }` option is ignored by Bun): 20 s leaves room for a loaded machine.
setDefaultTimeout(20_000);

let appDir = "";

before(async () => {
  appDir = mkdtempSync(join(tmpdir(), "bundle-test-"));
  await packageApp(repoRoot, appDir, MINECRAFT_VERSION, process.execPath, CHECKOUT_ASSETS);
  await bundleEntries(repoRoot, appDir, [PROBE], "src/server");
});

after(() => rmSync(appDir, { recursive: true, force: true }));

function appFiles(): string[] {
  return readdirSync(appDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(appDir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
}

function runBundled(entry: string, args: readonly string[]): { code: number | null; output: string } {
  const run = spawnSync(process.execPath, [join(appDir, entry), ...args], { cwd: appDir, encoding: "utf8", timeout: RUN_LIMIT_MS });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

test("every entry point and worker is bundled to its source path with a .js name and a source map", () => {
  const workers = WORKER_ENTRY_POINTS.map((entry) => `${WORKER_FOLDER}/${entry.split("/").at(-1)}`);
  for (const entry of [...ENTRY_POINTS, ...workers]) {
    const output = entry.replace(/\.ts$/u, ".js");
    assert.ok(existsSync(join(appDir, output)), `${output} is missing`);
    assert.ok(existsSync(join(appDir, `${output}.map`)), `${output}.map is missing: a stack trace in a log would name bundle lines`);
  }
});

test("the workers sit beside the runtime bundle that starts them, whichever module asks", () => {
  for (const sibling of ["wal-checkpoint-worker.js", "freeze-watch-worker.js", "runtime-process.js", "host.js"]) {
    assert.ok(existsSync(join(appDir, "src", "server", sibling)), `src/server/${sibling} is missing`);
  }
});

test("the launcher bundle starts under the shipped Bun and prints its usage", () => {
  const { code, output } = runBundled("launcher/src/main.js", ["--help"]);
  assert.equal(code, 0, output);
  assert.match(output, /Usage: mine-ai/u);
});

test("the brain bundle loads its building styles from brain/building-styles, one folder above its own", () => {
  const { code, output } = runBundled("brain/src/main.js", ["--help"]);
  assert.equal(code, 0, output);
  assert.match(output, /--agent/u);
});

test("the host bundle starts and reads its arguments (it has no --help, so it names the unknown option)", () => {
  const { code, output } = runBundled("src/server/host.js", ["--help"]);
  assert.equal(code, 1, output);
  assert.match(output, /Unknown option '--help'/u);
  assert.doesNotMatch(output, /Cannot find module|Could not resolve/u);
});

test("the runtime's data files, both workers and the four createRequire modules load from the bundle", () => {
  const { code, output } = runBundled("src/server/bundle-probe.js", []);
  assert.equal(code, 0, output);
  const report = JSON.parse(output.split("\n").find((line) => line.startsWith("PROBE "))!.slice("PROBE ".length)) as { schemaBytes: number; walFailures: string[]; freezeRecord: string | null; freezeFiles: number };
  assert.ok(report.schemaBytes > 100, "the bot-data schema is empty");
  assert.deepEqual(report.walFailures, [], "the WAL checkpoint worker did not start");
  assert.ok(report.freezeFiles >= 1 || report.freezeRecord !== null, `the freeze-watch worker recorded nothing: ${output}`);
});

test("the trimmed minecraft-data gives the 1.21.4 data the bots read, from a folder with nothing else", () => {
  const touch = `const d = require("minecraft-data")("${MINECRAFT_VERSION}"); console.log(JSON.stringify([d.blocksArray.length, d.itemsArray.length, Object.keys(d.recipes).length, Object.keys(d.protocol).length, d.version.minecraftVersion]));`;
  const run = spawnSync(process.execPath, ["-e", touch], { cwd: appDir, encoding: "utf8" });
  const [blocks, items, recipes, protocol, version] = JSON.parse(run.stdout.trim()) as [number, number, number, number, string];
  assert.ok(blocks > 1000 && items > 1000 && recipes > 500 && protocol > 3, run.stdout + run.stderr);
  assert.equal(version, MINECRAFT_VERSION);
});

// The brain asks for minecraft-data's NEWEST registry (`brain/src/boats.ts` for the boat recipes, `brain/src/skills.ts` for the
// entity types), not the server's version: a copy trimmed to 1.21.4 alone threw in play, from the first boat or creature
// question (task review 2026-10-31; `brain --help` never calls them).
test("the trimmed minecraft-data also gives the newest registry the brain reads for boat recipes and entity types", () => {
  const touch = `const md = require("minecraft-data"); const d = md(md.supportedVersions.pc.at(-1)); console.log(JSON.stringify([Object.keys(d.entitiesByName).length, Object.keys(d.itemsByName).length, Object.keys(d.recipes).length]));`;
  const run = spawnSync(process.execPath, ["-e", touch], { cwd: appDir, encoding: "utf8" });
  const [entities, items, recipes] = JSON.parse(run.stdout.trim()) as [number, number, number];
  assert.ok(entities > 50 && items > 1000 && recipes > 500, run.stdout + run.stderr);
});

test("the trimmed minecraft-data holds only the touched files: no old Minecraft version's folder", () => {
  const data = appFiles().filter((file) => file.startsWith("node_modules/minecraft-data/"));
  assert.ok(data.includes(`node_modules/minecraft-data/minecraft-data/data/pc/${MINECRAFT_VERSION}/blocks.json`));
  assert.ok(data.includes("node_modules/minecraft-data/package.json") && data.includes("node_modules/minecraft-data/index.js"));
  assert.deepEqual(data.filter((file) => file.includes("/pc/1.8/")), [], "an old version's data was copied");
  assert.ok(data.length < 200, `${data.length} files`);
});

test("a Minecraft version with no data fails the build instead of shipping an empty folder", async () => {
  await assert.rejects(() => minecraftDataFiles(repoRoot, "9.99", process.execPath), /BUILD_MINECRAFT_DATA/u);
});

test("copyAssets copies the manifest, styles, personas, bun.exe and licence, and names a missing one", () => {
  const stage = mkdtempSync(join(tmpdir(), "assets-stage-"));
  const app = mkdtempSync(join(tmpdir(), "assets-app-"));
  const secondApp = mkdtempSync(join(tmpdir(), "assets-app2-"));
  try {
    for (const asset of APP_ASSETS) {
      const target = join(stage, asset);
      if (/\.[a-z]+$/iu.test(asset)) {
        mkdirSync(join(target, ".."), { recursive: true });
        writeFileSync(target, "x");
      } else {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "one.json"), "{}");
      }
    }
    copyAssets(stage, app);
    for (const asset of APP_ASSETS) assert.ok(existsSync(join(app, asset)), `${asset} was not copied`);
    rmSync(join(stage, "bun.exe"));
    assert.throws(() => copyAssets(stage, secondApp), /BUILD_MISSING.*bun\.exe/u);
  } finally {
    for (const folder of [stage, app, secondApp]) rmSync(folder, { recursive: true, force: true });
  }
});

test("the real pack ships THIRD-PARTY-NOTICES.txt in the app folder only, with the libraries, minecraft-data and Bun", () => {
  assert.equal(existsSync(join(repoRoot, "THIRD-PARTY-NOTICES.txt")), false, "the checkout must stay clean");
  assert.ok(appFiles().includes("THIRD-PARTY-NOTICES.txt"));
  const text = readFileSync(join(appDir, "THIRD-PARTY-NOTICES.txt"), "utf8");
  const titles = text.split("\n").filter((line) => line.startsWith("===== ")).map((line) => line.slice(6, -6));
  for (const name of ["mineflayer", "@modelcontextprotocol/sdk", "minecraft-data"]) assert.ok(titles.some((title) => title.startsWith(`${name}@`)), name);
  assert.ok(titles.filter((title) => title.startsWith("ajv@")).length >= 2, `both ajv versions: ${titles.filter((title) => title.startsWith("ajv@"))}`);
  assert.ok(titles.includes(`Bun ${bunVersionOfManifest()}`), "Bun");
  assert.ok(text.includes("JavaScriptCore"), "Bun's own licence text, which names JavaScriptCore");
  assert.ok(titles.length > 100, `${titles.length} sections`);
});

/** The Bun version the manifest pins, from its download URL (`bun-v<x.y.z>`). */
function bunVersionOfManifest(): string {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "packaging", "manifest.json"), "utf8")) as { bun: { url: string } };
  return /bun-v(\d+\.\d+\.\d+)\//u.exec(manifest.bun.url)![1]!;
}

test("the real repository packs into an app folder of under 300 files with no node_modules but minecraft-data and no source file", () => {
  // 11,034 files shipped before the bundle (10,282 under node_modules); measured now: 95 with bun.exe and one persona.
  const files = appFiles();
  assert.ok(files.length < 300, `${files.length} files`);
  assert.deepEqual(files.filter((file) => file.startsWith("node_modules/") && !file.startsWith("node_modules/minecraft-data/")), []);
  for (const entry of ENTRY_POINTS) assert.ok(files.includes(entry.replace(/\.ts$/u, ".js")), entry);
  for (const asset of CHECKOUT_ASSETS) assert.ok(files.some((file) => file === asset || file.startsWith(`${asset}/`)), asset);
  assert.deepEqual(files.filter((file) => file.endsWith(".ts")), [], "a source file shipped");
});
