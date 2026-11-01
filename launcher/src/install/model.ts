// The model install steps: pull the manifest's model through our own Ollama serve, delete it later only if we pulled it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchErrorText } from "../fetch-error.ts";
import type { Manifest } from "../manifest.ts";
import { idleWatch, type IdleWatch } from "./idle-watch.ts";
import { ServeUnavailableError, listModelNames, ollamaServeEnv, realServeDeps, withLatestTag, withOurOllamaServe, type OurServe, type ServeDeps } from "./ollama-serve.ts";
import { ollamaExeFor } from "./ollama.ts";
import { loadInstallState, saveInstallState } from "./state.ts";
import { failure, type InstallContext, type StepFailure, type StepResult } from "./step.ts";

const RESUME_HINT = "Try again: a pull resumes where it stopped. If the same error comes back, it says what to fix.";
const NO_OLLAMA_HINT = "Install Ollama first (the Ollama step of the installer), then try again.";

export interface ModelDeps extends ServeDeps {
  ollamaExe(): string | null;
}

/**
 * Whether the manifest's model has its manifest file in the models folder our serve would use: `OLLAMA_MODELS` of
 * `ollamaServeEnv` when set, else the process's, else `<home>/.ollama/models`. A hint for the installer's model page
 * (no serve started); the `model` step still asks the serve. The file is `manifests/<host>/<namespace>/<name>/<tag>`:
 * a bare name lives under `registry.ollama.ai/library`, `<namespace>/<name>` under `registry.ollama.ai`, a name that
 * starts with a host as given; a missing tag is `latest` (H0 listed `manifests/registry.ollama.ai/library/gemma4/12b`,
 * `D:/mine-ai-w5/recheck/h0.txt`).
 */
export function modelOnDisk(root: string, manifest: Manifest, env: Record<string, string | undefined> = process.env, home: string = homedir()): boolean {
  const store = ollamaServeEnv(manifest, manifest.ollama.port, loadInstallState(root)).OLLAMA_MODELS ?? env.OLLAMA_MODELS ?? join(home, ".ollama", "models");
  return existsSync(join(store, "manifests", ...manifestFileParts(manifest.ollama.model)));
}

function manifestFileParts(model: string): string[] {
  const separator = model.lastIndexOf(":");
  const slash = model.lastIndexOf("/");
  const [name, tag] = separator > slash ? [model.slice(0, separator), model.slice(separator + 1)] : [model, "latest"];
  const parts = name.split("/");
  return [...(parts.length === 1 ? ["registry.ollama.ai", "library"] : parts.length === 2 ? ["registry.ollama.ai"] : []), ...parts, tag];
}

/** `install model`: pulls `manifest.ollama.model` unless our serve already lists it. */
export async function model(ctx: InstallContext, deps: ModelDeps = realModelDeps(ctx.root)): Promise<StepResult> {
  const exe = deps.ollamaExe();
  if (exe === null) return failure("Ollama is not installed, so the model cannot be pulled.", NO_OLLAMA_HINT);
  try {
    return await withOurOllamaServe(exe, ctx.manifest, ctx.root, (serve) => ensureModel(ctx, serve, deps), deps);
  } catch (error) {
    if (!(error instanceof ServeUnavailableError)) throw error;
    return failure(error.message, "Close other programs using the GPU or port, then run the step again.");
  }
}

async function ensureModel(ctx: InstallContext, serve: OurServe, deps: ModelDeps): Promise<StepResult> {
  const tag = ctx.manifest.ollama.model;
  if ((await listModelNames(serve, deps)).includes(withLatestTag(tag))) {
    const state = loadInstallState(ctx.root);
    saveInstallState(ctx.root, { ...state, modelPulledByUs: state.modelPulledByUs ?? false });
    return { ok: true, detail: `Model ${tag} is already installed.` };
  }
  // recorded before the pull: a pull cut half way leaves layers that a later uninstall must still clean up
  saveInstallState(ctx.root, { ...loadInstallState(ctx.root), modelPulledByUs: true });
  return await pullModel(ctx, serve, tag, deps);
}

/**
 * Bun's own option (not in the DOM `RequestInit`): by default a stream with no byte for 360 s ends with `TimeoutError`
 * (measured 2026-10-31, Bun 1.4.2, `.agent/scripts/installer/launcher-probes/sse-idle.ts`). The pull turns it off and bounds its
 * own silence with `waits.modelPullIdleMs`, so a stalled pull ends with a message that says what happened.
 */
const NO_IDLE_TIMEOUT: BunFetchRequestInit = { timeout: false };

type Layers = Map<string, { total: number; completed: number }>;
type PullProgress = { layers: Layers; succeeded: boolean; lastLine: string };

