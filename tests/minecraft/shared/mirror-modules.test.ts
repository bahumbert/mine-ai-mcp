import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModulesTrees, modulesHash, pruneModules, type ModulesPorts } from "./mirror-modules.ts";
import type { RunResult } from "./run-bounded.ts";

const DAY_MS = 86_400_000;
const NOW_MS = 1_800_000_000_000;

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A lockfile root: the three inputs of the hash plus a `src/` the hash must ignore. */
function makeRoot(dir: string): string {
  const root = join(dir, "root");
  write(join(root, "package.json"), '{"name":"x"}');
  write(join(root, "bun.lock"), "lock v1");
  write(join(root, "patches", "a.patch"), "patch a");
  write(join(root, "src", "index.ts"), "export {};");
  return root;
}

async function withTemp(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mirror-modules-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

interface RunCall { readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly boundMs: number; readonly inputsSeen: readonly string[] }
/** A `run` that records its calls and, unless `behave` says otherwise, installs a `node_modules/mine-labs` in its cwd like a good `bun install`. */
function fakePorts(behave?: (call: RunCall) => Promise<RunResult> | RunResult, alive: (pid: number) => boolean = () => true) {
  const calls: RunCall[] = [];
  const ports: ModulesPorts = {
    async run(command, args, options) {
      const call = { command, args, cwd: options.cwd, boundMs: options.boundMs, inputsSeen: readdirSync(options.cwd).sort() };
      calls.push(call);
      if (behave) return behave(call);
      mkdirSync(join(options.cwd, "node_modules", "mine-labs"), { recursive: true });
      return { code: 0, stderrTail: "" };
    },
    pidAlive: alive,
    now: () => NOW_MS,
  };
  return { calls, ports };
}

function treesOf(dir: string, ports: ModulesPorts, boundMs = 1_000) {
  const lines: string[] = [];
  return { lines, trees: new ModulesTrees({ mirrorDir: join(dir, "mirror"), boundMs, log: line => lines.push(line) }, ports) };
}

function modulesDirOf(dir: string): string { return join(dir, "mirror", "modules"); }

test("the hash changes with bun.lock, with a patch file's bytes, with a new patch file, not with src/", () => withTemp(dir => {
  const root = makeRoot(dir);
  const base = modulesHash(root);
  write(join(root, "src", "index.ts"), "export const changed = 1;");
  assert.equal(modulesHash(root), base, "src/ is not an input");
  write(join(root, "bun.lock"), "lock v2");
  const afterLock = modulesHash(root);
  assert.notEqual(afterLock, base);
  write(join(root, "patches", "a.patch"), "patch a, edited");
  const afterBytes = modulesHash(root);
  assert.notEqual(afterBytes, afterLock);
  write(join(root, "patches", "b.patch"), "patch b");
  assert.notEqual(modulesHash(root), afterBytes);
  const afterNew = modulesHash(root);
  write(join(root, "package.json"), '{"name":"y"}');
  assert.notEqual(modulesHash(root), afterNew, "package.json is an input");
  const afterPackage = modulesHash(root);
  rmSync(join(root, "patches", "a.patch"));
  write(join(root, "patches", "renamed.patch"), "patch a");
  assert.notEqual(modulesHash(root), afterPackage, "a patch's file name is an input, not only its bytes");
  rmSync(join(root, "patches"), { recursive: true });
  assert.match(modulesHash(root), /^[0-9a-f]{64}$/u, "a root without a patches directory has a hash");
}));

test("a present tree is ready, installs nothing, has its .last-used touched, and settled resolves at once", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const hash = modulesHash(root);
  const tree = join(modulesDirOf(dir), hash);
  mkdirSync(join(tree, "node_modules", "mine-labs"), { recursive: true });
  const { calls, ports } = fakePorts();
  const { trees } = treesOf(dir, ports);
  assert.deepEqual(trees.modulesFor(root), { state: "ready", hash, nodeModules: join(tree, "node_modules") });
  assert.equal(calls.length, 0);
  assert.equal(statSync(join(tree, ".last-used")).mtimeMs, NOW_MS);
  await trees.settled();
}));

test("a missing tree answers installing at once, installs in <hash>.tmp-<pid>, renames it, then answers ready", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const hash = modulesHash(root);
  const { calls, ports } = fakePorts();
  const { trees } = treesOf(dir, ports, 1_234);
  assert.deepEqual(trees.modulesFor(root), { state: "installing", hash });
  await trees.settled();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, "bun");
  assert.deepEqual(calls[0]!.args, ["install", "--frozen-lockfile"]);
  assert.equal(calls[0]!.cwd, join(modulesDirOf(dir), `${hash}.tmp-${process.pid}`));
  assert.equal(calls[0]!.boundMs, 1_234);
  assert.deepEqual(calls[0]!.inputsSeen, ["bun.lock", "package.json", "patches"], "the install runs on copies of the three inputs only");
  assert.deepEqual(trees.modulesFor(root), { state: "ready", hash, nodeModules: join(modulesDirOf(dir), hash, "node_modules") });
  assert.deepEqual(readdirSync(modulesDirOf(dir)), [hash], "no tmp left");
  assert.equal(readFileSync(join(modulesDirOf(dir), hash, "patches", "a.patch"), "utf8"), "patch a");
}));

