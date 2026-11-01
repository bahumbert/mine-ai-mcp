import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ProcessInfo } from "./process-list.ts";
import { Children, cleanupStale, runnersLeftBy, type SpawnedProcess, type SpawnProcess } from "./processes.ts";

/**
 * A child process that exits once, a moment after the first `kill()`. Measured with Bun 1.4.2 on Windows and WSL (task
 * review of W2a): `exit` comes 1-19 ms after `kill()` and only once; a failed start emits `error` (pid undefined), then
 * `close`, and no `exit`.
 */
class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable | null;
  killed = false;
  constructor(readonly pid: number | undefined, withStdin: boolean) {
    super();
    this.stdin = withStdin ? new PassThrough() : null;
  }
  kill(): boolean {
    if (!this.killed) setImmediate(() => this.exit(null, "SIGTERM"));
    this.killed = true;
    return true;
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }
}

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: Parameters<SpawnProcess>[2];
  process: FakeProcess;
}

function fakeSpawn(firstPid = 1000): { spawn: SpawnProcess; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  let nextPid = firstPid;
  const spawn: SpawnProcess = (cmd, args, options) => {
    const stdio = options.stdio as readonly unknown[];
    const process = new FakeProcess(nextPid++, stdio[0] === "pipe");
    calls.push({ cmd, args, options, process });
    return process;
  };
  return { spawn, calls };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "launcher-processes-"));
}

const pidFile = (root: string): string => join(root, "run", "children.json");
const readPidFile = (root: string): unknown => JSON.parse(readFileSync(pidFile(root), "utf8"));
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function newChildren(root = tempRoot(), platform?: NodeJS.Platform) {
  const fake = fakeSpawn();
  return { ...fake, root, children: new Children(root, { spawn: fake.spawn, platform }) };
}

test("spawn records pid, image and name in run/children.json and passes the env", () => {
  const { children, calls, root } = newChildren();
  const child = children.spawn("host-ayla", "C:\\Tools\\Bun.exe", ["host.ts"], { env: { A: "1" }, cwd: root, logFile: join(root, "logs", "host-ayla.log") });
  assert.equal((calls[0]!.options.env as Record<string, string>).A, "1");
  assert.equal(calls[0]!.options.detached, process.platform !== "win32", "the platform defaults to this process's");
  assert.equal(child.pid, 1000);
  assert.deepEqual(readPidFile(root), [{ pid: 1000, parentPid: process.pid, image: "bun", name: "host-ayla" }]);
});

// Finding 6 of the W5 host run; the reasoning is in the `Children` comment.
for (const [platform, detached] of [["win32", false], ["linux", true]] as const) {
  test(`on ${platform} a child is ${detached ? "detached" : "not detached"} and never shows a window`, () => {
    const { children, calls, root } = newChildren(tempRoot(), platform);
    children.spawn("host-ayla", "bun", ["host.ts"], { env: {}, cwd: root, logFile: join(root, "logs", "host-ayla.log") });
    assert.equal(calls[0]!.options.detached, detached);
    assert.equal(calls[0]!.options.windowsHide, true);
  });
}

test("a child's exit removes its record and resolves exited with the code", async () => {
  const { children, calls, root } = newChildren();
  const child = children.spawn("server", "/usr/bin/java", ["-jar"], { env: {}, cwd: root, logFile: join(root, "logs", "server.log") });
  calls[0]!.process.exit(3);
  assert.deepEqual(await child.exited, { code: 3, signal: null });
  assert.equal(child.isRunning(), false);
  assert.deepEqual(readPidFile(root), []);
});

