// The scenario mirror: a snapshot of a submitter's worktree on ext4 for each submission's clients, held while a batch runs and pruned after (spec 2026-10-30-scenario-clients-ext4 D1, D3, D4, D5).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { INSTALL_RETRY_CONDITION, pidIsAlive, type ModulesState } from "./mirror-modules.ts";
import { runBounded, type RunResult } from "./run-bounded.ts";
import { ninePMountOf, rootSlug, sourceRootOf } from "./source-root.ts";

/** What a client never reads and what is not code; one list, so the sync's filters and the directories it skips never differ (the `.gitignore` rules come from the filter). */
export const SYNC_EXCLUDES: readonly string[] = [".git", "node_modules", ".agent", ".claude", ".tmp", ".mine-labs", ".minelabs", ".mine-ai"];

const SNAPSHOT_FILE = ".snapshot.json";
const MODULES_DIR_NAME = "modules";
/** In a daemon's snapshot directory: the pid of the daemon that owns it, so a later daemon's prune can tell a dead owner (S6, review 2026-11-01). */
const DAEMON_PID_FILE = ".daemon-pid";
/** A daemon directory with no pid file (left before the file existed) is an exited daemon's once its newest snapshot is this old. */
const UNRECORDED_DAEMON_MAX_AGE_MS = 86_400_000;
const GENERATION_NAME = /^g(\d+)$/u;
/** rsync's "some files vanished before they could be transferred" (an editor's temp file at an atomic save): the rest was copied (X1, 2026-10-31). */
const RSYNC_FILES_VANISHED = 24;
const CANCELLED_REASON = "the submission was cancelled during the sync";
/** The reason goes to the submitter's `info` line: only the end of rsync's stderr, where its error is. */
const STDERR_REASON_CHARS = 400;
/** A warm sync took 0.9 s and a cold one 9.9 s (X1, T5 2026-11-01): the submitter gets a "syncing" line only once the wait is felt, so a warm sync prints none. */
export const SLOW_SYNC_NOTICE_MS = 2_000;

export interface MirrorPorts {
  /** `runBounded`: the sync passes cwd = the root. */
  run(command: string, args: readonly string[], options: { cwd: string; boundMs: number; signal?: AbortSignal }): Promise<RunResult>;
  /** `/proc/mounts` text. */
  mounts(): string;
  /** `ModulesTrees.modulesFor`. */
  modulesFor(root: string): ModulesState;
  /** `pruneModules` bound to the mirror directory and its age limit. */
  pruneModules(linked: ReadonlySet<string>): Promise<string[]>;
  /** Epoch milliseconds from a monotonic clock, so a difference of two readings is a duration. */
  now(): number;
  /** Whether a process with this pid exists (`pidIsAlive`). */
  pidAlive(pid: number): boolean;
}

/** The ports that need nothing of the daemon; it adds `modulesFor` and `pruneModules`. */
export const realMirrorPorts: Pick<MirrorPorts, "run" | "mounts" | "now" | "pidAlive"> = {
  run: runBounded,
  mounts: () => readFileSync("/proc/mounts", "utf8"),
  now: () => performance.timeOrigin + performance.now(),
  pidAlive: pidIsAlive,
};

export type Snapshot = {
  readonly kind: "snapshot";
  readonly root: string;
  readonly dir: string;
  readonly generation: number;
  readonly syncMs: number;
  readonly startedAt: string;
  release(): void;
};
export type InPlace = {
  readonly kind: "in-place";
  readonly root: string;
  readonly reason: string;
  /** False when nothing failed and no clients start from the root: it is already on ext4, or the submitter left during the sync. */
  readonly fallback: boolean;
  release(): void;
};

