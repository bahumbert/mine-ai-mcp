import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { type MirrorPorts, SYNC_EXCLUDES, snapshotCwd } from "./mirror.ts";
import { makeMirror, makeSourceRoot, rootDirOf, withTemp, write } from "./mirror-fixtures.ts";
import type { RunResult } from "./run-bounded.ts";

interface Call {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly boundMs: number;
  readonly signal: AbortSignal | undefined;
  /** The `--include=/<dir>/` value of the call, null for the call that takes the root's own files. */
  readonly include: string | null;
  readonly source: string;
  readonly target: string;
}

const OK: RunResult = { code: 0, stderrTail: "" };

/** A `run` that records each call and answers `answer` (exit 0 by default). */
function recordingRun(answer: (call: Call) => Promise<RunResult> | RunResult = () => OK) {
  const calls: Call[] = [];
  const run: MirrorPorts["run"] = (command, args, options) => {
    assert.equal(command, "rsync");
    const call: Call = {
      args,
      cwd: options.cwd,
      boundMs: options.boundMs,
      signal: options.signal,
      include: args.find(arg => arg.startsWith("--include="))?.slice("--include=".length) ?? null,
      source: args.at(-2)!,
      target: args.at(-1)!,
    };
    calls.push(call);
    return Promise.resolve(answer(call));
  };
  return { calls, run };
}

/** Resolves as aborted when the call's signal aborts, like a child killed with its group. */
function untilAborted(call: Call): Promise<RunResult> {
  return new Promise(resolve => {
    if (call.signal?.aborted) resolve({ code: -1, stderrTail: "", aborted: true });
    call.signal?.addEventListener("abort", () => resolve({ code: -1, stderrTail: "", aborted: true }), { once: true });
  });
}

function generationsOf(rootDir: string): string[] {
  return existsSync(rootDir) ? readdirSync(rootDir).filter(name => /^g\d+$/u.test(name)).sort() : [];
}

function listing(dir: string, skip: readonly string[] = []): string[] {
  return readdirSync(dir, { recursive: true }).map(String).filter(name => !skip.some(skipped => name === skipped || name.startsWith(`${skipped}/`))).sort();
}

async function acquireSnapshot(mirror: ReturnType<typeof makeMirror>["mirror"], cwd: string) {
  const result = await mirror.acquire(cwd);
  assert.equal(result.kind, "snapshot", result.kind === "in-place" ? result.reason : "");
  if (result.kind !== "snapshot") throw new Error("not a snapshot");
  return result;
}

test("a snapshot holds the root's files, node_modules is a link to the modules tree, .snapshot.json names the root and the lockfile hash", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror, mirrorDir, nodeModules, lines } = makeMirror(dir);
  const cwd = join(root, "tests", "minecraft");
  const snapshot = await acquireSnapshot(mirror, cwd);
  assert.equal(snapshot.dir, join(rootDirOf(mirrorDir, root), "g1"));
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.root, root);
  assert.equal(readFileSync(join(snapshot.dir, "src", "a.ts"), "utf8"), "export const a = 1;");
  assert.equal(lstatSync(join(snapshot.dir, "node_modules")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(snapshot.dir, "node_modules")), nodeModules);
  const info = JSON.parse(readFileSync(join(snapshot.dir, ".snapshot.json"), "utf8")) as Record<string, string>;
  assert.equal(info.root, root);
  assert.equal(info.modulesHash, "hash-1");
  assert.match(info.startedAt!, /^\d{4}-\d\d-\d\dT/u);
  assert.match(info.finishedAt!, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(snapshot.startedAt, info.startedAt);
  assert.equal(snapshotCwd(snapshot, cwd), join(snapshot.dir, "tests", "minecraft"), "snapshotCwd keeps the path inside the root");
  assert.match(lines.join("\n"), /snapshot g1 of .*synced in \d+ ms/u);
  snapshot.release();
}));

