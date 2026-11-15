// The daemon's directory of RAM roots (spec 2026-11-15-scenario-disk-stalls 3.1): `<worldRamDir>/mine-ai-worlds-<8 hex of sha1(socket)>`, keyed on the socket as the pid
// file is, with an `owner.json` so a later daemon can tell a dead daemon's worlds (removed: tmpfs is RAM, nothing else frees it) from a living one's (never touched).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ScenarioServerConfig } from "./config.ts";

const DIR_PREFIX = "mine-ai-worlds-";
const OWNER_FILE = "owner.json";
const HASH_HEX_CHARS = 8;
/** The process name (`ps -o comm=`) of a daemon: it runs as `bun daemon.ts`. */
const DAEMON_COMM = "bun";

/** The directory this daemon's RAM roots live in, and its removal at the daemon's stop. */
export interface WorldRamDir {
  readonly dir: string;
  remove(): Promise<void>;
}

/**
 * The scheduler's `worldMbFor`: the MB a new lane server's world takes in RAM (the template's size, as the daemon already read it) when the daemon has a
 * RAM dir; 0 without one, as the roots are then on disk and nothing is reserved. A server whose copy then gets no room or no template releases it at once (`onWorldCopied`).
 */
export function ramWorldMbFor(ram: WorldRamDir | null, templates: { worldMbKnown(version: string): number }): (version: string) => number {
  return version => (ram ? templates.worldMbKnown(version) : 0);
}

export function worldRamDirName(socketPath: string): string {
  return `${DIR_PREFIX}${createHash("sha1").update(socketPath).digest("hex").slice(0, HASH_HEX_CHARS)}`;
}

/** Whether `pid` is a `bun` process: what `ps -p <pid> -o comm=` shows, read from where `ps` reads it. A reused pid of another program is not a daemon. */
export async function isBunProcess(pid: number): Promise<boolean> {
  return (await readFile(`/proc/${pid}/comm`, "utf8").catch(() => "")).trim() === DAEMON_COMM;
}

/** The pid in a dir's `owner.json`; null when the file is missing or unreadable. */
async function ownerPidOf(dir: string): Promise<number | null> {
  try {
    const pid = (JSON.parse(await readFile(join(dir, OWNER_FILE), "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * A daemon makes its dir under this name (its pid ends it), writes the owner file in it and renames it into place: `mine-ai-worlds-*` never exists without its
 * owner file, so another daemon's sweep cannot take a dir that is being made for a dead one (task review 2026-11-15 B2). The leading dot keeps it out of the
 * finished dirs' filter; a staging dir of a dead pid is swept like a dead daemon's dir.
 */
const STAGING_PREFIX = `.${DIR_PREFIX}`;

function stagingNameOf(dirName: string, pid: number): string {
  return `.${dirName}.${pid}.tmp`;
}

/** The pid that owns the dir `name` of `base`: the one in its `owner.json`, or the one a staging name ends with; null when there is none. */
async function ownerOf(base: string, name: string): Promise<number | null> {
  if (!name.startsWith(STAGING_PREFIX)) return ownerPidOf(join(base, name));
  const pid = /\.(\d+)\.tmp$/u.exec(name)?.[1];
  return pid === undefined ? null : Number(pid);
}

/**
 * Removes every `mine-ai-worlds-*` dir of `base` (and staging dir) whose owner is not a living daemon (this daemon's own dir from an earlier run included; no
 * readable owner file counts as dead). Leaves a living owner's dir alone; when that is `ownDir` itself, says by whom. `removed` names the other finished dirs it removed.
 */
async function sweepDeadWorldDirs(base: string, ownDir: string, isLive: (pid: number) => Promise<boolean>): Promise<{ readonly removed: string[]; readonly ownDirHeldBy: number | null }> {
  const removed: string[] = [];
  for (const name of (await readdir(base)).filter(entry => entry.startsWith(DIR_PREFIX) || entry.startsWith(STAGING_PREFIX))) {
    const path = join(base, name);
    const owner = await ownerOf(base, name);
    if (owner !== null && await isLive(owner)) {
      if (path === ownDir) return { removed, ownDirHeldBy: owner };
      continue;
    }
    await rm(path, { recursive: true, force: true });
    if (path !== ownDir && !name.startsWith(STAGING_PREFIX)) removed.push(name);
  }
  return { removed, ownDirHeldBy: null };
}

/** Makes `dir` with its owner file in it in one step (staging dir, then `rename`); a failure removes the staging dir and throws. */
async function makeDirWithOwner(base: string, dir: string, socketPath: string): Promise<void> {
  const staging = join(base, stagingNameOf(basename(dir), process.pid));
  try {
    await mkdir(staging, { recursive: true });
    await writeFile(join(staging, OWNER_FILE), `${JSON.stringify({ socketPath, pid: process.pid })}\n`);
    await rename(staging, dir);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Makes this daemon's RAM dir with its owner file, after removing every `mine-ai-worlds-*` dir whose owner is not a living daemon (a dead daemon's, its own
 * from an earlier run, one with no readable owner file); a dir with a living owner is never touched. Null (the caller starts disk roots, the log says why)
 * when another living daemon holds this socket's dir or the RAM dir cannot be made: a RAM dir costs the RAM worlds, never the daemon.
 */
export async function prepareWorldRamDir(input: {
  readonly config: ScenarioServerConfig;
  readonly socketPath: string;
  readonly log: (message: string) => void;
  /** Whether a pid is a living daemon; the real check by default. */
  readonly isLive?: (pid: number) => Promise<boolean>;
}): Promise<WorldRamDir | null> {
  const { config, socketPath, log } = input;
  const base = config.worldRamDir;
  const dir = join(base, worldRamDirName(socketPath));
  try {
    await mkdir(base, { recursive: true });
    const swept = await sweepDeadWorldDirs(base, dir, input.isLive ?? isBunProcess);
    if (swept.ownDirHeldBy !== null) {
      log(`worlds on disk: ${dir} is held by a living daemon (pid ${swept.ownDirHeldBy})`);
      return null;
    }
    if (swept.removed.length > 0) log(`removed ${swept.removed.length} RAM world dir${swept.removed.length === 1 ? "" : "s"} of dead daemons: ${swept.removed.join(", ")}`);
    await makeDirWithOwner(base, dir, socketPath);
  } catch (error) {
    log(`worlds on disk: the RAM dir ${dir} could not be made: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