async function pullModel(ctx: InstallContext, serve: OurServe, tag: string, deps: ModelDeps): Promise<StepResult> {
  const idleMs = ctx.manifest.waits.modelPullIdleMs;
  const progress: PullProgress = { layers: new Map(), succeeded: false, lastLine: "" };
  const idle = idleWatch(idleMs);
  const idleFailure = () => failure(`Ollama sent nothing for ${Number((idleMs / 60_000).toFixed(1))} min while downloading ${tag} (${Math.round(pullFraction(progress.layers, false) * 100)} % done).`, RESUME_HINT);
  const pulled: StepResult = { ok: true, detail: `Model ${tag} pulled.` };
  idle.arm();
  try {
    const response = await deps.fetch(`${serve.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: tag, stream: true }),
      signal: idle.signal,
      ...NO_IDLE_TIMEOUT,
    });
    if (!response.ok || response.body === null) {
      return failure(`Ollama answered ${response.status} to the pull of ${tag}: ${(await response.text()).slice(0, 300)}`, RESUME_HINT);
    }
    const failed = await readPull(ctx, response.body, tag, progress, idle);
    if (failed) return failed;
    if (progress.succeeded) return pulled;
    if (idle.fired()) return idleFailure();
    return failure(`The pull of ${tag} ended before Ollama said it was done (connection cut?).`, RESUME_HINT);
  } catch (error) {
    // Ollama said `success`: a socket that breaks after it changes nothing. An aborted read throws the abort's own
    // message: the silence is the cause worth naming.
    if (progress.succeeded) return pulled;
    return idle.fired() ? idleFailure() : failure(`The pull of ${tag} stopped: ${fetchErrorText(error)}`, RESUME_HINT);
  } finally {
    idle.stop();
  }
}

/** Reads the pull's lines into `progress`; a failure when Ollama reports an error line, else null. */
async function readPull(ctx: InstallContext, body: ReadableStream<Uint8Array>, tag: string, progress: PullProgress, idle: IdleWatch): Promise<StepFailure | null> {
  for await (const line of ndjsonLines(body, idle.signal)) {
    const message = parsePullLine(line);
    if (message.error) return failure(`Ollama could not pull ${tag}: ${message.error}`, RESUME_HINT);
    // Ollama is silent while it reads the layers to verify them (8 GB on a slow disk passes the bound): no bound until its next line;
    // after `success` there is nothing left to wait for; a line that repeats the bytes of the last one is no progress
    const progressed = `${message.status}|${message.digest}|${message.completed}`;
    if (message.status === "success" || message.status?.startsWith("verifying")) idle.pause();
    else if (progressed !== progress.lastLine) idle.arm();
    progress.lastLine = progressed;
    if (message.status === "success") progress.succeeded = true;
    if (message.digest && message.total) progress.layers.set(message.digest, { total: message.total, completed: message.completed ?? 0 });
    ctx.onProgress(pullFraction(progress.layers, progress.succeeded), message.status ?? `Downloading ${tag}`);
  }
  return null;
}

type PullMessage = { status?: string; digest?: string; total?: number; completed?: number; error?: string };

function parsePullLine(line: string): PullMessage {
  try {
    return JSON.parse(line) as PullMessage;
  } catch {
    return {};
  }
}

/** Completed over total bytes of the layers seen so far; layers appear one after the other, so it can step back a little. */
function pullFraction(layers: Layers, succeeded: boolean): number {
  if (succeeded) return 1;
  let total = 0;
  let completed = 0;
  for (const layer of layers.values()) {
    total += layer.total;
    completed += Math.min(layer.completed, layer.total);
  }
  return total === 0 ? 0 : completed / total;
}

/** The body's lines; when `signal` aborts the body is cancelled, so a pending read ends (a body that ignores the abort too). */
async function* ndjsonLines(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") yield line;
    }
    if (pending.trim() !== "") yield pending;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/** `install model-remove`: deletes the model only when this installer pulled it. */
export async function modelRemove(ctx: InstallContext, deps: ModelDeps = realModelDeps(ctx.root)): Promise<StepResult> {
  const tag = ctx.manifest.ollama.model;
  const state = loadInstallState(ctx.root);
  if (!state.modelPulledByUs) return { ok: true, detail: `Model ${tag} was not pulled by Mine AI; kept.` };
  const exe = deps.ollamaExe();
  if (exe === null) return forgetModel(ctx, "Ollama is no longer installed; nothing to delete.");
  try {
    return await withOurOllamaServe(exe, ctx.manifest, ctx.root, (serve) => deleteModel(ctx, serve, tag, deps), deps);
  } catch (error) {
    if (!(error instanceof ServeUnavailableError)) throw error;
    return failure(error.message, "Close other programs using the GPU or port, then run the removal again.");
  }
}

async function deleteModel(ctx: InstallContext, serve: OurServe, tag: string, deps: ModelDeps): Promise<StepResult> {
  const response = await deps.fetch(`${serve.baseUrl}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: tag }),
  });
  if (response.status === 404) return forgetModel(ctx, `Model ${tag} was already removed.`);
  if (!response.ok) return failure(`Ollama answered ${response.status} to the removal of ${tag}.`, "Run the removal again.");
  return forgetModel(ctx, `Model ${tag} removed.`);
}

function forgetModel(ctx: InstallContext, detail: string): StepResult {
  saveInstallState(ctx.root, { ...loadInstallState(ctx.root), modelPulledByUs: false });
  return { ok: true, detail };
}

function realModelDeps(root: string): ModelDeps {
  return { ...realServeDeps, ollamaExe: () => ollamaExeFor(root) };
}