test("excludes: .git, .claude/worktrees, node_modules, .tmp, .agent, a .gitignore'd file are absent, tracked files stay", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  for (const name of SYNC_EXCLUDES) write(join(root, name, "inner", "x.txt"), "x");
  write(join(root, ".claude", "worktrees", "other", "a.ts"), "x");
  write(join(root, ".gitignore"), "*.log\n");
  write(join(root, "src", "debug.log"), "ignored");
  const { mirror } = makeMirror(dir);
  const snapshot = await acquireSnapshot(mirror, root);
  const names = listing(snapshot.dir);
  for (const absent of [...SYNC_EXCLUDES.filter(name => name !== "node_modules"), ".claude/worktrees/other/a.ts", "src/debug.log"]) {
    assert.ok(!names.includes(absent) && !names.some(name => name.startsWith(`${absent}/`)), `${absent} is not in the snapshot`);
  }
  assert.ok(names.includes("src/a.ts") && names.includes(".gitignore"), "tracked files stay");
  assert.equal(existsSync(join(snapshot.dir, "node_modules", "mine-labs")), true, "node_modules is the modules tree, not the root's");
}));

test("a second acquire after an edit links unchanged files (same inode), copies a same-size rewrite and a new file, and the first snapshot, still held by a running batch, keeps the old tree (Review focus 1, X1 change test)", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror } = makeMirror(dir);
  const first = await acquireSnapshot(mirror, root);
  write(join(root, "src", "a.ts"), "export const a = 2;");
  write(join(root, "src", "new-file.ts"), "export const fresh = true;");
  const second = await acquireSnapshot(mirror, root);
  assert.equal(second.generation, 2);
  assert.equal(statSync(join(second.dir, "src", "b.ts")).ino, statSync(join(first.dir, "src", "b.ts")).ino, "an unchanged file is a hardlink");
  assert.notEqual(statSync(join(second.dir, "src", "a.ts")).ino, statSync(join(first.dir, "src", "a.ts")).ino);
  assert.equal(readFileSync(join(first.dir, "src", "a.ts"), "utf8"), "export const a = 1;");
  assert.equal(readFileSync(join(second.dir, "src", "a.ts"), "utf8"), "export const a = 2;");
  assert.equal(existsSync(join(second.dir, "src", "new-file.ts")), true);
  assert.equal(existsSync(join(first.dir, "src", "new-file.ts")), false);
}));

test("the parallel snapshot equals one serial rsync of the root (nested dir, dot dir, anchored .gitignore rule, root file, top-level symlink, glob-named dir)", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  write(join(root, ".gitignore"), "*.log\n/a/b\n");
  write(join(root, "a", "b", "f"), "dropped by the anchored rule");
  write(join(root, "a", "g"), "kept");
  write(join(root, "c", "a", "b", "f"), "kept: the rule is anchored to the root");
  write(join(root, ".github", "workflows", "x.yml"), "kept");
  write(join(root, "top.txt"), "kept");
  write(join(root, "top.log"), "ignored");
  write(join(root, "[odd]*dir", "f"), "a glob-looking directory name");
  symlinkSync("src", join(root, "link-to-src"));
  const serial = join(dir, "serial");
  mkdirSync(serial);
  const filters = ["--filter=:- .gitignore", ...SYNC_EXCLUDES.map(name => `--exclude=${name}`)];
  const reference = spawnSync("rsync", ["-a", "--modify-window=-1", ...filters, `${root}/`, `${serial}/`]);
  assert.equal(reference.status, 0);
  const { mirror } = makeMirror(dir);
  const snapshot = await acquireSnapshot(mirror, root);
  assert.deepEqual(listing(snapshot.dir, ["node_modules", ".snapshot.json"]), listing(serial));
  const names = listing(snapshot.dir);
  assert.ok(!names.includes("a/b/f") && names.includes("c/a/b/f") && names.includes("a/g"), "the anchored rule drops only the root's a/b");
  assert.ok(names.includes(".github/workflows/x.yml") && names.includes("[odd]*dir/f"));
  assert.equal(lstatSync(join(snapshot.dir, "link-to-src")).isSymbolicLink(), true, "a top-level symlink is copied as a link");
}));

