/** Process and lock lifetime at the unit slot's external boundary. */
import { afterAll, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// limit: 83.010 ms maximum normal OS checkpoint, from five isolated and three suite-loaded copies, ×5 rounded up.
const CHECKPOINT_MS = 1_000;
// limit: 1 s signal grace plus the checkpoint allowance (slowest whole cancellation 1,073.297 ms in the same batch).
const DRAIN_MS = 1_000 + CHECKPOINT_MS;

const roots: string[] = [];
const identities = new Map<number, string>();

/** Reads the process state and start time with the command name (which may contain spaces) removed. */
function procFields(pid: number): string[] {
  const stat = readText(`/proc/${pid}/stat`);
  return stat === "" ? [] : stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
}

/** Empty until an atomic checkpoint is published, or after a proc file disappears. */
function readText(path: string, read: (file: string) => string = file => readFileSync(file, "utf8")): string {
  try {
    return read(path);
  } catch (error) {
    // ESRCH: the process exited between the open and the read of its proc file (plan 2026-11-18-unit-reds-a2 T9; 2026-11-20 task 5 count: 9 of 59 copies).
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ESRCH") throw error;
    return "";
  }
}

/** Records the identity before taking any further action on a fixture process. */
function register(pid: number): number {
  const start = procFields(pid)[19];
  if (start !== undefined) identities.set(pid, start);
  return pid;
}

/** Signals only an original fixture process. */
function signal(pid: number, signalName: NodeJS.Signals): void {
  const start = identities.get(pid);
  if (start === undefined || procFields(pid)[19] !== start) return;
  try {
    process.kill(pid, signalName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

afterAll(async () => {
  for (const dir of roots) writeFileSync(join(dir, "gate"), "");
  for (const [pid, start] of [...identities]) {
    if (procFields(pid)[19] === start) registerChildren(pid);
  }
  const owned = [...identities].reverse();
  for (const [pid] of owned) signal(pid, "SIGKILL");
  try {
    await waitUntil(() => owned.every(([pid, start]) => procFields(pid)[19] !== start), "all fixture owners to exit", DRAIN_MS);
  } finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  }
});

/** Finds live children even if their parent exited while listing its threads. */
function childrenOf(pid: number): number[] {
  try {
    return readdirSync(`/proc/${pid}/task`).flatMap(tid =>
      readText(`/proc/${pid}/task/${tid}/children`).trim().split(/\s+/u).filter(Boolean).map(Number));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

/** Records descendants that may not have reached their PID publication when a test failed. */
function registerChildren(pid: number): void {
  for (const child of childrenOf(pid)) {
    if (identities.has(child)) continue;
    registerChildren(register(child));
  }
}

/** Checks a process or file checkpoint without leaving a watchdog pending after the result. */
async function waitUntil(condition: () => boolean, what: string, bound: number): Promise<void> {
  const deadline = performance.now() + bound;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    // real wait: Linux processes publish these checkpoints independently of the test process's clock.
    await Bun.sleep(20);
  }
}

/** Provides a private slot and trace on tmpfs. */
function slotFixture() {
  const dir = mkdtempSync("/dev/shm/mine-ai-test-slot-");
  roots.push(dir);
  return { dir, lock: join(dir, "unit.lock"), trace: join(dir, "trace"), out: join(dir, "runner.out"), err: join(dir, "runner.err") };
}

type SlotFixture = ReturnType<typeof slotFixture>;

const RUNNER_SETUP = `
  import { existsSync, renameSync, writeFileSync } from "node:fs";
  import { join } from "node:path";
  import { runInSlot } from ${JSON.stringify(join(import.meta.dir, "test-fast-slot.ts"))};
  const [dir, ...command] = process.argv.slice(1);
  const output = join(dir, "runner.out");
  const lines = [];
  const publish = line => {
    lines.push(line);
    writeFileSync(output + ".tmp", lines.join("\\n") + "\\n");
    renameSync(output + ".tmp", output);
  };
  const listeners = () => publish("listeners " + process.listenerCount("SIGTERM") + " " + process.listenerCount("SIGINT"));
  const run = (argv, say = publish) => runInSlot(argv, join(dir, "unit.lock"), process.env, say);
  listeners();
`;
const RUN_COMMAND = `publish("code " + await run(command)); listeners();`;

/** Runs one slot request in a child so signalling it cannot interrupt this test process. */
function runner(fixture: SlotFixture, script: string, command: string[] = [], options: { unreaped?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const bun = [process.execPath, "-e", RUNNER_SETUP + script, "--", fixture.dir, ...command];
  const argv = options.unreaped ? ["sh", "-c", '"$@" & echo $! > "$0/req.tmp" && mv "$0/req.tmp" "$0/req.pid"; exec sleep 30', fixture.dir, ...bun] : bun;
  const fd = openSync(fixture.err, "w");
  try {
    const child = Bun.spawn(argv, { env: { ...process.env, ...options.env, MINE_AI_TEST_SLOT_TRACE: fixture.trace }, stdout: fd, stderr: fd });
    register(child.pid);
    return child;
  } finally {
    closeSync(fd);
  }
}

/** Waits for a shell to publish and registers the pid immediately. */
async function publishedPid(fixture: SlotFixture, name: string): Promise<number> {
  const path = join(fixture.dir, `${name}.pid`);
  await waitUntil(() => existsSync(path), `${name} pid`, CHECKPOINT_MS);
  return register(Number(readFileSync(path, "utf8").trim()));
}

/** Command and gated child publish separately, with the trap ready before the child's PID is visible. */
function commandWithChild(fixture: SlotFixture, ignoreTerm: boolean, commandExit: "wait" | "exit 0"): string[] {
  // The responsive shell waits for its current sleep before exiting so only the gated shell is a leftover.
  const trap = ignoreTerm ? 'trap "" TERM' : 'trap "exit 0" TERM';
  const child = `${trap}; echo $$ > "$1/child.tmp" && mv "$1/child.tmp" "$1/child.pid" || exit 1;
    while [ -d "$1" ] && [ ! -e "$1/gate" ]; do sleep 0.02; done`;
  const command = `d=$1; echo $$ > "$d/command.tmp" && mv "$d/command.tmp" "$d/command.pid" || exit 1;
    sh -c '${child}' sh "$d" &
    while [ -d "$d" ] && [ ! -e "$d/gate" ] && [ ! -e "$d/child.pid" ]; do :; done
    [ -e "$d/child.pid" ] || exit 1
    ${commandExit}`;
  return ["sh", "-c", command, "sh", fixture.dir];
}

/** Starts the fixture and records both original identities before a test signals or opens the gate. */
async function launchDescendant(fixture: SlotFixture, ignoreTerm: boolean, commandExit: "wait" | "exit 0", env?: NodeJS.ProcessEnv) {
  const run = runner(fixture, RUN_COMMAND, commandWithChild(fixture, ignoreTerm, commandExit), { env });
  const command = await publishedPid(fixture, "command");
  const child = await publishedPid(fixture, "child");
  return { run, command, child };
}

/** Waits for the drain checkpoint or captures the old runner's premature result with the child still alive. */
async function drainStarted(fixture: SlotFixture, child: number): Promise<void> {
  await waitUntil(() => traceEvents(fixture).includes("draining 1") || readText(fixture.out).includes("code "),
    "the drain checkpoint or runner result", CHECKPOINT_MS);
  const returned = readText(fixture.out).split("\n").find(line => line.startsWith("code "));
  if (returned !== undefined && existsSync(`/proc/${child}`)) {
    throw new Error(`runner reported ${returned} while gated child ${child} was still alive`);
  }
  expect(traceEvents(fixture)).toContain("draining 1");
}

/** Reads the checkpoint names without the trace's diagnostic timestamps. */
function traceEvents(fixture: SlotFixture): string[] {
  return readText(fixture.trace).trimEnd().split("\n").map(line => line.split("\t", 1)[0]);
}

/** Waits for the runner process to finish, including any last listener report. */
async function runnerFinished(child: { exitCode: number | null; signalCode: NodeJS.Signals | null }, bound: number): Promise<void> {
  await waitUntil(() => child.exitCode !== null || child.signalCode !== null, "the runner to exit", bound);
  expect(child.signalCode).toBeNull();
  expect(child.exitCode).toBe(0);
}

/** The private lock is available if the previous holder has released it. */
function lockStatus(fixture: SlotFixture): number | null {
  return Bun.spawnSync(["flock", "--nonblock", "--conflict-exit-code", "75", fixture.lock, "true"]).exitCode;
}

/** The run restores both listener counts before returning. */
function expectListenersRestored(fixture: SlotFixture): void {
  const lines = readText(fixture.out).split("\n").filter(line => line.startsWith("listeners "));
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe(lines[0]);
}

/** An exec'd sleep holds the slot until the test signals its recorded identity. */
async function holdSlot(fixture: SlotFixture) {
  const holder = Bun.spawn(["flock", "--no-fork", fixture.lock, "sh", "-c",
    'echo $$ > "$1/holder.tmp" && mv "$1/holder.tmp" "$1/holder.pid"; exec sleep 30', "sh", fixture.dir],
  { stdout: "ignore", stderr: "ignore" });
  register(holder.pid);
  await publishedPid(fixture, "holder");
  return holder.pid;
}

test("a SIGTERM run stays pending while a TERM-ignoring descendant lives, then reaps all processes and frees the lock", async () => {
  const fixture = slotFixture();
  const { run, command, child } = await launchDescendant(fixture, true, "wait");
  signal(run.pid, "SIGTERM");
  await drainStarted(fixture, child);
  expect(readText(fixture.out)).not.toContain("code ");
  expect(lockStatus(fixture)).toBe(75);
  writeFileSync(join(fixture.dir, "gate"), "");
  await runnerFinished(run, DRAIN_MS);
  expect(readText(fixture.out)).toContain("code 1\n");
  expect(existsSync(`/proc/${command}`)).toBe(false);
  expect(existsSync(`/proc/${child}`)).toBe(false);
  expect(lockStatus(fixture)).toBe(0);
  expectListenersRestored(fixture);
});

test("an exit-0 command's same-group descendant is ended and named while the run keeps exit 0", async () => {
  const fixture = slotFixture();
  const { run, child } = await launchDescendant(fixture, false, "exit 0");
  await drainStarted(fixture, child);
  await runnerFinished(run, DRAIN_MS);
  const events = traceEvents(fixture);
  const expected = ["command-exit 0", "draining 1", `term ${child}`, `reaped ${child}`, "drained"];
  expect(events.filter(event => expected.includes(event))).toEqual(expected);
  expect(readText(fixture.out)).toContain("code 0\n");
  expect(readText(fixture.err)).toContain(`ended 1 process(es) left by the command: ${child} sh`);
  expect(lockStatus(fixture)).toBe(0);
});

test("a SIGTERM after the command exited 0 makes the run return 1", async () => {
  const fixture = slotFixture();
  const { env, advance, observed } = controlledDrainClock(fixture);
  const { run, child } = await launchDescendant(fixture, true, "exit 0", env);
  await drainStarted(fixture, child);
  await waitUntil(() => traceEvents(fixture).includes(`term ${child}`), "TERM to the gated child", CHECKPOINT_MS);
  signal(run.pid, "SIGTERM");
  advance(999);
  await waitUntil(() => readText(observed) === "999", "a drain pass just below the grace boundary", CHECKPOINT_MS);
  expect(traceEvents(fixture)).not.toContain(`kill ${child}`);
  expect(existsSync(`/proc/${child}`)).toBe(true);
  advance(1_000);
  await runnerFinished(run, CHECKPOINT_MS);
  expect(readText(fixture.out)).toContain("code 1\n");
  expect(traceEvents(fixture)).toContain(`kill ${child}`);
  expect(traceEvents(fixture)).toContain("drained");
});

/** The first probe handles TERM and reports ordinary contention. Any queued flock leaves a marker. */
function gatedProbe(fixture: SlotFixture): NodeJS.ProcessEnv {
  writeFileSync(join(fixture.dir, "flock"), `#!/bin/sh
d=\${0%/*}
if [ "$1" = --no-fork ]; then
  touch "$d/queued"
elif [ ! -e "$d/probe.pid" ]; then
  trap 'exit 75' TERM
  echo $$ > "$d/probe.tmp" && mv "$d/probe.tmp" "$d/probe.pid" || exit 1
  while [ -d "$d" ] && [ ! -e "$d/gate" ]; do sleep 0.02; done
  exit 75
fi
exec "$SLOT_TEST_FLOCK" "$@"
`, { mode: 0o755 });
  return { PATH: `${fixture.dir}:${process.env.PATH}`, SLOT_TEST_FLOCK: Bun.which("flock")! };
}

test("a SIGTERM during the probe starts no waiter and a second run takes the slot", async () => {
  const fixture = slotFixture();
  const holder = await holdSlot(fixture);
  const run = runner(fixture, `
    publish("code " + await run(command));
    while (!existsSync(join(dir, "gate"))) await Bun.sleep(20);
    publish("code " + await run(["sh", "-c", 'touch "$1/second-started"', "sh", dir]));
    listeners();
  `, ["sh", "-c", 'touch "$1/started"', "sh", fixture.dir], { env: gatedProbe(fixture) });
  await publishedPid(fixture, "probe");
  signal(run.pid, "SIGTERM");
  await waitUntil(() => readText(fixture.out).includes("code 1\n") || run.signalCode !== null, "the cancelled probe's result", CHECKPOINT_MS);
  expect(run.signalCode).toBeNull();
  expect(readText(fixture.out)).toContain("code 1\n");
  expect(existsSync(join(fixture.dir, "queued"))).toBe(false);
  expect(existsSync(join(fixture.dir, "started"))).toBe(false);
  signal(holder, "SIGTERM");
  writeFileSync(join(fixture.dir, "gate"), "continue");
  await runnerFinished(run, DRAIN_MS);
  expect(readText(fixture.out)).toContain("code 0\n");
  expect(existsSync(join(fixture.dir, "second-started"))).toBe(true);
  expectListenersRestored(fixture);
});

/** Find the flock waiter after its requester publishes the contention line. */
function queuedFlock(requester: number): number | undefined {
  const pid = childrenOf(requester).find(pid => readText(`/proc/${pid}/comm`) === "flock\n");
  return pid === undefined ? undefined : register(pid);
}

test("a queued run with an unreaped dead requester starts nothing and frees the lock", async () => {
  const fixture = slotFixture();
  const holder = await holdSlot(fixture);
  runner(fixture, RUN_COMMAND, ["sh", "-c", 'touch "$1/started"', "sh", fixture.dir], { unreaped: true });
  const requester = await publishedPid(fixture, "req");
  await waitUntil(() => readText(fixture.out).includes("waiting for the unit slot"), "the slot contention line", CHECKPOINT_MS);
  let waiter: number | undefined;
  await waitUntil(() => (waiter = queuedFlock(requester)) !== undefined, "the requesting process's flock waiter", CHECKPOINT_MS);
  signal(requester, "SIGKILL");
  await waitUntil(() => procFields(requester)[0] === "Z", "the unreaped requester", CHECKPOINT_MS);
  signal(holder, "SIGTERM");
  await waitUntil(() => procFields(waiter!)[0] === "Z" || !existsSync(`/proc/${waiter}`), "the queued waiter to exit", DRAIN_MS);
  expect(existsSync(join(fixture.dir, "started"))).toBe(false);
  expect(readText(fixture.err)).toContain("the run that asked for the slot is gone, nothing run");
  expect(lockStatus(fixture)).toBe(0);
  expect(readText(fixture.trace)).not.toContain("command ");
});

/** Installs a test preload only in the reaper process, before its command can be spawned. */
function reaperPreload(fixture: SlotFixture, body: string): NodeJS.ProcessEnv {
  const preload = join(fixture.dir, "preload.ts");
  writeFileSync(preload, `if (process.argv[1]?.endsWith("/test-slot-reaper.ts")) { ${body} }`);
  return { BUN_OPTIONS: `--preload ${preload}` };
}

/** Advances the shared fake clock in the isolated CLI and acknowledges each completed drain pass. */
function controlledDrainClock(fixture: SlotFixture) {
  const target = join(fixture.dir, "clock-target");
  const observed = join(fixture.dir, "clock-observed");
  writeFileSync(target, "0");
  const env = reaperPreload(fixture, `
    const { createFakeClock } = await import(${JSON.stringify(join(import.meta.dir, "../src/test-support/fake-bot/fake-clock.ts"))});
    const { readFileSync, writeFileSync, renameSync } = await import("node:fs");
    const clock = createFakeClock({ mode: "manual" });
    // The CLI is outside Bun's test runner, so the shared clock cannot install node:test mock timers here.
    Object.defineProperty(performance, "now", { value: clock.now });
    const sleep = Bun.sleep;
    Bun.sleep = async ms => {
      if (ms > 0) {
        writeFileSync(${JSON.stringify(observed + ".tmp")}, String(clock.now()));
        renameSync(${JSON.stringify(observed + ".tmp")}, ${JSON.stringify(observed)});
        const time = Number(readFileSync(${JSON.stringify(target)}, "utf8"));
        if (time > clock.now()) await clock.advance(time - clock.now());
      }
      await sleep(ms);
    };
  `);
  const advance = (ms: number) => {
    writeFileSync(target + ".tmp", String(ms));
    renameSync(target + ".tmp", target);
  };
  return { env, advance, observed };
}

test("a cancellation delivered during command spawn reaches the new command", async () => {
  const fixture = slotFixture();
  const env = reaperPreload(fixture, `
    const spawn = Bun.spawn;
    Bun.spawn = (...argv) => {
      process.kill(process.pid, "SIGTERM");
      return spawn(...argv);
    };
  `);
  const run = runner(fixture, RUN_COMMAND, ["sh", "-c",
    'echo $$ > "$1/command.tmp" && mv "$1/command.tmp" "$1/command.pid"; exec sleep 30', "sh", fixture.dir], { env });
  await runnerFinished(run, CHECKPOINT_MS);
  expect(traceEvents(fixture)).toContain("command-exit SIGTERM");
  expect(readText(fixture.out)).toContain("code 1\n");
  expect(lockStatus(fixture)).toBe(0);
});

test("a direct command that ignores TERM is killed and reaped before cancellation returns", async () => {
  const fixture = slotFixture();
  const run = runner(fixture, RUN_COMMAND, ["sh", "-c",
    'trap "" TERM; echo $$ > "$1/command.tmp" && mv "$1/command.tmp" "$1/command.pid" || exit 1; while [ -d "$1" ] && [ ! -e "$1/gate" ]; do sleep 0.02; done', "sh", fixture.dir]);
  const command = await publishedPid(fixture, "command");
  signal(run.pid, "SIGTERM");
  await runnerFinished(run, DRAIN_MS);
  expect(readText(fixture.out)).toContain("code 1\n");
  expect(traceEvents(fixture)).toContain("command-exit SIGKILL");
  expect(existsSync(`/proc/${command}`)).toBe(false);
  expect(lockStatus(fixture)).toBe(0);
});

test("a reaper that cannot become a subreaper runs nothing and returns 1", async () => {
  const { runReaper } = await import("./test-slot-reaper.js");
  const fixture = slotFixture();
  const lines: string[] = [];
  const code = await runReaper({
    command: ["sh", "-c", 'touch "$1/started"', "sh", fixture.dir],
    env: {},
    prctl: () => 22,
    say: line => lines.push(line),
  });
  expect(code).toBe(1);
  expect(lines).toEqual(["test:fast: cannot become a subreaper: 22"]);
  expect(existsSync(join(fixture.dir, "started"))).toBe(false);
});

test("a proc file whose process exits between open and read reads as gone (ESRCH), and other read errors still throw", () => {
  const exited = Object.assign(new Error("ESRCH: no such process, read"), { code: "ESRCH" });
  expect(readText("/proc/4000000/stat", () => { throw exited; })).toBe("");
  const denied = Object.assign(new Error("EACCES: permission denied, read"), { code: "EACCES" });
  expect(() => readText("/proc/1/stat", () => { throw denied; })).toThrow("EACCES");
});