test("a call during the install answers installing and starts none", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { calls, ports } = fakePorts(async call => {
    await gate;
    mkdirSync(join(call.cwd, "node_modules", "mine-labs"), { recursive: true });
    return { code: 0, stderrTail: "" };
  });
  const { trees } = treesOf(dir, ports);
  const first = trees.modulesFor(root);
  assert.deepEqual(trees.modulesFor(root), first);
  assert.equal(trees.modulesFor(root).state, "installing");
  assert.equal(calls.length, 1);
  release();
  await trees.settled();
  assert.equal(trees.modulesFor(root).state, "ready");
}));

test("an install that exits 1 answers failed with its stderr tail, leaves no tmp, and a later call answers the same failure without a new install", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const hash = modulesHash(root);
  const { calls, ports } = fakePorts(() => ({ code: 1, stderrTail: "error: lockfile had changes" }));
  const { trees, lines } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  const failed = trees.modulesFor(root);
  assert.equal(failed.state, "failed");
  assert.equal(failed.hash, hash);
  assert.match(failed.state === "failed" ? failed.reason : "", /exited 1.*error: lockfile had changes/u);
  assert.deepEqual(readdirSync(modulesDirOf(dir)), [], "no tmp left");
  assert.deepEqual(trees.modulesFor(root), failed);
  assert.equal(calls.length, 1);
  assert.equal(lines.length, 1, "the failure is logged once");
  assert.match(lines[0]!, /error: lockfile had changes/u);
}));

test("a changed bun.lock after a failure installs again", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  let attempt = 0;
  const { calls, ports } = fakePorts(call => {
    attempt += 1;
    if (attempt === 1) return { code: 1, stderrTail: "boom" };
    mkdirSync(join(call.cwd, "node_modules", "mine-labs"), { recursive: true });
    return { code: 0, stderrTail: "" };
  });
  const { trees } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  assert.equal(trees.modulesFor(root).state, "failed");
  write(join(root, "bun.lock"), "lock v2");
  assert.equal(trees.modulesFor(root).state, "installing");
  await trees.settled();
  assert.equal(calls.length, 2);
  assert.equal(trees.modulesFor(root).state, "ready");
}));

const FAILING_INSTALLS: ReadonlyArray<{ readonly name: string; readonly run: () => RunResult; readonly reason: RegExp }> = [
  { name: "past its bound", run: () => ({ code: -1, stderrTail: "", timedOut: true }), reason: /^bun install did not end within 3\.864 s$/u },
  { name: "that leaves no node_modules/mine-labs", run: () => ({ code: 0, stderrTail: "" }), reason: /node_modules\/mine-labs/u },
  { name: "whose run rejects", run: () => { throw new Error("disk full"); }, reason: /disk full/u },
];

for (const failing of FAILING_INSTALLS) {
  test(`an install ${failing.name} answers failed with a reason and leaves no tmp`, async () => withTemp(async dir => {
    const root = makeRoot(dir);
    const { trees } = treesOf(dir, fakePorts(failing.run).ports, 3_864);
    trees.modulesFor(root);
    await trees.settled();
    const state = trees.modulesFor(root);
    assert.equal(state.state, "failed");
    assert.match(state.state === "failed" ? state.reason : "", failing.reason);
    assert.deepEqual(readdirSync(modulesDirOf(dir)), []);
  }));
}

test("an install that cannot even copy its inputs (the modules path is a file) answers failed, not a rejection", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  write(modulesDirOf(dir), "not a directory");
  const { calls, ports } = fakePorts();
  const { trees } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  assert.equal(trees.modulesFor(root).state, "failed");
  assert.equal(calls.length, 0);
}));

test("an install that fails before it waits for anything answers failed with the error at the very call that started it, not installing", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  write(modulesDirOf(dir), "not a directory");
  const { ports } = fakePorts();
  const { trees } = treesOf(dir, ports);
  const first = trees.modulesFor(root);
  assert.equal(first.state, "failed");
  assert.match(first.state === "failed" ? first.reason : "", /ENOTDIR|EEXIST|not a directory/iu, "the reason is the error's own message");
  await trees.settled();
}));

test("a tree that appears during the install (another daemon) is used and the own tmp deleted", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const hash = modulesHash(root);
  const { ports } = fakePorts(call => {
    mkdirSync(join(call.cwd, "node_modules", "mine-labs"), { recursive: true });
    mkdirSync(join(modulesDirOf(dir), hash, "node_modules", "mine-labs"), { recursive: true });
    write(join(modulesDirOf(dir), hash, "other-daemon"), "won");
    return { code: 0, stderrTail: "" };
  });
  const { trees } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  assert.deepEqual(trees.modulesFor(root), { state: "ready", hash, nodeModules: join(modulesDirOf(dir), hash, "node_modules") });
  assert.deepEqual(readdirSync(modulesDirOf(dir)), [hash], "own tmp deleted");
  assert.equal(readFileSync(join(modulesDirOf(dir), hash, "other-daemon"), "utf8"), "won", "the winner's tree is untouched");
}));