test("one rsync per top-level directory plus one for the root's files, none for an excluded name or a symlink, each with the change test", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  for (const name of SYNC_EXCLUDES) mkdirSync(join(root, name), { recursive: true });
  symlinkSync("src", join(root, "link-to-src"));
  const existedAtStart: boolean[] = [];
  const { calls, run } = recordingRun(call => { existedAtStart.push(existsSync(call.target)); return OK; });
  const { mirror } = makeMirror(dir, { run });
  const snapshot = await acquireSnapshot(mirror, root);
  assert.deepEqual(calls.map(call => call.include ?? "(root files)").sort(), ["(root files)", "/src/", "/tests/"]);
  assert.deepEqual(existedAtStart, [true, true, true], "g<n> is made before any rsync starts (racing rsyncs fail with File exists)");
  for (const call of calls) {
    assert.equal(call.cwd, root);
    assert.equal(call.source, `${root}/`);
    assert.equal(call.target, `${snapshot.dir}/`);
    assert.ok(call.args.includes("--modify-window=-1") && !call.args.includes("--checksum"), "the change test is the nanosecond mtime");
    const filter = call.args.indexOf("--filter=:- .gitignore");
    const pair = call.include === null ? call.args.indexOf("--exclude=/*/") : call.args.indexOf(`--include=${call.include}`);
    assert.ok(filter >= 0 && pair > filter, "the include/exclude pair comes after the filters");
    if (call.include !== null) assert.equal(call.args[pair + 1], "--exclude=/*");
    assert.ok(!call.args.some(arg => arg.startsWith("--link-dest")), "the first snapshot of a root links to nothing");
    for (const name of SYNC_EXCLUDES) assert.ok(call.args.includes(`--exclude=${name}`));
  }
}));

test("an empty root (no directory) runs only the root-files rsync", async () => withTemp(async dir => {
  const root = join(dir, "flat");
  write(join(root, "bun.lock"), "lock");
  write(join(root, "index.ts"), "export {};");
  const { calls, run } = recordingRun();
  const { mirror } = makeMirror(dir, { run });
  await acquireSnapshot(mirror, root);
  assert.deepEqual(calls.map(call => call.include), [null]);
}));

test("exit 24 (a file vanished) from one process and 0 from the rest gives a snapshot", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { run } = recordingRun(call => (call.include === "/src/" ? { code: 24, stderrTail: "file has vanished" } : OK));
  const { mirror } = makeMirror(dir, { run });
  const snapshot = await acquireSnapshot(mirror, root);
  assert.equal(snapshot.kind, "snapshot");
}));

test("one process exiting 23 gives in-place 'rsync exited 23: <tail>' as a fallback and kills the others still running: every signal aborted, no g dir", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun(call => (call.include === "/src/" ? { code: 23, stderrTail: "rsync: some files could not be transferred" } : untilAborted(call)));
  const { mirror, mirrorDir, lines } = makeMirror(dir, { run });
  const result = await mirror.acquire(root);
  assert.equal(result.kind, "in-place");
  if (result.kind !== "in-place") return;
  assert.equal(result.reason, "rsync exited 23: rsync: some files could not be transferred");
  assert.equal(result.fallback, true);
  assert.match(lines.join("\n"), /rsync exited 23/u);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.signal?.aborted === true), "the others were aborted, not left running");
  assert.deepEqual(generationsOf(rootDirOf(mirrorDir, root)), []);
}));

