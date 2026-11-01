// One `node_modules` per lockfile on ext4, installed once in the background and shared by every scenario snapshot (spec D2, D4).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runBounded, type RunResult } from "./run-bounded.ts";

const TMP_NAME = /^(.+)\.tmp-(\d+)$/u;
/** The package a good install must leave: the one the client-ahead patch lands in. */
const PATCHED_PACKAGE = "mine-labs";

/** When a remembered install failure is forgotten: the failures are keyed by `modulesHash`, so exactly the inputs it covers, or a new daemon process. */
export const INSTALL_RETRY_CONDITION = "package.json, bun.lock or a patch changes, or the daemon restarts";

export interface ModulesPorts {
  run(command: string, args: readonly string[], options: { cwd: string; boundMs: number }): Promise<RunResult>;
  pidAlive(pid: number): boolean;
  now(): number;
}

export type ModulesState =
  | { readonly state: "ready"; readonly hash: string; readonly nodeModules: string }
  | { readonly state: "installing"; readonly hash: string }
  | { readonly state: "failed"; readonly hash: string; readonly reason: string };

/** Whether a process with this pid exists (EPERM: it exists, another user's). */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const REAL_PORTS: ModulesPorts = { run: runBounded, pidAlive: pidIsAlive, now: () => Date.now() };

