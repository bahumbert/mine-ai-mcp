import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

/**
 * Creates the folder `file` goes in. For a path a person or the setup gives, which may be a bare name: `dirname("x.json")`
 * is `"."`, and Windows Bun 1.4.2 throws `EEXIST` on `mkdirSync(".", { recursive: true })` (and `".."`), so the folder is
 * made from the absolute path. A path built under the data root (`join(root, ...)`) is never bare and needs no helper.
 */
export function ensureParentDir(file: string): void {
  mkdirSync(dirname(resolve(file)), { recursive: true });
}

/** Names the data folder when set; wins over the setup's file (tests, a second install on one PC). */
export const DATA_ROOT_ENV = "MINE_AI_DATA_ROOT";
/** One line in the app folder: the data folder the player chose in the setup. A checkout has none. */
export const DATA_ROOT_FILE = "data-root.txt";

/**
 * The folder holding the player's data (settings, personas, bot data, server, logs, run files): `MINE_AI_DATA_ROOT`,
 * else the folder the setup wrote in `data-root.txt` (`marker`), else on Windows `%LOCALAPPDATA%\MineAI` and elsewhere
 * `$XDG_DATA_HOME/mine-ai`, else `~/.local/share/mine-ai`. The only place that decides it: every other module takes
 * the root as an argument. Paths are built in the target platform's style, so the test of a Windows root passes on Linux.
 */
export function dataRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  marker: string | null | (() => string | null) = () => readDataRootFile(appRoot(), readFileSync, platform),
): string {
  if (env[DATA_ROOT_ENV]) return env[DATA_ROOT_ENV];
  // read only now: a broken file must not stop a run whose environment names the folder
  const chosen = typeof marker === "function" ? marker() : marker;
  if (chosen !== null) return chosen;
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "MineAI");
  return posix.join(env.XDG_DATA_HOME || posix.join(home, ".local", "share"), "mine-ai");
}

/**
 * The folder the setup chose, or null when the app folder has no `data-root.txt`. An empty or relative value throws:
 * falling back to the default would show the player an empty install while their data sits elsewhere.
 */
export function readDataRootFile(app: string, read: (path: string) => Buffer = readFileSync, platform: NodeJS.Platform = process.platform): string | null {
  const file = join(app, DATA_ROOT_FILE);
  let text: string;
  try {
    text = read(file).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const folder = text.replace(/^﻿/u, "").trim();
  if (folder === "" || !(platform === "win32" ? win32 : posix).isAbsolute(folder)) {
    throw new Error(`${file} does not hold an absolute folder ("${folder}"); write the full path of your data folder in it, or reinstall Mine AI.`);
  }
  return folder;
}

/**
 * The file a child process runs for a source entry (`src/server/host.ts`, from the app root): the `.ts` in a checkout,
 * the `.js` of the same path in the setup's bundle (`bundle.ts` keeps the source layout). The launcher runs bundled
 * exactly when this module is a `.js` file.
 */
export function appEntry(app: string, sourcePath: string, bundled: boolean = import.meta.path.endsWith(".js")): string {
  return join(app, ...(bundled ? sourcePath.replace(/\.ts$/u, ".js") : sourcePath).split("/"));
}

/** The folder holding `launcher/` (the installed app, or the checkout in development). */
export function appRoot(): string {
  return resolve(import.meta.dir, "..", "..");
}