test("an rsync that never started (code -1, no flag) names rsync and says what to check, not 'exited -1'", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { run } = recordingRun(() => ({ code: -1, stderrTail: "spawn rsync ENOENT" }));
  const { mirror } = makeMirror(dir, { run });
  const result = await mirror.acquire(root);
  assert.equal(result.kind === "in-place" ? result.reason : "", "rsync did not run to an exit code (is rsync installed?): spawn rsync ENOENT");
}));

test("a long rsync stderr reaches the reason as its last 400 characters only", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { run } = recordingRun(() => ({ code: 23, stderrTail: `${"x".repeat(1_500)}END` }));
  const { mirror } = makeMirror(dir, { run });
  const result = await mirror.acquire(root);
  const reason = result.kind === "in-place" ? result.reason : "";
  assert.ok(reason.startsWith("rsync exited 23: ") && reason.endsWith("xxxEND") && reason.length < 450, `${reason.length} characters`);
}));

test("the bound counts from the first start and kills all: in-place 'the sync did not end within N s', each process given the bound", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun(untilAborted);
  const { mirror, mirrorDir } = makeMirror(dir, { run }, { syncBoundMs: 200 });
  const started = performance.now();
  const result = await mirror.acquire(root);
  assert.equal(result.kind === "in-place" ? result.reason : "", "the sync did not end within 0.2 s");
  assert.ok(performance.now() - started < 3_000, "ended at the bound");
  assert.ok(calls.length === 3 && calls.every(call => call.signal?.aborted === true && call.boundMs === 200));
  assert.deepEqual(generationsOf(rootDirOf(mirrorDir, root)), []);
}));

test("a process that reports its own bound hit (timedOut) gives the same reason and kills the others", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun(call => (call.include === "/tests/" ? { code: -1, stderrTail: "", timedOut: true } : untilAborted(call)));
  const { mirror } = makeMirror(dir, { run }, { syncBoundMs: 5_000 });
  const result = await mirror.acquire(root);
  assert.equal(result.kind === "in-place" ? result.reason : "", "the sync did not end within 5 s");
  assert.ok(calls.every(call => call.signal?.aborted === true));
}));

test("a cancelled acquire kills the sync, deletes its partial g, says cancelled, and leaves no listener on the caller's signal", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun(untilAborted);
  const { mirror, mirrorDir, lines } = makeMirror(dir, { run });
  const caller = new AbortController();
  const pending = mirror.acquire(root, caller.signal);
  while (calls.length < 3) await new Promise(resolve => setTimeout(resolve, 5));
  caller.abort();
  const result = await pending;
  assert.equal(result.kind === "in-place" ? result.reason : "", "the submission was cancelled during the sync");
  assert.equal(result.kind === "in-place" && result.fallback, false, "a cancel is no fallback: no clients start anywhere");
  assert.doesNotMatch(lines.join("\n"), /clients start from/u);
  assert.ok(calls.every(call => call.signal?.aborted === true));
  assert.deepEqual(generationsOf(rootDirOf(mirrorDir, root)), []);
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
}));

test("a cancel queued behind another sync of its root answers at once, starts no rsync, and the next acquire still waits for that sync", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun(call => (calls.length <= 3 ? untilAborted(call) : OK));
  const { mirror } = makeMirror(dir, { run }, { syncBoundMs: 1_500 });
  const first = mirror.acquire(root);
  const caller = new AbortController();
  const second = mirror.acquire(root, caller.signal);
  const third = mirror.acquire(root);
  await new Promise(resolve => setTimeout(resolve, 50));
  const cancelledAt = performance.now();
  caller.abort();
  const cancelled = await second;
  assert.ok(performance.now() - cancelledAt < 500, "answered at once, not when the first sync ended");
  assert.equal(cancelled.kind === "in-place" ? cancelled.reason : "", "the submission was cancelled during the sync");
  assert.equal(calls.length, 3, "only the first sync's processes ran: the third still waits for it");
  assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  const [firstResult, thirdResult] = await Promise.all([first, third]);
  assert.equal(firstResult.kind === "in-place" ? firstResult.reason : "", "the sync did not end within 1.5 s");
  assert.equal(thirdResult.kind, "snapshot");
}));

