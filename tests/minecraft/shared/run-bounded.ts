// Runs one child process with a bound and an abort signal, killing its whole process group when either ends it early (the node_modules installs and the snapshot syncs of the scenario mirror).
import { spawn } from "node:child_process";

const STDERR_TAIL_CHARS = 2_000;

export interface RunResult {
  readonly code: number;
  readonly stderrTail: string;
  /** The child outlived `boundMs` and was killed. */
  readonly timedOut?: boolean;
  /** The signal ended the run: the child was killed, or never started. */
  readonly aborted?: boolean;
}

export interface RunOptions {
  readonly cwd: string;
  readonly boundMs: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs `command` with an argument array (no shell) in its own process group, kills the whole group by the child's PID when it outlives
 * `boundMs` or when `signal` aborts, and answers its exit code and the end of its stderr; a child that cannot start answers code -1.
 * A signal already aborted starts nothing. The group matters: a process the child started holds the stderr pipe open, so "close" would not come at the bound.
 */
export function runBounded(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve({ code: -1, stderrTail: "", aborted: true });
  return new Promise(resolve => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: ["ignore", "ignore", "pipe"], detached: true });
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS); });
    const killGroup = (): void => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.boundMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // "error" (the command does not exist) may come without "close"; settle on whichever comes first.
    let settled = false;
    const finish = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const finishWith = (code: number | null): void => finish({ code: code ?? -1, stderrTail: stderr.trim(), ...(timedOut ? { timedOut } : {}), ...(aborted ? { aborted } : {}) });
    child.on("error", error => finish({ code: -1, stderrTail: error.message }));
    child.on("exit", code => { if (timedOut || aborted) finishWith(code); });
    child.on("close", finishWith);
  });
}
