// `mine-ai console` (the Start-menu entry): starts the background launcher if needed and shows its status stream.
// Closing this window ends the stream, which is the launcher's cue to run the ordered stop (spec D3).
import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fetchErrorText } from "./fetch-error.ts";
import { CONTROL_HEADER, findRunningLauncher, realLockDeps, type LauncherLock } from "./control.ts";
import { appEntry } from "./paths.ts";
import type { StackStatus } from "./stack.ts";

/** The launcher writes its lock before it starts any service, so this wait is for the process start only. */
const LAUNCHER_START_WAIT_MS = 30_000;
/** A stop saves the world: the manifest allows the server `serverStopMs`, and the model unload follows. */
const LAUNCHER_STOP_WAIT_MS = 120_000;
const POLL_MS = 250;
export const EXPECT_CONSOLE_FLAG = "--expect-console";

export interface ConsoleDeps {
  readonly logsFolder: string;
  findRunningLauncher(): Promise<LauncherLock | null>;
  startLauncher(): void;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  write(line: string): void;
  /** Keeps the window open until the player has read the last lines. */
  waitForEnter(): Promise<void>;
  /** Whether the window shows ANSI styles (a terminal, and `NO_COLOR` not set). */
  readonly color: boolean;
}

/** The chat commands of the game, or why none work: a remote server with no listed player is the case the player must act on. */
function chatCommandsLine({ prefix, audience }: StackStatus["commands"]): string {
  const commands = `${prefix}bots lists the bots, ${prefix}bot start <name> and ${prefix}bot stop <name> start and stop one`;
  if (audience === "everyone") return `In the game chat: ${commands}.`;
  if (audience === "listed-players") return `In the game chat, for the players in commands.players: ${commands}.`;
  if (audience === "needs-players") return "Chat commands are off for everyone: add the players who may use them with mine-ai configure --command-players <name,name>.";
  return "Chat commands are off (commands.enabled is false in the settings file).";
}

const BOLD_ON = "\x1b[1m";
const STYLE_OFF = "\x1b[0m";

/** A line in bold for a console that shows it; the line itself when `color` is off. */
export function emphasise(line: string, color: boolean): string {
  return color ? `${BOLD_ON}${line}${STYLE_OFF}` : line;
}

/**
 * What the player reads first: the model, where to join, the settings file, and what closing the window does. `mark`
 * styles the two lines the player must act on (the join line and the chat commands); the lines stay plain by default.
 *
 * With no settings file the status holds the defaults, so neither a model nor a server problem is the player's choice:
 * the stack's own line (`noServerLine`, replayed to every console from the backlog) is the one text about it.
 */
export function bannerLines(status: StackStatus, mark: (line: string) => string = (line) => line): string[] {
  // `!== false`: a launcher started before this field existed does not send it.
  const settingsFound = status.settingsFound !== false;
  const lines = ["Mine AI"];
  if (settingsFound) lines.push(`Model: ${status.llm.kind === "local" ? `${status.llm.model} on this PC` : `${status.llm.model} on your remote endpoint`}`);
  if (status.server === "local") lines.push(mark(`Join from Minecraft Java ${status.minecraftVersion} at ${status.join}.`));
  else if (status.server === "remote") {
    lines.push(mark(`The bots join ${status.join}. That server must be vanilla Minecraft ${status.minecraftVersion} with online-mode=false.`));
  } else if (settingsFound) lines.push(`No Minecraft server is set. Put one in ${status.settingsPath} ("server"), then open Mine AI again.`);
  if (status.server !== "none") lines.push(mark(chatCommandsLine(status.commands)));
  lines.push(`Settings: ${status.settingsPath}`, "Close this window to stop Mine AI.", "");
  return lines;
}

/**
 * `mine-ai start --expect-console` as a process of its own: no console, no handle shared with this one, so closing this
 * window does not reach it. The flag makes the launcher stop itself when no console attaches (this one gave up or was
 * closed before it attached), instead of running with no window.
 */