test("an acquire whose signal is already aborted starts no rsync and makes no g dir", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { calls, run } = recordingRun();
  const { mirror, mirrorDir } = makeMirror(dir, { run });
  const result = await mirror.acquire(root, AbortSignal.abort());
  assert.equal(result.kind, "in-place");
  assert.equal(calls.length, 0);
  assert.deepEqual(generationsOf(rootDirOf(mirrorDir, root)), []);
}));

test("two acquires of one root at once sync in order: g1 ends before any process of g2 starts, and g2 links to g1", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const events: string[] = [];
  const { calls, run } = recordingRun(async call => {
    events.push(`start ${call.target}`);
    await new Promise(resolve => setTimeout(resolve, 20));
    events.push(`end ${call.target}`);
    return OK;
  });
  const { mirror } = makeMirror(dir, { run });
  const [a, b] = await Promise.all([mirror.acquire(root), mirror.acquire(root)]);
  assert.deepEqual([a, b].map(result => (result.kind === "snapshot" ? result.generation : 0)), [1, 2]);
  const secondCalls = calls.filter(call => call.target.includes("/g2/"));
  assert.ok(secondCalls.length === 3 && a.kind === "snapshot" && secondCalls.every(call => call.args.includes(`--link-dest=${a.dir}`)), "g2 links to g1");
  const firstStart2 = events.findIndex(event => event.startsWith("start") && event.includes("/g2/"));
  const lastEnd1 = events.map(event => event.startsWith("end") && event.includes("/g1/")).lastIndexOf(true);
  assert.ok(lastEnd1 >= 0 && firstStart2 > lastEnd1, events.join("\n"));
}));

test("release of g1 while g2 exists deletes g1; release of the newest keeps it; release twice is harmless", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const { mirror } = makeMirror(dir);
  const first = await acquireSnapshot(mirror, root);
  const second = await acquireSnapshot(mirror, root);
  assert.equal(existsSync(first.dir), true, "g1 is held");
  first.release();
  assert.equal(existsSync(first.dir), false);
  first.release();
  second.release();
  assert.equal(existsSync(second.dir), true, "the newest stays as the next sync's link-dest");
  const third = await acquireSnapshot(mirror, root);
  assert.equal(existsSync(second.dir), false, "g2 had no hold and is no longer the newest");
  assert.equal(existsSync(third.dir), true);
}));

/** Calls `acquire` with a `notify` that records its lines; each rsync process answers ok after `heldMs`. */
async function acquireWithHeldSync(dir: string, options: { slowSyncNoticeMs?: number }, heldMs: number) {
  const root = makeSourceRoot(dir);
  const notices: string[] = [];
  const { mirror } = makeMirror(dir, { run: () => new Promise(resolve => setTimeout(() => resolve(OK), heldMs)) }, options);
  const result = await mirror.acquire(root, undefined, line => notices.push(line));
  return { root, notices, result };
}

test("a slow sync prints its start line once, before the end, and the snapshot still comes", async () => withTemp(async dir => {
  const { root, notices, result } = await acquireWithHeldSync(dir, { slowSyncNoticeMs: 30 }, 200);
  assert.equal(result.kind, "snapshot");
  assert.deepEqual(notices, [`syncing ${root} to the client mirror ...`]);
  if (result.kind === "snapshot") result.release();
}));

test("a fast sync prints no start line", async () => withTemp(async dir => {
  const { notices, result } = await acquireWithHeldSync(dir, {}, 0);
  assert.equal(result.kind, "snapshot");
  assert.deepEqual(notices, []);
  if (result.kind === "snapshot") result.release();
}));

