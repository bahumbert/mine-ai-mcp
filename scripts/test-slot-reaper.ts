/** Linux only: holds the unit slot, drains the command's descendants, and names leftovers before releasing it. */
import { dlopen, FFIType, toArrayBuffer } from "bun:ffi";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";

const PR_SET_CHILD_SUBREAPER = 36;
const P_ALL = 0;
const WNOHANG = 1;
const WEXITED = 4;
const WNOWAIT = 0x01000000;
const EINTR = 4;
const ECHILD = 10;
const ENOSYS = 38;
// Read gap only, the same 20 ms used by the test:fast slot checkpoints.
const DRAIN_POLL_MS = 20;
// limit: worst TERM-to-exit was 7.496 ms (30 Bun and sh samples, 10 under suite load), ×5 rounded up to a second.
const LEFTOVER_GRACE_MS = 1_000;

const libc = process.platform === "linux" ? dlopen("libc.so.6", {
  prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
  waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  waitid: { args: [FFIType.i32, FFIType.u32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  __errno_location: { args: [], returns: FFIType.ptr },
}).symbols : undefined;

/** Reads the errno from the preceding libc call on this thread. */
function errno(): number {
  return new Int32Array(toArrayBuffer(libc!.__errno_location()!, 0, 4))[0];
}

/** Makes orphans of any descendant group reparent to this process. Returns errno, or zero on success. */
function becomeSubreaper(): number {
  if (libc === undefined) return ENOSYS;
  return libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) === 0 ? 0 : errno();
}

type Say = (line: string) => void;

/** Records each event and its monotonic timestamp without making a trace write a condition of cleanup. */
function traceTo(path: string | undefined, say: Say): Say {
  return (event) => {
    if (path === undefined) return;
    try {
      appendFileSync(path, `${event}\t${performance.now().toFixed(3)}\n`);
    } catch (error) {
      path = undefined;
      say(`test:fast: cannot write the slot trace: ${(error as Error).message}`);
    }
  };
}

/** Reads a proc file that may disappear while the corresponding process or thread exits. */
function readProc(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  }
}

/** Lists children from all threads because the thread that spawned a process may differ from the main thread. */
function childPids(): Set<number> {
  const pids = new Set<number>();
  for (const tid of readdirSync("/proc/self/task")) {
    const children = readProc(`/proc/self/task/${tid}/children`);
    if (children === "") continue;
    for (const pid of children.split(/\s+/u)) pids.add(Number(pid));
  }
  return pids;
}

/** An exiting child can cause /proc to omit another one. ECHILD confirms the empty census without consuming status. */
function hasChildren(): boolean {
  const info = new Uint8Array(128); // Linux siginfo_t; only the wait result is needed.
  if (libc!.waitid(P_ALL, 0, info, WNOHANG | WEXITED | WNOWAIT) === 0) return true;
  const error = errno();
  if (error === EINTR) return true;
  if (error === ECHILD) return false;
  throw new Error(`waitid failed: ${error}`);
}

/** Reaps only the named child, or recognizes a child whose status Bun already consumed. */
function reapChild(pid: number): "reaped" | "live" | "interrupted" {
  const result = libc!.waitpid(pid, null, WNOHANG);
  if (result === pid) return "reaped";
  if (result === 0) return "live";
  const error = errno();
  if (error === ECHILD) return "reaped";
  if (error === EINTR) return "interrupted";
  throw new Error(`waitpid(${pid}) failed: ${error}`);
}

/** Sends a signal to a child just confirmed by waitpid. It can exit between the check and the signal. */
function signalChild(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return false;
  }
}

interface Drain {
  readonly termAt: Map<number, number>;
  readonly ended: string[];
  readonly trace: Say;
}

/** Advances a single confirmed child's drain. An infinite term time marks an already sent SIGKILL. */
function drainChild(pid: number, drain: Drain): void {
  const state = reapChild(pid);
  if (state === "reaped") {
    drain.termAt.delete(pid);
    drain.trace(`reaped ${pid}`);
    return;
  }
  if (state === "interrupted") return;
  const firstTerm = drain.termAt.get(pid);
  if (firstTerm === undefined) {
    const comm = readProc(`/proc/${pid}/comm`);
    if (signalChild(pid, "SIGTERM")) {
      drain.termAt.set(pid, performance.now());
      drain.ended.push(`${pid} ${comm || "unknown"}`);
      drain.trace(`term ${pid}`);
    }
  } else if (performance.now() - firstTerm >= LEFTOVER_GRACE_MS && signalChild(pid, "SIGKILL")) {
    drain.termAt.set(pid, Infinity);
    drain.trace(`kill ${pid}`);
  }
}