test("stdin is piped only when asked, and is the child's stdin", () => {
  const { children, calls, root } = newChildren();
  const options = { env: {}, cwd: root, logFile: join(root, "logs", "x.log") };
  const plain = children.spawn("a", "bun", [], options);
  const piped = children.spawn("b", "java", [], { ...options, stdin: "pipe" });
  assert.deepEqual(calls[0]!.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(calls[1]!.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(plain.stdin, null);
  assert.equal(piped.stdin, calls[1]!.process.stdin);
});

test("output lines go to the log file and onLine, stderr tagged, a last line without newline kept", async () => {
  const { children, calls, root } = newChildren();
  const logFile = join(root, "logs", "host.log");
  const seen: string[] = [];
  children.spawn("host", "bun", [], { env: {}, cwd: root, logFile, onLine: (line, stream) => seen.push(`${stream}:${line}`) });
  calls[0]!.process.stdout.write("one\ntwo\n");
  calls[0]!.process.stderr.write("oops\n");
  calls[0]!.process.stdout.end("tail");
  calls[0]!.process.stderr.end();
  for (let turn = 0; turn < 50 && seen.length < 4; turn++) await tick();
  assert.deepEqual(seen.sort(), ["stderr:oops", "stdout:one", "stdout:tail", "stdout:two"]);
  const logged = readFileSync(logFile, "utf8").split("\n");
  for (const line of ["one", "two", "tail"]) assert.ok(logged.some((entry) => entry.endsWith(line)), `${line} in log`);
  assert.ok(logged.some((entry) => entry.includes("oops") && entry.includes("stderr")));
});

test("a spawn that fails (missing executable) resolves exited with the error, records nothing and names the log", async () => {
  const root = tempRoot();
  const failing: SpawnProcess = () => {
    const process = new FakeProcess(undefined, false);
    setImmediate(() => process.emit("error", new Error("spawn nope ENOENT")));
    return process;
  };
  const children = new Children(root, { spawn: failing });
  const logFile = join(root, "logs", "ollama.log");
  const child = children.spawn("ollama", "nope", [], { env: {}, cwd: root, logFile });
  const exit = await child.exited;
  assert.equal(exit.code, null);
  assert.match(exit.error ?? "", /ENOENT/u);
  assert.equal(child.isRunning(), false);
  assert.equal(existsSync(pidFile(root)), false, "a child that never started has no record");
  assert.match(readFileSync(logFile, "utf8"), /ENOENT/u);
});

test("a pid-file write that fails at exit still settles exited and logs the failure", async () => {
  const { children, calls, root } = newChildren();
  const logFile = join(root, "logs", "h.log");
  const child = children.spawn("host", "bun", [], { env: {}, cwd: root, logFile });
  mkdirSync(join(root, "run", "children.json.tmp")); // the temporary file cannot be created: the write fails
  assert.doesNotThrow(() => calls[0]!.process.exit(0));
  assert.deepEqual(await child.exited, { code: 0, signal: null });
  assert.match(readFileSync(logFile, "utf8"), /children.json/u);
});

test("a pid-file write that fails at spawn still returns the child", () => {
  const { children, root } = newChildren();
  mkdirSync(join(root, "run", "children.json.tmp"), { recursive: true });
  const child = children.spawn("host", "bun", [], { env: {}, cwd: root, logFile: join(root, "logs", "h.log") });
  assert.equal(child.isRunning(), true);
});

test("spawning a name that is still running is refused", () => {
  const { children, root } = newChildren();
  const options = { env: {}, cwd: root, logFile: join(root, "logs", "x.log") };
  children.spawn("host", "bun", [], options);
  assert.throws(() => children.spawn("host", "bun", [], options), /host.*already running/u);
});

test("stop with a graceful step that works does not kill", async () => {
  const { children, calls, root } = newChildren();
  children.spawn("server", "java", [], { env: {}, cwd: root, logFile: join(root, "logs", "s.log"), stdin: "pipe" });
  await children.stop("server", { graceful: async () => calls[0]!.process.exit(0), timeoutMs: 1000 });
  assert.equal(calls[0]!.process.killed, false);
});

test("stop kills a child that ignores the graceful step once timeoutMs has passed", async () => {
  const { children, calls, root } = newChildren();
  children.spawn("server", "java", [], { env: {}, cwd: root, logFile: join(root, "logs", "s.log") });
  const started = Date.now();
  await children.stop("server", { graceful: async () => {}, timeoutMs: 60 });
  assert.equal(calls[0]!.process.killed, true);
  assert.ok(Date.now() - started >= 50, "waited for the timeout first");
});

test("stop kills a child whose graceful step throws, and with no graceful step kills at once", async () => {
  const { children, calls, root } = newChildren();
  const options = { env: {}, cwd: root, logFile: join(root, "logs", "s.log") };
  children.spawn("a", "bun", [], options);
  children.spawn("b", "bun", [], options);
  await children.stop("a", { graceful: () => Promise.reject(new Error("stdin closed")), timeoutMs: 1000 });
  await children.stop("b", { timeoutMs: 1000 });
  assert.equal(calls[0]!.process.killed, true);
  assert.equal(calls[1]!.process.killed, true);
});

test("stop of a name that is unknown or already gone does nothing", async () => {
  const { children, calls, root } = newChildren();
  await children.stop("nobody", { timeoutMs: 10 });
  children.spawn("host", "bun", [], { env: {}, cwd: root, logFile: join(root, "logs", "h.log") });
  calls[0]!.process.exit(0);
  await tick();
  await children.stop("host", { timeoutMs: 10 });
  assert.equal(calls[0]!.process.killed, false);
});

// W10b: the stop path says whether the server saved (`ended`) or was killed.
test("stop answers ended with the exit when the child exits on the graceful step, killed when it had to be killed, not-running for an unknown or gone name", async () => {
  const { children, calls, root } = newChildren();
  const options = { env: {}, cwd: root, logFile: join(root, "logs", "x.log") };
  for (const name of ["polite", "stubborn", "no-step", "throws", "gone"]) children.spawn(name, "bun", [], options);
  calls[4]!.process.exit(0);
  await tick();
  assert.deepEqual(await children.stop("polite", { graceful: async () => calls[0]!.process.exit(0), timeoutMs: 1000 }), { ended: { code: 0, signal: null } });
  assert.equal(await children.stop("stubborn", { graceful: async () => {}, timeoutMs: 30 }), "killed");
  assert.equal(await children.stop("no-step", { timeoutMs: 1000 }), "killed");
  assert.equal(await children.stop("throws", { graceful: () => Promise.reject(new Error("stdin closed")), timeoutMs: 1000 }), "killed");
  assert.equal(await children.stop("gone", { timeoutMs: 10 }), "not-running");
  assert.equal(await children.stop("nobody", { timeoutMs: 10 }), "not-running");
  assert.equal(calls[0]!.process.killed, false);
});

test("stopAll stops the listed names in the order given, then the others last started first", async () => {
  const { children, calls, root } = newChildren();
  const options = { env: {}, cwd: root, logFile: join(root, "logs", "x.log") };
  for (const name of ["ollama", "server", "host-a", "brain-a", "extra1", "extra2"]) children.spawn(name, "bun", [], options);
  const killedNames: string[] = [];
  for (const [index, name] of ["ollama", "server", "host-a", "brain-a", "extra1", "extra2"].entries()) {
    calls[index]!.process.once("exit", () => killedNames.push(name));
  }
  await children.stopAll(["brain-a", "host-a", "server", "ollama"]);
  assert.deepEqual(killedNames, ["brain-a", "host-a", "server", "ollama", "extra2", "extra1"]);
  assert.deepEqual(readPidFile(root), []);
});

// ---- cleanupStale ---------------------------------------------------------------------------------------------

/** The launcher that wrote the records had pid 1 in these tests, unless a record says otherwise. */
type StaleRecord = { pid: number; image: string; name: string; parentPid?: number };

function writePidFile(root: string, records: readonly StaleRecord[]): void {
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(pidFile(root), JSON.stringify(records.map((record) => ({ parentPid: 1, ...record }))));
}

function staleSetup(records: Parameters<typeof writePidFile>[1], running: readonly ProcessInfo[]) {
  const root = tempRoot();
  writePidFile(root, records);
  const killed: number[] = [];
  const list = async () => running;
  const killPid = (pid: number) => void killed.push(pid);
  return { root, killed, list, killPid };
}

test("cleanupStale kills a recorded pid whose image still matches, whatever the .exe and case", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 10, image: "bun", name: "host-ayla" }, { pid: 11, image: "java", name: "server" }],
    [{ pid: 10, parentPid: 1, image: "bun.exe" }, { pid: 11, parentPid: 1, image: "Java.EXE" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed.sort(), [10, 11]);
});

