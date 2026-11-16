/** Machine-wide unit-test slot, holder records, and signal forwarding for the parallel suite. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * The unit slot: one `test:fast` at a time on this machine, so ten started at once queue instead of starving each
 * other. The lock is `MINE_AI_TEST_SLOT_LOCK` when set, else under the home's cache folder.
 */
export function slotLockPath(env: NodeJS.ProcessEnv, home: string): string {
  return env.MINE_AI_TEST_SLOT_LOCK || join(home, ".cache/mine-ai/test-fast.lock");
}

/** A run queues for the slot unless `--no-slot` was given or it already runs in the slot (`MINE_AI_TEST_SLOT_HELD=1`). */
export function needsSlot(slot: boolean, env: NodeJS.ProcessEnv): boolean {
  return slot && env.MINE_AI_TEST_SLOT_HELD !== "1";
}

const FLOCK_BUSY = 75;

/**
 * A clock all processes read alike (`performance.timeOrigin` is each process's start on the wall clock; `hrtime` is
 * relative to its own process start, so a child's reading would not compare with its parent's), in nanoseconds.
 */
function slotClockNs(): bigint {
  return BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
}

interface Finished {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Runs `argv` in its own process group, with `stdio` inherited; a SIGINT or SIGTERM this process gets goes to the whole
 * group (the flock and its command, the command's shards).
 */
function runGroup(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { env, stdio: "inherit", detached: true });
    const forward = (signal: NodeJS.Signals) => (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group has already exited
      }
    };
    const onInterrupt = forward("SIGINT");
    const onTerminate = forward("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    const stop = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    child.once("error", (error) => {
      stop();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      stop();
      resolve({ code, signal });
    });
  });
}

/** Whether a pid is running (signal 0: nothing is sent). `EPERM` means it runs under another user. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * The holder's line of `<lock>.holder` (`pid <p>, <root>, since <since>`), or `unknown` when the file is missing,
 * unreadable, or names a pid that is no longer running.
 */
function holderOf(lock: string): string {
  try {
    const holder = JSON.parse(readFileSync(`${lock}.holder`, "utf8")) as { pid?: unknown; root?: unknown; since?: unknown };
    if (typeof holder.pid !== "number" || typeof holder.root !== "string" || typeof holder.since !== "string") return "unknown";
    if (!pidAlive(holder.pid)) return "unknown";
    return `pid ${holder.pid}, ${holder.root}, since ${holder.since}`;
  } catch {
    return "unknown";
  }
}

/**
 * Runs `command` in the unit slot and returns its exit. A probe takes the lock without running anything: busy (75)
 * says `waiting for the unit slot, held by <holder>` and the run then queues on the lock with a blocking `flock`. The
 * command runs under that `flock`, so its own exit (even 75) is its result, never taken for a busy lock. Without
 * `flock` the command runs with no slot.
 */
export async function runInSlot(
  command: readonly string[],
  lock: string,
  env: NodeJS.ProcessEnv,
  say: (line: string) => void,
): Promise<number> {
  const flock = Bun.which("flock", { PATH: env.PATH ?? "" });
  if (flock === null) {
    say("test:fast: no flock here, running without the unit slot");
    const alone = await runGroup(command, { ...env, MINE_AI_TEST_SLOT_HELD: "1" });
    return alone.code ?? 1;
  }
  try {
    mkdirSync(dirname(lock), { recursive: true });
  } catch (error) {
    say(`test:fast: cannot make the unit slot folder ${dirname(lock)}: ${(error as Error).message}`);
    return 1;
  }
  const probe = await runGroup([flock, "--nonblock", "--conflict-exit-code", String(FLOCK_BUSY), lock, "true"], env);
  if (probe.code === FLOCK_BUSY) say(`test:fast: waiting for the unit slot, held by ${holderOf(lock)}`);
  else if (probe.code !== 0) {
    say(`test:fast: flock failed (exit ${probe.code ?? probe.signal ?? "unknown"})`);
    return 1;
  }
  const queued: NodeJS.ProcessEnv = {
    ...env,
    MINE_AI_TEST_SLOT_HELD: "1",
    MINE_AI_TEST_SLOT_ASKED_NS: slotClockNs().toString(),
    MINE_AI_TEST_SLOT_PARENT: String(process.pid),
  };
  const run = await runGroup([flock, lock, ...command], queued);
  return run.code ?? 1;
}

/** Whether the run that asked for the slot still lives. */
export function parentAlive(pid: string | undefined): boolean {
  return pidAlive(Number(pid));
}

/**
 * The holder file the other queued runs read: written in temp then renamed, so a reader never sees half of it. It only
 * names the run for the others, so a write that fails (no folder, a read-only home) does not fail the run.
 */
export function writeHolder(lock: string, root: string): void {
  try {
    mkdirSync(dirname(lock), { recursive: true });
    const temp = `${lock}.holder.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ pid: process.pid, root, since: new Date().toISOString() })}\n`);
    renameSync(temp, `${lock}.holder`);
  } catch {
    // advisory: the waiting runs say `unknown` for the holder
  }
}

/** Removes the holder file when this run wrote it, so a later waiter does not name a run that is gone. */
export function releaseHolder(lock: string): void {
  try {
    const holder = JSON.parse(readFileSync(`${lock}.holder`, "utf8")) as { pid?: unknown };
    if (holder.pid === process.pid) unlinkSync(`${lock}.holder`);
  } catch {
    // no holder file, or not readable: nothing of ours to remove
  }
}

/** Seconds this run waited for the slot, from the asking run's clock reading in the environment; undefined outside a slot. */
export function slotWaitSeconds(env: NodeJS.ProcessEnv): number | undefined {
  if (env.MINE_AI_TEST_SLOT_ASKED_NS === undefined) return undefined;
  return Number(slotClockNs() - BigInt(env.MINE_AI_TEST_SLOT_ASKED_NS)) / 1e9;
}

