// Starts the listener child (`listener/main.ts`) for the supervisor: its stdout as an async line stream, its stdin for whispers.
import { appEntry } from "../paths.ts";
import type { Child } from "../processes.ts";
import { logFile, type StackState } from "../stack-state.ts";
import type { ListenerProcess } from "./supervisor.ts";

/** The listener leaves when its stdin closes and exits by itself; this is how long that may take before it is killed. */
const LISTENER_EXIT_WAIT_MS = 5_000;
const LISTENER_KILL_WAIT_MS = 5_000;
/** How long the output stream outlives the process's `exit` event, for lines still in the pipe. */
const LISTENER_OUTPUT_DRAIN_MS = 500;

/** Lines pushed by the child's output callback, read by `for await`; `close()` ends the stream after the lines already queued. */
class LineStream implements AsyncIterable<string> {
  private readonly queued: string[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(line: string): void {
    this.queued.push(line);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    this.waiting?.();
    this.waiting = null;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for (;;) {
      const line = this.queued.shift();
      if (line !== undefined) yield line;
      else if (this.closed) return;
      else await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }
}

/** Ends this child only (never a child of the same name started later): closes its stdin, then kills it if it does not exit. */
async function stopListenerChild(state: StackState, child: Child): Promise<void> {
  child.stdin?.end();
  const exitedInTime = await Promise.race([child.exited.then(() => true), state.deps.sleep(LISTENER_EXIT_WAIT_MS).then(() => false)]);
  if (exitedInTime || !child.isRunning() || child.pid === undefined) return;
  state.deps.killProcess(child.pid);
  await Promise.race([child.exited, state.deps.sleep(LISTENER_KILL_WAIT_MS)]);
}

/** `bun launcher/src/listener/main.ts --host ... --prefix ...` for the remote server, as the supervisor's `ListenerProcess`. */
export function spawnListenerProcess(state: StackState): ListenerProcess {
  const target = state.serverTarget;
  if (target === null) throw new Error("There is no Minecraft server to join, so there is nothing for the chat command listener to join.");
  const { appRoot, bunPath } = state.deps;
  const lines = new LineStream();
  const args = [
    appEntry(appRoot, "launcher/src/listener/main.ts"),
    "--host", target.host,
    "--port", String(target.port),
    "--version", state.manifest.minecraft.version,
    "--username", state.settings.commands.listenerName,
    "--prefix", state.settings.commands.prefix,
  ];
  const child = state.children.spawn("listener", bunPath, args, {
    env: {},
    cwd: appRoot,
    logFile: logFile(state, "listener"),
    stdin: "pipe",
    onLine: (line, stream) => {
      if (stream === "stdout") lines.push(line);
    },
  });
  // The `exit` event can come before the last stdout line (the `ended` line of a kick is the last thing the listener writes): the stream stays open briefly after it.
  void child.exited.then(() => state.deps.sleep(LISTENER_OUTPUT_DRAIN_MS)).then(() => lines.close());
  return {
    lines,
    write: (line) => void child.stdin?.write(line),
    stop: () => stopListenerChild(state, child),
    exited: child.exited,
  };
}