test("cleanupStale leaves a recorded pid that another program now uses", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 10, image: "bun", name: "host-ayla" }],
    [{ pid: 10, parentPid: 1, image: "chrome.exe" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, []);
});

// A stale file survives a reboot or a launcher crash, and the pids are then reused: image alone is no identity
// (task review of W2a). The launcher that started the child is part of it, and this process is never a target.
test("cleanupStale leaves a pid that now belongs to the new launcher itself", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: process.pid, image: "bun", name: "host-ayla" }],
    [{ pid: process.pid, parentPid: process.ppid, image: "bun.exe" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, []);
});

test("cleanupStale leaves a same-image process started by another program: the player's own ollama and its runner", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 9000, image: "ollama", name: "ollama" }],
    [{ pid: 9000, parentPid: 4, image: "ollama.exe" }, { pid: 9100, parentPid: 9000, image: "llama-server.exe" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, []);
});

test("cleanupStale kills the llama-server left by our dead ollama, and another llama-server stays", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 100, image: "ollama", name: "ollama" }],
    [
      { pid: 200, parentPid: 100, image: "llama-server.exe" },
      { pid: 300, parentPid: 555, image: "llama-server.exe" },
      { pid: 301, parentPid: 4, image: "llama-server.exe" },
    ],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, [200]);
});

