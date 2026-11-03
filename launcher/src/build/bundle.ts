/**
 * The setup ships a built app, not the source tree with its `node_modules` (owner 2026-10-31: 11,034 files took 6.5 min to
 * copy): `bundleApp` turns the staged sources into a few `.js` files that keep the source layout, so every spawn path and
 * every `.ts`/`.js` sibling rule of the code stays right; `copyMinecraftData` and `copyAssets` add what cannot be bundled.
 * Run by `build-windows.ts` on the staged package (after `bun install --production`); `bundle.test.ts` runs it for real.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Programs a process of the package starts with `bun.exe <file>`, as repository paths; each is bundled to the same path with `.js`. */
export const ENTRY_POINTS = [
  "launcher/src/main.ts", // the Start-menu entry, the setup's `install` steps and the background launcher (`client.ts` spawns `start`)
  "src/server/host.ts", // one per bot, spawned by the launcher (`stack-bots.ts`)
  "brain/src/main.ts", // one per bot, spawned by the launcher (`stack-bots.ts`)
  "launcher/src/listener/main.ts", // the chat-command listener of a remote server (`spawn-listener.ts`)
  "src/server/runtime-process.ts", // the MCP runtime, spawned by the host as its sibling (`host.ts`)
] as const;

/**
 * Worker threads the runtime starts with `new Worker(new URL("./<name>.js", import.meta.url))`. A bundled module's
 * `import.meta.url` is its entry file's, so both are built into the folder of `runtime-process.js` and `host.js`, which
 * bundle the modules that start them (measured 2026-10-31 in `.agent/knowledge/facts/packaging.md`).
 */
export const WORKER_ENTRY_POINTS = ["src/bot-data/wal-checkpoint-worker.ts", "src/diagnostics/freeze-watch-worker.ts"] as const;
export const WORKER_FOLDER = "src/server";

/** Copied as they are from the stage: read at run time by path (`manifest.ts`, `styles.ts`), run (`bun.exe`) or given to the player. */
export const APP_ASSETS = ["packaging/manifest.json", "brain/building-styles", "personas", "bun.exe", "LICENSE"] as const;

const MINECRAFT_DATA_PACKAGE = "minecraft-data";
/** `minecraft-data` holds 446 MB for every Minecraft version behind lazy `require`s, so it stays out of the bundle. */
const EXTERNAL_PACKAGES = [MINECRAFT_DATA_PACKAGE];
const TOUCH_VERSION_VARIABLE = "MINE_AI_MINECRAFT_VERSION";
/**
 * Loads the data of the Minecraft version and every key it returns, and the same for the package's newest version (the brain
 * reads the newest registry for boat recipes and entity types: `brain/src/boats.ts`, `brain/src/skills.ts`), then lists the
 * package's files that `require` read. Run by `bun -e` in a folder whose `node_modules` holds the package.
 */
const TOUCH_SCRIPT = `
const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.join(process.cwd(), "touch.js"));
const minecraftData = req("${MINECRAFT_DATA_PACKAGE}");
for (const version of [process.env.${TOUCH_VERSION_VARIABLE}, minecraftData.supportedVersions.pc.at(-1)]) {
  const data = minecraftData(version);
  if (data === null || data === undefined) { console.error("no data for " + version); process.exit(2); }
  for (const key of Object.keys(data)) void data[key];
}
const root = path.dirname(req.resolve("${MINECRAFT_DATA_PACKAGE}/package.json"));
const files = Object.keys(req.cache).map((file) => path.relative(root, path.resolve(file))).filter((file) => !file.startsWith("..") && !path.isAbsolute(file));
console.log(JSON.stringify([...new Set([...files.map((file) => file.split(path.sep).join("/")), "package.json"])].sort()));
`;