/** Waits for every adopted child, including descendants reparented during this drain. */
async function drainChildren(trace: Say): Promise<string[]> {
  const drain: Drain = { termAt: new Map(), ended: [], trace };
  let children = childPids();
  trace(`draining ${children.size}`);
  while (children.size > 0 || hasChildren()) {
    for (const pid of children) drainChild(pid, drain);
    await Bun.sleep(DRAIN_POLL_MS);
    children = childPids();
  }
  trace("drained");
  return drain.ended;
}

/** Reaps exited orphans during the run so a command can observe that its own descendants are gone. */
async function waitForCommand(child: { readonly pid: number; readonly exited: Promise<number> }, trace: Say): Promise<number> {
  const collectOrphans = (): void => {
    for (const pid of childPids()) {
      if (pid !== child.pid && reapChild(pid) === "reaped") trace(`reaped ${pid}`);
    }
  };
  process.on("SIGCHLD", collectOrphans);
  try {
    collectOrphans(); // An orphan may have exited before the listener was installed.
    return await child.exited;
  } finally {
    process.off("SIGCHLD", collectOrphans);
  }
}

interface ReaperOptions {
  readonly command: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly prctl: () => number;
  readonly say: Say;
}

type DirectCommand = Bun.Subprocess<"inherit", "inherit", "inherit">;

interface Cancellation {
  signal?: NodeJS.Signals;
  child?: DirectCommand;
  starting: boolean;
  escalation?: ReturnType<typeof setTimeout>;
}

/** Gives a cancelled direct command the grace period even if it ignores the group's signal. */
function cancelCommand(state: Cancellation, signal: NodeJS.Signals, trace: Say): void {
  if (state.signal !== undefined) return;
  state.signal = signal;
  const child = state.child;
  if (child === undefined) return;
  // A signal delivered while spawn was in progress can miss the new member of the group.
  if (state.starting) child.kill(signal);
  state.escalation = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    trace(`kill ${child.pid}`);
  }, LEFTOVER_GRACE_MS);
}

/** Runs one command under the subreaper, keeping the flock descriptor open through the drain. */
export async function runReaper({ command, env, prctl, say }: ReaperOptions): Promise<number> {
  const error = prctl();
  if (error !== 0) {
    say(`test:fast: cannot become a subreaper: ${error}`);
    return 1;
  }
  const requester = env.MINE_AI_TEST_SLOT_PARENT;
  if (requester !== undefined && process.ppid !== Number(requester)) {
    say("test:fast: the run that asked for the slot is gone, nothing run");
    return 0;
  }
  const { MINE_AI_TEST_SLOT_TRACE: tracePath, ...commandEnv } = env;
  const trace = traceTo(tracePath, say);
  const cancellation: Cancellation = { starting: true };
  const onInterrupt = (): void => cancelCommand(cancellation, "SIGINT", trace);
  const onTerminate = (): void => cancelCommand(cancellation, "SIGTERM", trace);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    // Give any startup signal a turn before allowing the command to spawn.
    await Bun.sleep(0);
    if (cancellation.signal !== undefined) return 1;
    const child = Bun.spawn([...command], { stdio: ["inherit", "inherit", "inherit"], env: commandEnv });
    cancellation.child = child;
    trace(`command ${child.pid}`);
    const finished = waitForCommand(child, trace);
    await Bun.sleep(0);
    cancellation.starting = false;
    const code = await finished;
    cancellation.child = undefined;
    clearTimeout(cancellation.escalation);
    trace(`command-exit ${child.signalCode ?? code}`);
    const ended = await drainChildren(trace);
    if (ended.length > 0) say(`test:fast: ended ${ended.length} process(es) left by the command: ${ended.join(", ")}`);
    return cancellation.signal !== undefined || child.signalCode !== null ? 1 : code;
  } finally {
    clearTimeout(cancellation.escalation);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (import.meta.main) {
  // Bun strips the CLI's -- separator before exposing the script arguments.
  process.exitCode = await runReaper({ command: process.argv.slice(2), env: process.env, prctl: becomeSubreaper, say: console.error });
}
