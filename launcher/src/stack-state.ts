// What the running stack is made of (state, outside dependencies, the snapshot the control server serves) and the wait they share.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { chatAudience, type ChatAudience } from "./chat/audience.ts";
import { appRoot } from "./paths.ts";
import { probeServer } from "./install/probe.ts";
import { ollamaExeFor } from "./install/ollama.ts";
import type { Manifest } from "./manifest.ts";
import { freePort } from "./ports.ts";
import { listProcesses, type ProcessLister } from "./process-list.ts";
import { killProcess, type Child, type Children, type KillPid } from "./processes.ts";
import { settingsFileExists, settingsPath, type Settings } from "./settings.ts";

/** The part of `Children` the stack uses; tests supply a scripted one. */
export type ChildRunner = Pick<Children, "spawn" | "stop" | "stopAll">;

/** Everything the stack takes from outside, so a test starts no process, opens no socket and waits no real time. */
export interface StackDeps {
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  probeServer: typeof probeServer;
  ollamaExe(): string | null;
  fileExists(path: string): boolean;
  /** Whether the data root holds a settings file, read once when the stack is created (`StackState.settingsFound`). */
  settingsFileExists(): boolean;
  freePort: typeof freePort;
  listProcesses: ProcessLister;
  killProcess: KillPid;
  /** The Bun that runs the launcher: it runs the hosts and brains too. */
  bunPath: string;
  appRoot: string;
  /** One line for the player: the console shows it and the launcher log keeps it. */
  say(line: string): void;
  /** Starts the chat command sources once the stack runs; absent: the real ones (`chat/sources.ts`). A stack test supplies a recording stand-in, since the real loops poll for as long as the stack runs. */
  startChatCommands?(state: StackState): ChatCommandsHandle;
}

/** The running chat command sources; `stop()` ends the polling and the listener and drops every answer still to come. */
export interface ChatCommandsHandle {
  stop(): Promise<void>;
}

/** `root`: the data root, where the install recorded the `ollama.exe` it put in a folder the player chose. */
export function realStackDeps(say: (line: string) => void, root: string): StackDeps {
  return {
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    probeServer,
    ollamaExe: () => ollamaExeFor(root),
    fileExists: existsSync,
    settingsFileExists: () => settingsFileExists(root),
    freePort,
    listProcesses,
    killProcess,
    bunPath: process.execPath,
    appRoot: appRoot(),
    say,
  };
}

export type BotStatus = "starting" | "running" | "stopping" | "ended";
export interface RunningBot {
  readonly id: string;
  readonly username: string;
  hostPort: number;
  status: BotStatus;
}

/** `failed`: a service could not start (`problem` says which) and nothing runs; the launcher stays up until the console has shown it. */
export type StackPhase = "starting" | "running" | "failed" | "stopping" | "stopped";

export interface StackState {
  readonly settings: Settings;
  readonly manifest: Manifest;
  readonly children: ChildRunner;
  readonly root: string;
  readonly deps: StackDeps;
  /** False when the data root had no settings file at creation: the settings are the defaults, and the lines say which path was read. */
  readonly settingsFound: boolean;
  phase: StackPhase;
  /** The one line saying why the stack could not come up; null while it is fine. */
  problem: string | null;
  readonly bots: Map<string, RunningBot>;
  /** The Ollama the brains use; `owned` is true only for the serve this launcher started (the only one it stops). */
  ollama: { readonly baseUrl: string; readonly pid?: number; readonly owned: boolean } | null;
  /** The local Minecraft server; its stdin is the console. */
  server: Child | null;
  /** Where the hosts connect; null when no server is set. */
  serverTarget: { readonly host: string; readonly port: number } | null;
  /** The start of the stack, so a stop request waits for it to give up instead of racing it. */
  bringUp: Promise<void> | null;
  stopping: Promise<void> | null;
  /** Bot starts run one after the other: two at once could pick the same free port. */
  botQueue: Promise<unknown>;
  /** The name our chat listener is logged in with while it is joined, else null; the brains must not answer it (`writeOtherAgents`). */
  listenerJoined: string | null;
  /** The chat command sources while they run (started when the stack is `running`, stopped first by `stopStack`). */
  chatCommands: ChatCommandsHandle | null;
  /** Called with every line the local Minecraft server prints; the chat command console source sets it. */
  onServerLine?: ((line: string) => void) | undefined;
}

export const logFile = (state: StackState, name: string): string => join(state.root, "logs", `${name}.log`);

export function isStopRequested(state: StackState): boolean {
  return state.phase === "stopping" || state.phase === "stopped";
}

const WAIT_POLL_MS = 500;

/**
 * Polls `check` every half second until it is true, `exited` settles (the process ended: no use waiting on), the
 * stack is asked to stop, or `timeoutMs` passed.
 */
export async function waitUntilReady(state: StackState, check: () => Promise<boolean> | boolean, exited: Promise<unknown>, timeoutMs: number): Promise<"ready" | "exited" | "timeout" | "stopped"> {
  let ended = false;
  void exited.then(() => (ended = true));
  const deadline = state.deps.now() + timeoutMs;
  while (state.deps.now() < deadline) {
    if (isStopRequested(state)) return "stopped";
    if (ended) return "exited";
    if (await check()) return "ready";
    await state.deps.sleep(WAIT_POLL_MS);
  }
  return ended ? "exited" : "timeout";
}

export interface StackStatus {
  readonly phase: StackPhase;
  readonly problem: string | null;
  readonly llm: { readonly kind: "local" | "remote"; readonly model: string };
  readonly server: "none" | "local" | "remote";
  /** The address a player joins (`localhost:25565`, or the remote server's); null with no server. */
  readonly join: string | null;
  readonly minecraftVersion: string;
  readonly settingsPath: string;
  /** False when `settingsPath` did not exist: the stack runs on the defaults. */
  readonly settingsFound: boolean;
  readonly bots: readonly { readonly id: string; readonly username: string; readonly hostPort: number; readonly status: BotStatus }[];
  /** The chat commands (`!bots` ...) the start banner explains: the prefix and who may use them. */
  readonly commands: { readonly prefix: string; readonly audience: ChatAudience };
}

/** The snapshot of the stack for `GET /status` and the start banner. */
export function describeStack(state: StackState): StackStatus {
  const { server, llm } = state.settings;
  const join = server.kind === "local" ? `localhost:${server.port}` : server.kind === "remote" ? `${server.host}:${server.port}` : null;
  return {
    phase: state.phase,
    problem: state.problem,
    llm: { kind: llm.kind, model: llm.model },
    server: server.kind,
    join,
    minecraftVersion: state.manifest.minecraft.version,
    settingsPath: settingsPath(state.root),
    settingsFound: state.settingsFound,
    bots: [...state.bots.values()].map(({ id, username, hostPort, status }) => ({ id, username, hostPort, status })),
    commands: { prefix: state.settings.commands.prefix, audience: chatAudience(state.settings, state.root) },
  };
}