/** Relative paths (forward slashes, sorted) of every file under `dir`; none when `dir` is missing. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split("\\").join("/"));
  return names.sort();
}

/** SHA-256 over `package.json`, `bun.lock` and every file under `patches/` (relative path and bytes): what decides the installed tree, nothing else. */
export function modulesHash(root: string): string {
  const hash = createHash("sha256");
  const inputs = ["package.json", "bun.lock", ...filesUnder(join(root, "patches")).map(name => `patches/${name}`)];
  for (const name of inputs) {
    const bytes = existsSync(join(root, name)) ? readFileSync(join(root, name)) : Buffer.alloc(0);
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

/** Marks a tree used now: the prune keeps what was used within its age limit. */
export function touchLastUsed(treeDir: string, nowMs: number): void {
  const file = join(treeDir, ".last-used");
  writeFileSync(file, "");
  utimesSync(file, nowMs / 1000, nowMs / 1000);
}

export class ModulesTrees {
  private readonly modulesDir: string;
  private readonly installs = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, string>();

  constructor(
    private readonly options: { readonly mirrorDir: string; readonly boundMs: number; readonly log: (line: string) => void },
    private readonly ports: ModulesPorts = REAL_PORTS,
  ) {
    this.modulesDir = join(options.mirrorDir, "modules");
  }

  /** Never waits for an install: ready, or the install it started (or one running), or the remembered failure. */
  modulesFor(root: string): ModulesState {
    const hash = modulesHash(root);
    const treeDir = join(this.modulesDir, hash);
    if (existsSync(join(treeDir, "node_modules"))) {
      touchLastUsed(treeDir, this.ports.now());
      return { state: "ready", hash, nodeModules: join(treeDir, "node_modules") };
    }
    const failure = this.failures.get(hash);
    if (failure !== undefined) return { state: "failed", hash, reason: failure };
    if (!this.installs.has(hash)) {
      const install = this.installInto(root, hash).finally(() => this.installs.delete(hash));
      this.installs.set(hash, install);
      // `installInto` runs up to its first await before this returns: an install that cannot start (the modules path cannot be made) has failed already, and "installing" would be untrue.
      const failedAtStart = this.failures.get(hash);
      if (failedAtStart !== undefined) return { state: "failed", hash, reason: failedAtStart };
    }
    return { state: "installing", hash };
  }

  /** Resolves when no install of this object runs (tests, the idle exit). */
  async settled(): Promise<void> {
    while (this.installs.size > 0) await Promise.allSettled([...this.installs.values()]);
  }

  /** Installs in `<hash>.tmp-<pid>` and renames it; any failure is remembered and logged once, and leaves no tmp. */
  private async installInto(root: string, hash: string): Promise<void> {
    const tmpDir = join(this.modulesDir, `${hash}.tmp-${process.pid}`);
    try {
      this.copyInputs(root, tmpDir);
      const result = await this.ports.run("bun", ["install", "--frozen-lockfile"], { cwd: tmpDir, boundMs: this.options.boundMs });
      const problem = this.problemOf(result, tmpDir);
      if (problem !== null) throw new Error(problem);
      this.publish(tmpDir, join(this.modulesDir, hash));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.failures.set(hash, reason);
      this.options.log(`node_modules install for ${root} (lockfile ${hash.slice(0, 12)}) failed: ${reason}; clients start from /mnt/d until ${INSTALL_RETRY_CONDITION}`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  private copyInputs(root: string, tmpDir: string): void {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    for (const name of ["package.json", "bun.lock", "patches"]) {
      if (existsSync(join(root, name))) cpSync(join(root, name), join(tmpDir, name), { recursive: true });
    }
  }

  /** Why a finished install is no tree to use, or null when it is one. */
  private problemOf(result: RunResult, tmpDir: string): string | null {
    if (result.timedOut) return `bun install did not end within ${this.options.boundMs / 1000} s`;
    if (result.code !== 0) return `bun install exited ${result.code}: ${result.stderrTail}`;
    if (!existsSync(join(tmpDir, "node_modules", PATCHED_PACKAGE))) return `bun install left no node_modules/${PATCHED_PACKAGE}`;
    return null;
  }

  /** Renames the tmp to the final directory; a final directory another daemon put there first is used instead (the caller deletes the tmp). */
  private publish(tmpDir: string, treeDir: string): void {
    if (existsSync(join(treeDir, "node_modules"))) return;
    try {
      renameSync(tmpDir, treeDir);
    } catch (error) {
      // The other daemon renamed between our check and our rename: its tree is the one to use.
      if (!existsSync(join(treeDir, "node_modules"))) throw error;
    }
  }
}

/** How a store of cached trees is pruned beyond its age: the entry `lastUsedMs` falls back to (default: the directory itself), and whether only dead processes' tmps go. */
export interface PruneStoreOptions {
  readonly fallbackFile?: string;
  readonly tmpsOnly?: boolean;
}

/** When a tree was last used: its `.last-used`, else `fallbackFile` of it, else the directory itself; null when another daemon's prune deleted it meanwhile. */
function lastUsedMs(treeDir: string, fallbackFile?: string): number | null {
  const marker = join(treeDir, ".last-used");
  const file = existsSync(marker) ? marker : fallbackFile ? join(treeDir, fallbackFile) : treeDir;
  try {
    return statSync(file).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Whether prune deletes this entry: a `<name>.tmp-<pid>` of a dead process, or a tree that is not kept and unused for `maxAgeMs`. */
function isStaleEntry(name: string, treeDir: string, keep: ReadonlySet<string>, maxAgeMs: number, ports: Pick<ModulesPorts, "pidAlive" | "now">, options: PruneStoreOptions): boolean {
  const tmp = TMP_NAME.exec(name);
  if (tmp) return !ports.pidAlive(Number(tmp[2]));
  if (options.tmpsOnly || keep.has(name)) return false;
  const nowMs = ports.now();
  const usedAt = lastUsedMs(treeDir, options.fallbackFile);
  return usedAt !== null && nowMs - usedAt > maxAgeMs;
}

/**
 * Deletes under `dir` (a store of `<key>/` trees): an entry not in `keep` and not used for `maxAgeMs`, and every `<name>.tmp-<pid>` whose process is
 * gone. Answers the names removed. No lock: every use touches `.last-used`, so a tree another daemon is about to use was used within `maxAgeMs` and stays.
 */
export function pruneStore(dir: string, keep: ReadonlySet<string>, maxAgeMs: number, options: PruneStoreOptions, ports: Pick<ModulesPorts, "pidAlive" | "now"> = REAL_PORTS): string[] {
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    const treeDir = join(dir, name);
    if (!isStaleEntry(name, treeDir, keep, maxAgeMs, ports, options)) continue;
    rmSync(treeDir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** `pruneStore` of `<mirror>/modules`: a tree whose hash is not in `linked` (read from every daemon's snapshots) and not used for `maxAgeMs`, and the dead processes' tmps. */
export async function pruneModules(mirrorDir: string, linked: ReadonlySet<string>, maxAgeMs: number, ports: ModulesPorts = REAL_PORTS): Promise<string[]> {
  return pruneStore(join(mirrorDir, "modules"), linked, maxAgeMs, {}, ports);
}