test("a sync that ends in failure leaves no timer: no line comes after the answer", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const notices: string[] = [];
  const { mirror } = makeMirror(dir, { run: async () => ({ code: 23, stderrTail: "boom" }) }, { slowSyncNoticeMs: 30 });
  const result = await mirror.acquire(root, undefined, line => notices.push(line));
  assert.equal(result.kind, "in-place");
  const linesAtAnswer = notices.length;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(notices.length, linesAtAnswer, "the notice timer was cleared at the answer");
}));

test("a submitter who left gets no start line", async () => withTemp(async dir => {
  const root = makeSourceRoot(dir);
  const notices: string[] = [];
  const controller = new AbortController();
  // The submitter leaves as the first rsync starts, so the abort always comes before the notice timer, whatever the load.
  const run: MirrorPorts["run"] = () => {
    controller.abort();
    return new Promise(resolve => setTimeout(() => resolve(OK), 200));
  };
  const { mirror } = makeMirror(dir, { run }, { slowSyncNoticeMs: 30 });
  await mirror.acquire(root, controller.signal, line => notices.push(line));
  assert.deepEqual(notices, []);
}));

interface NoSyncCase {
  readonly name: string;
  /** The cwd to acquire for, given the source root. */
  readonly cwd: (root: string, dir: string) => string;
  readonly ports?: Partial<MirrorPorts>;
  readonly enabled?: boolean;
  readonly reason: (root: string, cwd: string) => string;
  readonly fallback: boolean;
}

const NO_SYNC_CASES: readonly NoSyncCase[] = [
  { name: "node_modules still installing", cwd: root => root, fallback: true,
    ports: { modulesFor: () => ({ state: "installing", hash: "abcdef0123456789" }) },
    reason: root => `node_modules for ${root} is being installed on ext4 (lockfile abcdef012345); the next submission after it is done gets a snapshot` },
  { name: "the modules install failed", cwd: root => root, fallback: true,
    ports: { modulesFor: () => ({ state: "failed", hash: "h", reason: "bun install exited 1: lockfile had changes" }) },
    reason: root => `node_modules install for ${root} failed: bun install exited 1: lockfile had changes (tried again when package.json, bun.lock or a patch changes, or the daemon restarts)` },
  { name: "no bun.lock above the cwd", cwd: (_root, dir) => join(dir, "bare", "sub"), fallback: true,
    reason: (_root, cwd) => `no bun.lock above ${cwd}` },
  { name: "the root is already on ext4 (not a fallback)", cwd: root => root, fallback: false,
    ports: { mounts: () => "/dev/sdc / ext4 rw 0 0\n" },
    reason: root => `${root} is already on ext4` },
  { name: "the mirror is off", cwd: root => root, fallback: true, enabled: false,
    reason: () => "the mirror is off (MINE_AI_SCENARIO_MIRROR=0)" },
];

for (const scenario of NO_SYNC_CASES) {
  test(`in place without a sync, nothing made, release harmless twice: ${scenario.name}`, async () => withTemp(async dir => {
    const root = makeSourceRoot(dir);
    const cwd = scenario.cwd(root, dir);
    mkdirSync(cwd, { recursive: true });
    const { calls, run } = recordingRun();
    const { mirror, mirrorDir, lines } = makeMirror(dir, { run, ...scenario.ports }, { enabled: scenario.enabled ?? true });
    const result = await mirror.acquire(cwd);
    assert.equal(result.kind, "in-place");
    if (result.kind !== "in-place") return;
    assert.equal(result.reason, scenario.reason(root, cwd));
    assert.equal(result.fallback, scenario.fallback);
    // The submission handler prefixes a fallback reason with "clients start from /mnt/d for <root>: ": the reason does not say it again.
    assert.doesNotMatch(result.reason, /clients start from/u);
    assert.ok(lines.join("\n").includes(result.reason), "logged");
    assert.equal(calls.length, 0, "no rsync");
    assert.equal(existsSync(mirrorDir), false, "no directory made");
    result.release();
    result.release();
  }));
}