interface SnapshotInfo { readonly root: string; readonly startedAt: string; readonly finishedAt: string; readonly modulesHash: string }
interface Generation { readonly dir: string; readonly number: number; readonly info: SnapshotInfo | null }

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readTextOrEmpty(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** The snapshot's `.snapshot.json`, or null when it is missing or not a whole record: such a `g<n>` is unfinished and never used. */
function readSnapshotInfo(dir: string): SnapshotInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SNAPSHOT_FILE), "utf8")) as Partial<Record<keyof SnapshotInfo, unknown>>;
    const { root, startedAt, finishedAt, modulesHash } = parsed;
    if (typeof root !== "string" || typeof startedAt !== "string" || typeof finishedAt !== "string" || typeof modulesHash !== "string") return null;
    return { root, startedAt, finishedAt, modulesHash };
  } catch {
    return null;
  }
}

/** Every `g<n>` directory of one root, oldest first. */
function generationsOf(rootDir: string): Generation[] {
  const found: Generation[] = [];
  for (const name of safeReaddir(rootDir)) {
    const match = GENERATION_NAME.exec(name);
    if (match) found.push({ dir: join(rootDir, name), number: Number(match[1]), info: readSnapshotInfo(join(rootDir, name)) });
  }
  return found.sort((a, b) => a.number - b.number);
}

function newestCompleteOf(rootDir: string): Generation | null {
  return generationsOf(rootDir).filter(generation => generation.info !== null).at(-1) ?? null;
}

/** The directories the sync takes one rsync each: the root's own, minus the excluded names; a symlink is no directory (the root-files rsync copies it as a link). */
function topLevelDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !SYNC_EXCLUDES.includes(entry.name))
    .map(entry => entry.name)
    .sort();
}