export function startBackgroundLauncher(bunPath: string, appRoot: string, spawnImpl: typeof nodeSpawn = nodeSpawn): void {
  const child = spawnImpl(bunPath, [appEntry(appRoot, "launcher/src/main.ts"), "start", EXPECT_CONSOLE_FLAG], { cwd: appRoot, detached: true, windowsHide: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

async function readStatus(launcher: LauncherLock, deps: ConsoleDeps): Promise<StackStatus | null> {
  try {
    return (await (await deps.fetch(`http://127.0.0.1:${launcher.controlPort}/status`)).json()) as StackStatus;
  } catch {
    return null;
  }
}

/** Waits (bounded) until `condition` holds; false when the wait ran out. */
async function waitFor(deps: ConsoleDeps, timeoutMs: number, condition: () => Promise<boolean>): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (await condition()) return true;
    await deps.sleep(POLL_MS);
  }
  return false;
}

/** A launcher that finished its start (control port written), after waiting out one that is still stopping. */
async function ensureLauncher(deps: ConsoleDeps): Promise<{ launcher: LauncherLock; status: StackStatus } | string> {
  let launcher = await deps.findRunningLauncher();
  let status = launcher?.controlPort ? await readStatus(launcher, deps) : null;
  if (status && (status.phase === "stopping" || status.phase === "stopped")) {
    deps.write("Mine AI is still stopping from the last time; waiting for it to finish...");
    const gone = await waitFor(deps, LAUNCHER_STOP_WAIT_MS, async () => (await deps.findRunningLauncher()) === null);
    if (!gone) return "The previous Mine AI did not finish stopping. End the bun.exe and java.exe of Mine AI in Task Manager (ollama.exe and llama-server.exe too, unless you run Ollama yourself), then open Mine AI again.";
    launcher = null;
  }
  if (launcher === null) deps.startLauncher();
  let found: { launcher: LauncherLock; status: StackStatus } | null = null;
  const appeared = await waitFor(deps, LAUNCHER_START_WAIT_MS, async () => {
    const lock = await deps.findRunningLauncher();
    const current = lock?.controlPort ? await readStatus(lock, deps) : null;
    if (lock && current) found = { launcher: lock, status: current };
    return found !== null;
  });
  return appeared && found ? found : `Mine AI did not start within ${LAUNCHER_START_WAIT_MS / 1_000} s. Its logs are in ${deps.logsFolder}.`;
}

/** The text of each `data:` line of an event stream, until the stream ends (the launcher stopped or died). */
async function* streamLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (block.startsWith("data: ")) yield block.slice(6);
    }
  }
}

/**
 * Bun's own option (not in the DOM `RequestInit`): by default a stream with no byte for 360 s ends with `TimeoutError`
 * (measured 2026-10-31, Bun 1.4.2, `.agent/scripts/installer/launcher-probes/sse-idle.ts`). The attach stream is silent while a
 * bot works for minutes, so the console must not depend on the launcher's heartbeat to stay attached.
 */
const NO_IDLE_TIMEOUT: BunFetchRequestInit = { timeout: false };

/** Shows the launcher's lines until its stream ends. An error closes this window's socket; the launcher stops the stack when no other window is attached. */
async function showAttachedStream(deps: ConsoleDeps, launcher: LauncherLock): Promise<void> {
  try {
    const attached = await deps.fetch(`http://127.0.0.1:${launcher.controlPort}/attach`, { headers: { [CONTROL_HEADER]: "1" }, ...NO_IDLE_TIMEOUT });
    if (!attached.ok || attached.body === null) deps.write(`Could not attach to Mine AI (HTTP ${attached.status}).`);
    else for await (const line of streamLines(attached.body)) deps.write(line);
  } catch (error) {
    // Not "is stopping": with another window attached, or a launcher that is already gone, the stack does not stop now.
    deps.write(`This window lost its connection to Mine AI (${fetchErrorText(error)}). Mine AI stops when no window is left open. Open it again from the Start menu.`);
    return;
  }
  deps.write("Mine AI has stopped.");
}

/** Runs the console: banner, then the launcher's lines until it ends. Returns the exit code. */
export async function runConsole(deps: ConsoleDeps): Promise<number> {
  const ready = await ensureLauncher(deps);
  if (typeof ready === "string") {
    deps.write(ready);
    await deps.waitForEnter();
    return 1;
  }
  for (const line of bannerLines(ready.status, (line) => emphasise(line, deps.color))) deps.write(line);
  await showAttachedStream(deps, ready.launcher);
  await deps.waitForEnter();
  return 0;
}

/** Waits for a line on the console's stdin (Enter), or returns at once when there is no console to read from. */
export function waitForEnterOnConsole(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    const reader = createInterface({ input: process.stdin });
    reader.once("line", () => {
      reader.close();
      resolve();
    });
  });
}

export function realConsoleDeps(root: string, appRoot: string): ConsoleDeps {
  return {
    logsFolder: join(root, "logs"),
    findRunningLauncher: () => findRunningLauncher(root, realLockDeps),
    startLauncher: () => startBackgroundLauncher(process.execPath, appRoot),
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    write: (line) => console.log(line),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    waitForEnter: () => {
      console.log("Press Enter to close this window.");
      return waitForEnterOnConsole();
    },
  };
}
