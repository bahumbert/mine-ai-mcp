// Runs the launcher's own `ollama serve` (manifest port and env) for the length of one install step.
import { spawn } from "node:child_process";
import type { Manifest } from "../manifest.ts";
import { loadInstallState, type InstallState } from "./state.ts";

const VERSION_REQUEST_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 250;
const KILL_WAIT_MS = 5_000;
const LOG_TAIL_CHARS = 400;

export interface ServeProcess {
  /** Calls back with each piece of stdout and stderr text (Ollama logs to stderr). */
  onOutput(callback: (text: string) => void): void;
  /** Settles with the exit code once the process ended and its output was delivered. */
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface ServeDeps {
  startServe(exe: string, env: Record<string, string>): ServeProcess;
  fetch: typeof fetch;
  sleep(ms: number): Promise<void>;
}

/** What a step gets while our serve runs. `reused`: an Ollama already answered on the port, so there is no log to read. */
export type OurServe = { baseUrl: string; reused: boolean; output(): string };

type ServeSettings = { ollama: Pick<Manifest["ollama"], "port" | "env">; waits: Pick<Manifest["waits"], "ollamaUpMs"> };

/** Thrown when our serve cannot be started or does not answer; the message names the port and the log tail. */
export class ServeUnavailableError extends Error {}

/**
 * The environment of every `ollama serve` of ours (an install step's and the stack's): the manifest's settings, the
 * host and port, and our model store when the setup chose one and the Ollama is ours (a player's Ollama keeps the
 * player's store). Two builders would pull a model into one store and serve from another.
 */
export function ollamaServeEnv(manifest: ServeSettings, port: number, state: InstallState): Record<string, string> {
  const ownStore: Record<string, string> = state.ollama === "installed" && state.ollamaModels ? { OLLAMA_MODELS: state.ollamaModels } : {};
  return { ...manifest.ollama.env, OLLAMA_HOST: `127.0.0.1:${port}`, ...ownStore };
}

/**
 * Starts our `ollama serve`, waits until `/api/version` answers (at most `waits.ollamaUpMs`), runs `work`, and always
 * kills the serve it started. An Ollama already answering on the port is used as it is and never stopped.
 */
export async function withOurOllamaServe<T>(exe: string, manifest: ServeSettings, root: string, work: (serve: OurServe) => Promise<T>, deps: ServeDeps = realServeDeps): Promise<T> {
  const port = manifest.ollama.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  if (await answersVersion(baseUrl, deps)) return await work({ baseUrl, reused: true, output: () => "" });

  const env = { ...definedEnv(process.env), ...ollamaServeEnv(manifest, port, loadInstallState(root)) };
  const serve = deps.startServe(exe, env);
  let log = "";
  serve.onOutput((text) => (log += text));
  try {
    await waitUntilAnswering(baseUrl, serve, () => log, manifest.waits.ollamaUpMs, deps);
    return await work({ baseUrl, reused: false, output: () => log });
  } finally {
    serve.kill();
    await Promise.race([serve.exited, deps.sleep(KILL_WAIT_MS)]);
  }
}

/** The names in the serve's model list, as Ollama prints them (`name:tag`). */
export async function listModelNames(serve: OurServe, deps: ServeDeps): Promise<string[]> {
  const response = await deps.fetch(`${serve.baseUrl}/api/tags`);
  if (!response.ok) throw new ServeUnavailableError(`Ollama answered ${response.status} to the list of models.`);
  const body = (await response.json()) as { models?: { name?: string; model?: string }[] };
  return (body.models ?? []).flatMap((entry) => entry.name ?? entry.model ?? []);
}

/** Ollama lists an untagged model as `<name>:latest`. */
export function withLatestTag(tag: string): string {
  return tag.includes(":") ? tag : `${tag}:latest`;
}

async function waitUntilAnswering(baseUrl: string, serve: ServeProcess, log: () => string, timeoutMs: number, deps: ServeDeps): Promise<void> {
  const exitedFirst = serve.exited.then((code) => ({ code }));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answersVersion(baseUrl, deps)) return;
    const exit = await Promise.race([exitedFirst, deps.sleep(POLL_INTERVAL_MS).then(() => null)]);
    if (exit) throw new ServeUnavailableError(`ollama serve on ${baseUrl} exited with code ${exit.code} before it answered: ${logTail(log())}`);
  }
  throw new ServeUnavailableError(`ollama serve on ${baseUrl} did not answer within ${timeoutMs} ms: ${logTail(log())}`);
}

async function answersVersion(baseUrl: string, deps: ServeDeps): Promise<boolean> {
  try {
    const response = await deps.fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_REQUEST_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/** The end of a serve log for an error message, where the cause is. */
export function logTail(log: string): string {
  const tail = log.trim().slice(-LOG_TAIL_CHARS);
  return tail === "" ? "(no output)" : tail;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The real process: no console window, output collected, never outlives a kill. `args` is for tests only. */
export function startServeProcess(exe: string, env: Record<string, string>, args: string[] = ["serve"]): ServeProcess {
  const child = spawn(exe, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const listeners: ((text: string) => void)[] = [];
  const deliver = (chunk: Buffer) => listeners.forEach((listener) => listener(chunk.toString("utf8")));
  child.stdout.on("data", deliver);
  child.stderr.on("data", deliver);
  const exited = new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return { onOutput: (callback) => listeners.push(callback), exited, kill: () => void child.kill() };
}

export const realServeDeps: ServeDeps = {
  startServe: startServeProcess,
  fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