/** One `Bun.build` of `entries` (repository paths) into `appDir`: at their own paths, or in `folder` when given. */
export async function bundleEntries(stageDir: string, appDir: string, entries: readonly string[], folder?: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: entries.map((entry) => join(stageDir, entry)),
    root: stageDir,
    outdir: appDir,
    target: "bun",
    external: EXTERNAL_PACKAGES,
    // Linked maps: Bun reads them, so a stack trace in a log names the source lines, not the bundle's.
    sourcemap: "linked",
    naming: { entry: folder === undefined ? "[dir]/[name].[ext]" : `${folder}/[name].[ext]` },
  });
  const errors = result.logs.filter((log) => log.level === "error");
  if (!result.success || errors.length > 0) {
    throw new Error(`[BUILD_BUNDLE] Bun could not bundle ${entries.join(", ")}: ${errors.map((log) => log.message).join("; ")}`);
  }
}

/** The program entry points and the workers, built into `appDir`. */
export async function bundleApp(stageDir: string, appDir: string): Promise<void> {
  await bundleEntries(stageDir, appDir, ENTRY_POINTS);
  await bundleEntries(stageDir, appDir, WORKER_ENTRY_POINTS, WORKER_FOLDER);
}

/** The files of the `minecraft-data` package under `folder`'s `node_modules` that loading the data of `version` reads, relative to the package. */
export async function minecraftDataFiles(folder: string, version: string, bunProgram: string): Promise<string[]> {
  const run = spawnSync(bunProgram, ["-e", TOUCH_SCRIPT], { cwd: folder, encoding: "utf8", env: { ...process.env, [TOUCH_VERSION_VARIABLE]: version } });
  if (run.status !== 0) {
    throw new Error(`[BUILD_MINECRAFT_DATA] Loading the Minecraft ${version} data from ${folder} failed (exit ${run.status}): ${`${run.stderr}${run.stdout}`.trim().slice(-400)}`);
  }
  const files = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as string[];
  if (!files.some((file) => file.includes(`/${version}/`))) {
    throw new Error(`[BUILD_MINECRAFT_DATA] Loading the Minecraft ${version} data read no file of its folder (read ${files.length} files): the list of files to ship would be empty.`);
  }
  return files;
}

/**
 * Copies the files `minecraftDataFiles` lists into `appDir/node_modules/minecraft-data`, then loads the data again from
 * that copy and requires the same list: a file the first load read only through a path the copy lacks fails here.
 */
export async function copyMinecraftData(stageDir: string, appDir: string, version: string, bunProgram: string): Promise<string[]> {
  const files = await minecraftDataFiles(stageDir, version, bunProgram);
  const from = join(stageDir, "node_modules", MINECRAFT_DATA_PACKAGE);
  const to = join(appDir, "node_modules", MINECRAFT_DATA_PACKAGE);
  for (const file of files) {
    mkdirSync(dirname(join(to, file)), { recursive: true });
    cpSync(join(from, file), join(to, file));
  }
  const again = await minecraftDataFiles(appDir, version, bunProgram);
  if (again.join("\n") !== files.join("\n")) {
    throw new Error(`[BUILD_MINECRAFT_DATA] The copy in ${to} reads other files than the original (${again.length} against ${files.length}).`);
  }
  return files;
}

/** The whole app folder the setup packs: the bundles, the trimmed Minecraft data and the assets, from the staged package. */
export async function packageApp(stageDir: string, appDir: string, minecraftVersion: string, bunProgram: string, assets: readonly string[] = APP_ASSETS): Promise<void> {
  await bundleApp(stageDir, appDir);
  await copyMinecraftData(stageDir, appDir, minecraftVersion, bunProgram);
  copyAssets(stageDir, appDir, assets);
}

/** `assets` (all of `APP_ASSETS` unless a test packs a checkout) from the stage into `appDir`; a missing one fails, so nothing ships half-built. */
export function copyAssets(stageDir: string, appDir: string, assets: readonly string[] = APP_ASSETS): void {
  for (const asset of assets) {
    if (!existsSync(join(stageDir, asset))) throw new Error(`[BUILD_MISSING] ${asset} is not in ${stageDir}.`);
    mkdirSync(dirname(join(appDir, asset)), { recursive: true });
    cpSync(join(stageDir, asset), join(appDir, asset), { recursive: true });
  }
}
