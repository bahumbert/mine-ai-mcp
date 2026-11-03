// The stack's services besides the bots: our Ollama, the local Minecraft server, the check of a remote one.
import { join } from "node:path";
import { fetchErrorText } from "./fetch-error.ts";
import { javaPath } from "./install/java.ts";
import { ollamaServeEnv } from "./install/ollama-serve.ts";
import { loadInstallState } from "./install/state.ts";
import { runnersLeftBy, type StopResult } from "./processes.ts";
import { isStopRequested, logFile, waitUntilReady, type StackState } from "./stack-state.ts";

/** The remote check is one ping and one login; a server that needs longer is not one to start bots against. */
const REMOTE_PROBE_TIMEOUT_MS = 10_000;
const VERSION_REQUEST_TIMEOUT_MS = 2_000;
const SERVER_START_HEAP = "-Xms1G";
/** The problem line of a service whose start was cut by a stop; the stack does not report it as a failed start. */
const STOPPED_WHILE_STARTING = "Stopped while Mine AI was starting.";
const SERVER_LOG_LINES_IN_PROBLEM = 3;
const OLLAMA_STOP_TIMEOUT_MS = 10_000;
/** Vanilla prints `Done (3.2s)! For help, type "help"` when the world is loaded and players can join. */
const SERVER_READY_LINE = /\bDone \(/u;

/** The remote server must answer, run the right version and have online-mode off; otherwise the problem line and no bot. */
export async function checkRemoteServer(state: StackState): Promise<string | null> {
  const { server } = state.settings;
  if (server.kind !== "remote") return null;
  const result = await state.deps.probeServer(server.host, server.port, state.manifest.minecraft.version, REMOTE_PROBE_TIMEOUT_MS);
  if (result.up && result.versionOk === true && result.onlineMode === false) {
    state.serverTarget = { host: server.host, port: server.port };
    state.deps.say(result.detail);
    return null;
  }
  return result.detail;
}

async function answersVersion(state: StackState, baseUrl: string): Promise<boolean> {
  try {
    return (await state.deps.fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(VERSION_REQUEST_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

/**
 * Starts our `ollama serve` on the manifest's port (the next free one when something that is not an Ollama holds it)
 * with the manifest's env, then loads the model once. An Ollama already answering on the port is used as it is and is
 * never stopped. Returns the problem line, or null.
 */
export async function startOllama(state: StackState): Promise<string | null> {
  const { manifest, deps } = state;
  const exe = deps.ollamaExe();
  if (exe === null) return "Ollama is not installed. Run `mine-ai install ollama`, or choose a remote endpoint: `mine-ai configure --llm-remote <url> <key> <model>`.";
  const answering = `http://127.0.0.1:${manifest.ollama.port}`;
  if (await answersVersion(state, answering)) {
    state.ollama = { baseUrl: answering, owned: false };
    deps.say(`Using the Ollama already running on port ${manifest.ollama.port}.`);
  } else {
    const problem = await startOurOllamaServe(state, exe);
    if (problem !== null) return problem;
  }
  return await warmModel(state);
}

async function startOurOllamaServe(state: StackState, exe: string): Promise<string | null> {
  const { manifest, deps, root } = state;
  const port = await deps.freePort(manifest.ollama.port);
  if (isStopRequested(state)) return STOPPED_WHILE_STARTING;
  const baseUrl = `http://127.0.0.1:${port}`;
  const log = logFile(state, "ollama");
  deps.say("Starting Ollama...");
  const child = state.children.spawn("ollama", exe, ["serve"], { env: ollamaServeEnv(manifest, port, loadInstallState(root)), cwd: root, logFile: log });
  state.ollama = { baseUrl, ...(child.pid === undefined ? {} : { pid: child.pid }), owned: true };
  const outcome = await waitUntilReady(state, () => answersVersion(state, baseUrl), child.exited, manifest.waits.ollamaUpMs);
  if (outcome === "ready") return null;
  await stopOllama(state);
  if (outcome === "stopped") return STOPPED_WHILE_STARTING;
  const reason = outcome === "exited" ? "ended before it answered" : `did not answer within ${manifest.waits.ollamaUpMs / 1_000} s`;
  return `Ollama ${reason}. See ${log}.`;
}

/** One empty generate request loads the model into the GPU, so the first chat of a bot does not wait for it. */
async function warmModel(state: StackState): Promise<string | null> {
  const { manifest, deps } = state;
  const model = state.settings.llm.model;
  deps.say(`Loading the model ${model}...`);
  let answer: Response;
  try {
    answer = await deps.fetch(`${state.ollama!.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: "", stream: false }),
      signal: AbortSignal.timeout(manifest.waits.warmUpMs),
    });
  } catch (error) {
    await stopOllama(state);
    return `Could not load the model ${model} within ${manifest.waits.warmUpMs / 1_000} s (${fetchErrorText(error)}). See ${logFile(state, "ollama")}.`;
  }
  if (answer.ok) return null;
  const body = (await answer.text().catch(() => "")).slice(0, 200);
  await stopOllama(state);
  return `Ollama could not load the model ${model} (HTTP ${answer.status}: ${body}). If it is missing, run \`mine-ai install model\`.`;
}

/** The Minecraft server in `<root>/server`, ready when it prints its `Done (` line. Returns the problem line, or null. */
export async function startLocalServer(state: StackState): Promise<string | null> {
  const { settings, manifest, deps, root } = state;
  if (settings.server.kind !== "local") return null;
  const java = javaPath(root);
  const dir = join(root, "server");
  if (!deps.fileExists(java)) return "Java is not installed. Run `mine-ai install java`.";
  if (!deps.fileExists(join(dir, "server.jar"))) return "The Minecraft server is not installed. Run `mine-ai install server --accept-eula`.";
  if (isStopRequested(state)) return STOPPED_WHILE_STARTING;
  let ready = false;
  const lastLines: string[] = [];
  const log = logFile(state, "server");
  deps.say("Starting the Minecraft server...");
  const child = state.children.spawn("server", java, [SERVER_START_HEAP, `-Xmx${settings.server.memoryMb}M`, "-jar", "server.jar", "nogui"], {
    env: {},
    cwd: dir,
    logFile: log,
    stdin: "pipe",
    onLine: (line) => {
      lastLines.push(line);
      if (lastLines.length > SERVER_LOG_LINES_IN_PROBLEM) lastLines.shift();
      if (SERVER_READY_LINE.test(line)) ready = true;
      state.onServerLine?.(line);
    },
  });
  state.server = child;
  const outcome = await waitUntilReady(state, () => ready, child.exited, manifest.waits.serverDoneMs);
  if (outcome === "ready") {
    state.serverTarget = { host: "127.0.0.1", port: settings.server.port };
    return null;
  }
  await stopLocalServer(state);
  if (outcome === "stopped") return STOPPED_WHILE_STARTING;
  const reason = outcome === "exited" ? "ended before it was ready" : `was not ready within ${manifest.waits.serverDoneMs / 1_000} s`;
  return `The Minecraft server ${reason}: ${lastLines.join(" | ") || "(no output)"}. See ${log}.`;
}

/** The world is saved by the server's own `stop` line; it is killed only when it does not end within the manifest's wait. */
export async function stopLocalServer(state: StackState): Promise<StopResult> {
  const server = state.server;
  state.server = null;
  return await state.children.stop("server", {
    timeoutMs: state.manifest.waits.serverStopMs,
    graceful: async () => void server?.stdin?.write("stop\n"),
  });
}

/** Unloads the model, ends our `ollama serve` and the `llama-server` runner a killed serve leaves behind. Never touches an Ollama we did not start. True when it stopped ours (false when it had already ended by itself). */
export async function stopOllama(state: StackState): Promise<boolean> {
  const ollama = state.ollama;
  if (ollama === null || !ollama.owned) return false;
  state.ollama = null;
  await unloadModel(state, ollama.baseUrl);
  const result = await state.children.stop("ollama", { timeoutMs: OLLAMA_STOP_TIMEOUT_MS });
  if (ollama.pid !== undefined) await killRunnersOf(state, ollama.pid);
  return result !== "not-running";
}

async function unloadModel(state: StackState, baseUrl: string): Promise<void> {
  try {
    await state.deps.fetch(`${baseUrl}/api/generate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: state.settings.llm.model, keep_alive: 0 }), signal: AbortSignal.timeout(VERSION_REQUEST_TIMEOUT_MS * 2) });
  } catch {
    // The serve is ended next either way; a model it still holds goes with it.
  }
}

async function killRunnersOf(state: StackState, ollamaPid: number): Promise<void> {
  try {
    for (const runner of runnersLeftBy(ollamaPid, await state.deps.listProcesses(), new Set([ollamaPid]))) state.deps.killProcess(runner.pid);
  } catch (error) {
    state.deps.say(`Could not check for a leftover llama-server: ${(error as Error).message}. End llama-server.exe in Task Manager if it is still running.`);
  }
}