test("a tmp left by an earlier process with the same pid is replaced, not mixed into the install", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const hash = modulesHash(root);
  write(join(modulesDirOf(dir), `${hash}.tmp-${process.pid}`, "stale-file"), "old");
  const { calls, ports } = fakePorts();
  const { trees } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  assert.deepEqual(calls[0]!.inputsSeen, ["bun.lock", "package.json", "patches"]);
  assert.equal(trees.modulesFor(root).state, "ready");
}));

/** Makes `<modules>/<name>/node_modules` with `.last-used` aged `ageMs` before NOW_MS. */
function makeTree(dir: string, name: string, ageMs: number): void {
  const tree = join(modulesDirOf(dir), name);
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  write(join(tree, ".last-used"), "");
  utimesSync(join(tree, ".last-used"), (NOW_MS - ageMs) / 1000, (NOW_MS - ageMs) / 1000);
}

test("prune: an old tree in the linked set is kept, a recent unlinked one kept, an old unlinked one deleted", async () => withTemp(async dir => {
  makeTree(dir, "old-linked", 10 * DAY_MS);
  makeTree(dir, "recent-unlinked", 1 * DAY_MS);
  makeTree(dir, "old-unlinked", 10 * DAY_MS);
  const { ports } = fakePorts();
  const removed = await pruneModules(join(dir, "mirror"), new Set(["old-linked"]), 7 * DAY_MS, ports);
  assert.deepEqual(removed, ["old-unlinked"]);
  assert.deepEqual(readdirSync(modulesDirOf(dir)).sort(), ["old-linked", "recent-unlinked"]);
}));

test("prune: a dead pid's tmp is deleted and a live pid's kept, linked or not", async () => withTemp(async dir => {
  mkdirSync(join(modulesDirOf(dir), "abc.tmp-111", "node_modules"), { recursive: true });
  mkdirSync(join(modulesDirOf(dir), "abc.tmp-222", "node_modules"), { recursive: true });
  const { ports } = fakePorts(undefined, pid => pid === 222);
  const removed = await pruneModules(join(dir, "mirror"), new Set(["abc"]), 7 * DAY_MS, ports);
  assert.deepEqual(removed, ["abc.tmp-111"]);
  assert.deepEqual(readdirSync(modulesDirOf(dir)), ["abc.tmp-222"]);
}));

test("prune: a tree without .last-used is aged by its directory and a missing modules directory is no error", async () => withTemp(async dir => {
  const { ports } = fakePorts();
  assert.deepEqual(await pruneModules(join(dir, "mirror"), new Set(), 7 * DAY_MS, ports), []);
  const tree = join(modulesDirOf(dir), "bare");
  mkdirSync(join(tree, "node_modules"), { recursive: true });
  utimesSync(tree, (NOW_MS - 10 * DAY_MS) / 1000, (NOW_MS - 10 * DAY_MS) / 1000);
  assert.deepEqual(await pruneModules(join(dir, "mirror"), new Set(), 7 * DAY_MS, ports), ["bare"]);
}));

test("prune skips a tree another daemon's prune deleted between the listing and the age check", async () => withTemp(async dir => {
  makeTree(dir, "gone", 10 * DAY_MS);
  const { ports } = fakePorts();
  const racing: ModulesPorts = { ...ports, now: () => { rmSync(join(modulesDirOf(dir), "gone"), { recursive: true }); return NOW_MS; } };
  assert.deepEqual(await pruneModules(join(dir, "mirror"), new Set(), 7 * DAY_MS, racing), []);
}));

test("a failed install is logged with what happens next", async () => withTemp(async dir => {
  const root = makeRoot(dir);
  const { ports } = fakePorts(() => ({ code: 1, stderrTail: "boom" }));
  const { trees, lines } = treesOf(dir, ports);
  trees.modulesFor(root);
  await trees.settled();
  assert.match(lines[0]!, /clients start from \/mnt\/d until package\.json, bun\.lock or a patch changes, or the daemon restarts/u);
}));

test("real install: this worktree's lockfile gives a tree whose mine-labs holds the client-ahead patch", { skip: process.env.MINE_AI_TEST_REAL_INSTALL !== "1", timeout: 180_000 }, async () => withTemp(async dir => {
  const root = join(import.meta.dirname, "..", "..", "..");
  assert.ok(existsSync(join(root, "bun.lock")), `${root} holds bun.lock`);
  const lines: string[] = [];
  const trees = new ModulesTrees({ mirrorDir: join(dir, "mirror"), boundMs: 170_000, log: line => lines.push(line) });
  assert.equal(trees.modulesFor(root).state, "installing");
  await trees.settled();
  const state = trees.modulesFor(root);
  assert.equal(state.state, "ready", lines.join("\n"));
  if (state.state !== "ready") return;
  const processFile = readFileSync(join(state.nodeModules, "mine-labs", "src", "client", "process.ts"), "utf8");
  assert.match(processFile, /spawnClientAhead/u);
}));