test("cleanupStale kills our live ollama and its llama-server in the same pass", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 100, image: "ollama", name: "ollama" }],
    [{ pid: 100, parentPid: 1, image: "ollama.exe" }, { pid: 200, parentPid: 100, image: "llama-server.exe" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed.sort(), [100, 200]);
});

test("cleanupStale leaves a llama-server whose parent pid is now another live program (a reused pid)", async () => {
  const { root, killed, list, killPid } = staleSetup(
    [{ pid: 100, image: "ollama", name: "ollama" }],
    [{ pid: 100, parentPid: 1, image: "chrome.exe" }, { pid: 200, parentPid: 100, image: "llama-server.exe" }],
  );
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, []);
});

test("cleanupStale empties the pid file so a second pass finds nothing", async () => {
  const { root, killed, list, killPid } = staleSetup([{ pid: 10, image: "bun", name: "host" }], [{ pid: 10, parentPid: 1, image: "bun.exe" }]);
  await cleanupStale(root, list, killPid);
  assert.deepEqual(readPidFile(root), []);
  killed.length = 0;
  await cleanupStale(root, list, killPid);
  assert.deepEqual(killed, []);
});

test("cleanupStale with no pid file does nothing and creates nothing; a corrupt one is replaced", async () => {
  const root = tempRoot();
  await cleanupStale(root, async () => [], () => assert.fail("nothing to kill"));
  assert.equal(existsSync(pidFile(root)), false);
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(pidFile(root), "{ torn");
  await cleanupStale(root, async () => [], () => assert.fail("nothing to kill"));
  assert.deepEqual(readPidFile(root), []);
});

test("cleanupStale goes on when one kill fails (the process just ended)", async () => {
  const { root, list } = staleSetup(
    [{ pid: 10, image: "bun", name: "a" }, { pid: 11, image: "bun", name: "b" }],
    [{ pid: 10, parentPid: 1, image: "bun.exe" }, { pid: 11, parentPid: 1, image: "bun.exe" }],
  );
  const killed: number[] = [];
  await cleanupStale(root, list, (pid) => {
    killed.push(pid);
    if (pid === 10) throw new Error("ESRCH");
  });
  assert.deepEqual(killed, [10, 11]);
});

// ---- runnersLeftBy: what stopStack kills after it stopped our serve ------------------------------------------

test("runnersLeftBy lists the llama-server children of a parent pid that no longer runs, no others", () => {
  const processes: ProcessInfo[] = [
    { pid: 200, parentPid: 100, image: "llama-server.exe" },
    { pid: 201, parentPid: 100, image: "notepad.exe" },
    { pid: 300, parentPid: 555, image: "llama-server.exe" },
  ];
  assert.deepEqual(runnersLeftBy(100, processes).map((entry) => entry.pid), [200]);
  assert.deepEqual(runnersLeftBy(100, [...processes, { pid: 100, parentPid: 1, image: "ollama.exe" }], new Set([100])).map((entry) => entry.pid), [200]);
});