/** rsync reads `*`, `?`, `[` and `\` in a pattern as wildcards; a directory name must match as itself. */
function escapeRsyncPattern(name: string): string {
  return name.replace(/[\\*?[]/gu, "\\$&");
}

/**
 * One process of the parallel sync, on the whole root: the same filters in every process (so the root `.gitignore`'s anchored rules and the dot directories come out
 * as in one rsync), then the pair that narrows it to `directory`, or, for null, to the root's own files. `--modify-window=-1` compares mtimes to the nanosecond:
 * plain `--link-dest` hardlinked a same-size rewrite of the same second to the old bytes (X1, 2026-10-31).
 */
function rsyncArgsFor(directory: string | null, root: string, target: string, linkDest: string | null): string[] {
  const narrowing = directory === null ? ["--exclude=/*/"] : [`--include=/${escapeRsyncPattern(directory)}/`, "--exclude=/*"];
  return [
    "-a", "--filter=:- .gitignore", ...SYNC_EXCLUDES.map(name => `--exclude=${name}`), "--modify-window=-1",
    ...(linkDest === null ? [] : [`--link-dest=${linkDest}`]), ...narrowing, `${root}/`, `${target}/`,
  ];
}

/** The root directories (`<root slug>/`) of one daemon directory: everything in it but the daemon's pid file. */
function rootDirectoriesOf(daemonDir: string): string[] {
  return safeReaddir(daemonDir).filter(name => name !== DAEMON_PID_FILE).map(name => join(daemonDir, name));
}

/** The `modulesHash` of every snapshot of every daemon: the node_modules trees prune must keep. */
function linkedModulesHashes(mirrorDir: string): Set<string> {
  const daemonDirs = safeReaddir(mirrorDir).filter(name => name !== MODULES_DIR_NAME).map(name => join(mirrorDir, name));
  const rootDirs = daemonDirs.flatMap(rootDirectoriesOf);
  const infos = rootDirs.flatMap(rootDir => generationsOf(rootDir).map(generation => generation.info));
  return new Set(infos.flatMap(info => (info === null ? [] : [info.modulesHash])));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Why a finished rsync process is a failure; code -1 with no kill flag means it never ran to an exit code (a missing command, a signal from outside). */
function describeRsyncFailure(result: RunResult): string {
  const tail = result.stderrTail.slice(-STDERR_REASON_CHARS);
  const detail = tail === "" ? "" : `: ${tail}`;
  return result.code === -1 ? `rsync did not run to an exit code (is rsync installed?)${detail}` : `rsync exited ${result.code}${detail}`;
}

/** Resolves when `previous` settles or `signal` aborts, whichever comes first, and leaves no listener on the signal after `previous`. */
function untilSettledOrAborted(previous: Promise<unknown>, signal: AbortSignal | undefined): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

export function snapshotCwd(snapshot: Snapshot, clientCwd: string): string {
  return join(snapshot.dir, relative(snapshot.root, clientCwd));
}

export class ScenarioMirror {
  private readonly rootsDir: string;
  /** One promise chain per root: syncs of one root run in order, each linked to the one before. */
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly holds = new Map<string, number>();
  private readonly syncing = new Set<string>();

  constructor(
    private readonly options: { readonly mirrorDir: string; readonly daemonSlug: string; readonly enabled: boolean; readonly syncBoundMs: number; readonly slowSyncNoticeMs?: number; readonly log: (line: string) => void },
    private readonly ports: MirrorPorts,
  ) {
    this.rootsDir = join(options.mirrorDir, options.daemonSlug);
  }

  /** A snapshot of the source root of `clientCwd` (held until `release`), or the reason the clients start from where they are. Never throws. `notify` gets one line when the sync is slow. */
  async acquire(clientCwd: string, signal?: AbortSignal, notify?: (line: string) => void): Promise<Snapshot | InPlace> {
    const root = sourceRootOf(clientCwd);
    if (root === null) return this.inPlace(clientCwd, `no bun.lock above ${clientCwd}`);
    if (!ninePMountOf(root, this.ports.mounts())) return this.inPlace(root, `${root} is already on ext4`, false);
    if (!this.options.enabled) return this.inPlace(root, "the mirror is off (MINE_AI_SCENARIO_MIRROR=0)");
    const modules = this.ports.modulesFor(root);
    if (modules.state === "installing") {
      return this.inPlace(root, `node_modules for ${root} is being installed on ext4 (lockfile ${modules.hash.slice(0, 12)}); the next submission after it is done gets a snapshot`);
    }
    if (modules.state === "failed") return this.inPlace(root, `node_modules install for ${root} failed: ${modules.reason} (tried again when ${INSTALL_RETRY_CONDITION})`);
    const stopNotice = this.noticeWhenSlow(root, signal, notify);
    try {
      return await this.afterPreviousSyncOf(root, signal, () => this.sync(root, modules.nodeModules, modules.hash, signal));
    } finally {
      stopNotice();
    }
  }

  /** Tells `notify` once that a sync is under way if the answer takes longer than `slowSyncNoticeMs`; the submitter who left or an answer that came first hears nothing. Returns the call that cancels it. */
  private noticeWhenSlow(root: string, signal: AbortSignal | undefined, notify: ((line: string) => void) | undefined): () => void {
    if (notify === undefined) return () => {};
    const timer = setTimeout(() => {
      if (signal?.aborted !== true) notify(`syncing ${root} to the client mirror ...`);
    }, this.options.slowSyncNoticeMs ?? SLOW_SYNC_NOTICE_MS);
    return () => clearTimeout(timer);
  }

  /** Deletes what this daemon's snapshots no longer need and every directory of an exited daemon, then asks for the modules trees no snapshot links. */
  async prune(): Promise<void> {
    this.recordOwnPid();
    this.pruneExitedDaemons();
    for (const rootDir of rootDirectoriesOf(this.rootsDir)) this.pruneRootDirectory(rootDir);
    await this.ports.pruneModules(linkedModulesHashes(this.options.mirrorDir));
  }

  /** Written to a temp name and renamed like `.snapshot.json`; a mirror that is off writes nothing. A failure is logged; a pid file an earlier daemon of this socket left stays, so a later daemon's prune may delete this directory. */
  private recordOwnPid(): void {
    if (!this.options.enabled) return;
    try {
      mkdirSync(this.rootsDir, { recursive: true });
      const file = join(this.rootsDir, DAEMON_PID_FILE);
      writeFileSync(`${file}.tmp`, String(process.pid));
      renameSync(`${file}.tmp`, file);
    } catch (error) {
      this.options.log(`could not record this daemon's pid in ${this.rootsDir}: ${describeError(error)}`);
    }
  }

  /** Deletes the directory of every other daemon whose recorded pid is dead, so its trees fall out of `linkedModulesHashes`; a live pid (even a reused one) keeps it. */
  private pruneExitedDaemons(): void {
    for (const name of safeReaddir(this.options.mirrorDir)) {
      const daemonDir = join(this.options.mirrorDir, name);
      if (name === MODULES_DIR_NAME || daemonDir === this.rootsDir) continue;
      if (this.isExitedDaemon(daemonDir)) this.removeTree(daemonDir);
    }
  }

  private isExitedDaemon(daemonDir: string): boolean {
    const recorded = Number(readTextOrEmpty(join(daemonDir, DAEMON_PID_FILE)));
    if (Number.isInteger(recorded) && recorded > 0) return !this.ports.pidAlive(recorded);
    const finishedAt = rootDirectoriesOf(daemonDir).flatMap(rootDir => newestCompleteOf(rootDir)?.info?.finishedAt ?? []).sort().at(-1);
    return finishedAt !== undefined && this.ports.now() - Date.parse(finishedAt) > UNRECORDED_DAEMON_MAX_AGE_MS;
  }

  private inPlace(root: string, reason: string, fallback = true): InPlace {
    this.options.log(fallback ? `clients start from ${root} itself: ${reason}` : `${root}: ${reason}`);
    return { kind: "in-place", root, reason, fallback, release: () => {} };
  }

  /**
   * Runs `job` once the previous sync of `root` has ended, or at once when `signal` aborts first (the job then answers cancelled without syncing).
   * The chain's tail still waits for the previous sync too, so a cancelled acquire never lets the next one overtake a running sync.
   */
  private afterPreviousSyncOf<T>(root: string, signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(root) ?? Promise.resolve();
    const result = untilSettledOrAborted(previous, signal).then(job);
    const tail = Promise.allSettled([previous, result]).then(() => undefined);
    this.chains.set(root, tail);
    void tail.then(() => { if (this.chains.get(root) === tail) this.chains.delete(root); });
    return result;
  }

  /** Makes `g<n>`, syncs into it, links the modules tree, writes `.snapshot.json` last; any failure deletes the `g<n>` and answers in-place with the reason. */
  private async sync(root: string, nodeModules: string, modulesHash: string, signal: AbortSignal | undefined): Promise<Snapshot | InPlace> {
    if (signal?.aborted) return this.inPlace(root, CANCELLED_REASON, false);
    const rootDir = join(this.rootsDir, rootSlug(root));
    const generation = (generationsOf(rootDir).at(-1)?.number ?? 0) + 1;
    const dir = join(rootDir, `g${generation}`);
    const startedAtMs = this.ports.now();
    this.syncing.add(dir);
    try {
      mkdirSync(dir, { recursive: true });
      const failure = await this.runParallelRsync(root, dir, newestCompleteOf(rootDir)?.dir ?? null, signal);
      if (failure !== null) {
        this.removeTree(dir);
        // A submitter who left needs no fallback line: no clients start anywhere.
        return this.inPlace(root, failure, signal?.aborted !== true);
      }
      const syncMs = Math.round(this.ports.now() - startedAtMs);
      symlinkSync(nodeModules, join(dir, "node_modules"));
      const startedAt = new Date(startedAtMs).toISOString();
      this.writeSnapshotInfo(dir, { root, startedAt, finishedAt: new Date(this.ports.now()).toISOString(), modulesHash });
      this.sweep(rootDir);
      this.holds.set(dir, 1);
      this.options.log(`snapshot g${generation} of ${root} synced in ${syncMs} ms (started ${startedAt})`);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.release(rootDir, dir);
      };
      return { kind: "snapshot", root, dir, generation, syncMs, startedAt, release };
    } catch (error) {
      this.removeTree(dir);
      return this.inPlace(root, `the snapshot of ${root} could not be made: ${describeError(error)}`);
    } finally {
      this.syncing.delete(dir);
    }
  }

  /** All the rsync processes at once; the first failure, the shared bound or the caller's signal kills every one still running. Answers the failure's reason or null. */
  private async runParallelRsync(root: string, target: string, linkDest: string | null, signal: AbortSignal | undefined): Promise<string | null> {
    const { syncBoundMs } = this.options;
    const everyProcess = new AbortController();
    const outcome: { failure: string | null } = { failure: null };
    const fail = (reason: string): void => {
      if (outcome.failure !== null) return;
      outcome.failure = reason;
      everyProcess.abort();
    };
    const boundTimer = setTimeout(() => fail(`the sync did not end within ${syncBoundMs / 1000} s`), syncBoundMs);
    const onCallerAbort = (): void => fail(CANCELLED_REASON);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      const processes = [null, ...topLevelDirectories(root)].map(directory => rsyncArgsFor(directory, root, target, linkDest));
      await Promise.all(processes.map(args => this.runOneRsync(args, root, everyProcess.signal, fail)));
    } finally {
      clearTimeout(boundTimer);
      signal?.removeEventListener("abort", onCallerAbort);
    }
    return outcome.failure;
  }

  private async runOneRsync(args: readonly string[], root: string, signal: AbortSignal, fail: (reason: string) => void): Promise<void> {
    try {
      const result = await this.ports.run("rsync", args, { cwd: root, boundMs: this.options.syncBoundMs, signal });
      if (result.timedOut) fail(`the sync did not end within ${this.options.syncBoundMs / 1000} s`);
      else if (!result.aborted && result.code !== 0 && result.code !== RSYNC_FILES_VANISHED) fail(describeRsyncFailure(result));
    } catch (error) {
      fail(`rsync could not run: ${describeError(error)}`);
    }
  }

  /** Written to a temp name and renamed, so another daemon's prune never reads a half-written record. */
  private writeSnapshotInfo(dir: string, info: SnapshotInfo): void {
    writeFileSync(join(dir, `${SNAPSHOT_FILE}.tmp`), JSON.stringify(info));
    renameSync(join(dir, `${SNAPSHOT_FILE}.tmp`), join(dir, SNAPSHOT_FILE));
  }

  private release(rootDir: string, dir: string): void {
    const remaining = (this.holds.get(dir) ?? 0) - 1;
    if (remaining > 0) {
      this.holds.set(dir, remaining);
      return;
    }
    this.holds.delete(dir);
    this.sweep(rootDir);
  }

  /** Deletes a directory tree; one that cannot be deleted (a file still being written, a permission) is logged and left for the next prune, never thrown into a submission or the daemon's start. */
  private removeTree(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      this.options.log(`could not delete ${dir}: ${describeError(error)}; the next prune tries again`);
    }
  }

  private isInUse(dir: string): boolean {
    return this.holds.has(dir) || this.syncing.has(dir);
  }

  /** Deletes every complete snapshot of the root that no submission holds, except the newest: it is the next sync's `--link-dest`. */
  private sweep(rootDir: string): void {
    const complete = generationsOf(rootDir).filter(generation => generation.info !== null);
    for (const generation of complete.slice(0, -1)) {
      if (!this.isInUse(generation.dir)) this.removeTree(generation.dir);
    }
  }

  private pruneRootDirectory(rootDir: string): void {
    const generations = generationsOf(rootDir);
    const newestRoot = newestCompleteOf(rootDir)?.info?.root;
    if (newestRoot !== undefined && !existsSync(newestRoot) && !generations.some(generation => this.isInUse(generation.dir))) {
      this.removeTree(rootDir);
      return;
    }
    for (const generation of generations) {
      if (generation.info === null && !this.isInUse(generation.dir)) this.removeTree(generation.dir);
    }
    this.sweep(rootDir);
    if (safeReaddir(rootDir).length === 0) this.removeTree(rootDir);
  }
}
