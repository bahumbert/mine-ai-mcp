// The Ollama install steps: use a preexisting Ollama or install ours, ask it what GPU it can run on, remove only ours.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { monotonicNow } from "../clocks.ts";
import { downloadFailureHint, downloadVerified } from "./download.ts";
import { assessGpu, parseOllamaCompute, remoteVerdictText, type ComputeDevice, type GpuFacts, type GpuStepResult } from "./gpu.ts";
import { listModelNames, logTail, realServeDeps, ServeUnavailableError, withLatestTag, withOurOllamaServe, type OurServe, type ServeDeps } from "./ollama-serve.ts";
import { loadInstallState, saveInstallState, type InstallState } from "./state.ts";
import { failure, type InstallContext, type StepFailure, type StepResult } from "./step.ts";

const SETUP_FLAGS = ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"];
const SETUP_FILE = "OllamaSetup.exe";
const OLLAMA_FILE = "ollama.exe";
const UNINSTALLER_FILE = "unins000.exe";
const COMPUTE_POLL_MS = 250;
const COMPUTE_SETTLE_MS = 500;
const DOWNLOAD_SHARE = 0.8;

export interface OllamaDeps extends ServeDeps {
  ollamaExe(): string | null;
  run(exe: string, args: string[]): Promise<{ code: number | null; output: string }>;
  downloadVerified: typeof downloadVerified;
  fileExists(path: string): boolean;
  /** The folder of Ollama's default model store when it holds a model, else null (the player's own models). */
  defaultStoreWithModels(): string | null;
  removeFile(path: string): void;
  gpuFacts?: GpuFacts;
}

/** `ollama` ends ok with the stage 2 report (it may say remote), or with the step failure. */
export type OllamaStepResult = GpuStepResult | StepFailure;

/**
 * Where ollama.exe is: the path our install recorded (a folder the player chose) when it is still there, then the
 * per-user install folder of Ollama's own setup, then the PATH. A player's Ollama is found the same way as ours, which
 * is why `install-state.json` records who installed it.
 */
export function ollamaExe(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync, recorded?: string): string | null {
  const path = platform === "win32" ? win32 : posix;
  const file = platform === "win32" ? OLLAMA_FILE : "ollama";
  const candidates = [
    ...(recorded ? [recorded] : []),
    ...(platform === "win32" && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "Programs", "Ollama", file)] : []),
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean).map((folder) => path.join(folder, file)),
  ];
  return candidates.find(exists) ?? null;
}

/** `ollamaExe` for the Ollama this data root's install recorded; the one lookup every real dependency uses. */
export function ollamaExeFor(root: string): string | null {
  return ollamaExe(process.env, process.platform, existsSync, loadInstallState(root).ollamaPath);
}

/** The player's default model store (`<home>\.ollama\models`) when a manifest file is in it, else null. */
export function defaultStoreWithModels(home: string = homedir()): string | null {
  const store = join(home, ".ollama", "models");
  try {
    return readdirSync(join(store, "manifests"), { recursive: true, withFileTypes: true }).some((entry) => entry.isFile()) ? store : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `ollama --version` also names the running server when its version differs; the exe's own (client) version counts. */
export function parseOllamaVersion(output: string): string | null {
  return /client version is (\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? /version is (\d+\.\d+\.\d+)/u.exec(output)?.[1] ?? null;
}

function isOlder(version: string, minimum: string): boolean {
  const [a, b] = [version, minimum].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * `install ollama`: ensure an Ollama of at least `minVersion`, then stage 2 of the model choice. `dir` is the folder
 * the player chose for an Ollama the setup has to install; an Ollama already there is never moved.
 */
export async function ollama(ctx: InstallContext, deps: OllamaDeps = realOllamaDeps(ctx.root), options: { dir?: string } = {}): Promise<OllamaStepResult> {
  const found = await ensureOllama(ctx, deps, options.dir);
  if (!found.ok) return found;
  const result = await discoverCompute(ctx, found.exe, deps);
  if (!result.ok || options.dir === undefined || !found.existed || sameFolder(dirname(found.exe), options.dir)) return result;
  return { ...result, detail: `${result.detail} Ollama found at ${found.exe}; the folder you chose was not used.` };
}

/** Windows folders compare without case and without a trailing separator. */
const sameFolder = (a: string, b: string): boolean => withoutTrailingSeparators(a).toLowerCase() === withoutTrailingSeparators(b).toLowerCase();
const withoutTrailingSeparators = (folder: string): string => folder.replace(/[\\/]+$/u, "");

/** Ours: recorded as installed by us, and at the recorded path (an install from before W7 records none: Ollama's default folder). */
function isOurOllama(state: InstallState, exe: string): boolean {
  return state.ollama === "installed" && (state.ollamaPath === undefined || state.ollamaPath === exe);
}

type EnsuredOllama = { ok: true; exe: string; existed: boolean } | StepFailure;

async function ensureOllama(ctx: InstallContext, deps: OllamaDeps, dir: string | undefined): Promise<EnsuredOllama> {
  const existing = deps.ollamaExe();
  if (existing === null) return await installOurOllama(ctx, deps, dir);
  const output = (await deps.run(existing, ["--version"])).output;
  const version = parseOllamaVersion(output);
  const state = loadInstallState(ctx.root);
  const ours = isOurOllama(state, existing);
  if (version === null) return failure(`Could not read the version of ${existing} (it printed: ${logTail(output)}).`, "Update or repair that Ollama (https://ollama.com/download), then try again. Mine AI never reinstalls over an Ollama it did not install.");
  if (isOlder(version, ctx.manifest.ollama.minVersion)) {
    // our own install is ours to update; a player's is not (spec: no silent reinstall over theirs)
    if (ours) return await upgradeOurOllama(ctx, deps);
    return failure(`Ollama ${version} at ${existing} is older than the ${ctx.manifest.ollama.minVersion} Mine AI needs.`, "Update Ollama from https://ollama.com/download, then try again. Mine AI never reinstalls over an Ollama it did not install.");
  }
  // the player's Ollama keeps the player's model store: a path or store of an earlier install of ours is dropped
  if (!ours) {
    const { ollamaPath: _path, ollamaModels: _store, ...kept } = state;
    saveInstallState(ctx.root, { ...kept, ollama: "preexisting" });
  }
  return { ok: true, exe: existing, existed: true };
}

/** Our own install is updated where it stands: the folder recorded when the player chose one, else Ollama's default. */
async function upgradeOurOllama(ctx: InstallContext, deps: OllamaDeps): Promise<EnsuredOllama> {
  const recorded = loadInstallState(ctx.root).ollamaPath;
  const installed = await installOurOllama(ctx, deps, recorded === undefined ? undefined : dirname(recorded));
  return installed.ok ? { ...installed, existed: true } : installed;
}

async function installOurOllama(ctx: InstallContext, deps: OllamaDeps, dir: string | undefined): Promise<EnsuredOllama> {
  const { url, sha256 } = ctx.manifest.ollama;
  const setup = join(ctx.root, "runtime", SETUP_FILE);
  mkdirSync(dirname(setup), { recursive: true });
  try {
    await deps.downloadVerified(url, setup, { sha256 }, (fraction) => ctx.onProgress(fraction * DOWNLOAD_SHARE, "Downloading Ollama"));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), downloadFailureHint(error));
  }
  // recorded before the setup runs: a setup cut half way leaves files that would look like a player's Ollama. The
  // model store is chosen once, at the first install of ours: an Ollama of ours from before it keeps its default store.
  const state = loadInstallState(ctx.root);
  const firstInstall = state.ollama !== "installed";
  saveInstallState(ctx.root, { ...state, ollama: "installed", ...(firstInstall ? { ollamaModels: state.ollamaModels ?? join(ctx.root, "models") } : {}) });
  ctx.onProgress(DOWNLOAD_SHARE, "Installing Ollama");
  const result = await deps.run(setup, dir === undefined ? SETUP_FLAGS : [...SETUP_FLAGS, `/DIR=${dir}`]);
  if (result.code !== 0) return failure(`The Ollama setup ended with code ${result.code}: ${logTail(result.output)}`, "Close other installers and try again.");
  deps.removeFile(setup);
  const exe = dir === undefined ? deps.ollamaExe() : onlyIfThere(join(dir, OLLAMA_FILE), deps);
  if (exe === null) {
    const where = dir === undefined ? "" : ` in ${dir}`;
    return failure(`The Ollama setup finished but ollama.exe was not found${where}.`, "Try again; if it repeats, install Ollama from https://ollama.com/download and run the installer again.");
  }
  saveInstallState(ctx.root, { ...loadInstallState(ctx.root), ollamaPath: exe });
  return { ok: true, exe, existed: false };
}

const onlyIfThere = (exe: string, deps: OllamaDeps): string | null => (deps.fileExists(exe) ? exe : null);

/** Stage 2: our serve reports the GPUs it can run on, which DXGI alone cannot tell (ROCm card, dropped iGPU). */
async function discoverCompute(ctx: InstallContext, exe: string, deps: OllamaDeps): Promise<OllamaStepResult> {
  ctx.onProgress(0.9, "Asking Ollama which GPU it can use");
  try {
    const compute = await withOurOllamaServe(exe, ctx.manifest, ctx.root, (serve) => readComputeDevices(serve, ctx.manifest.waits.ollamaUpMs, deps), deps);
    if (compute === null) return portBusy(ctx.manifest.ollama.port);
    const report = await assessGpu(compute, ctx.manifest, deps.gpuFacts);
    const detail = report.choice.kind === "local" ? `Ollama can run ${report.choice.model} on this PC.` : remoteVerdictText(report.choice);
    return { ok: true, detail, report };
  } catch (error) {
    if (!(error instanceof ServeUnavailableError)) throw error;
    return failure(error.message, "Close other programs using the GPU and try again; the error says what Ollama logged.");
  }
}

function portBusy(port: number): StepFailure {
  return failure(
    `Something already answers on port ${port}, so Mine AI cannot read the GPU report of its own Ollama.`,
    "Close Mine AI if it is running. If an earlier install was interrupted, end ollama.exe in Task Manager. Then try again.",
  );
}

/** The devices in our serve's log once they stop arriving; `null` when the serve was not ours (no log to read). */
async function readComputeDevices(serve: OurServe, timeoutMs: number, deps: ServeDeps): Promise<ComputeDevice[] | null> {
  if (serve.reused) return null;
  const deadline = monotonicNow() + timeoutMs;
  while (monotonicNow() < deadline) {
    if (parseOllamaCompute(serve.output()).length > 0) {
      await deps.sleep(COMPUTE_SETTLE_MS);
      return parseOllamaCompute(serve.output());
    }
    await deps.sleep(COMPUTE_POLL_MS);
  }
  // not "no GPU": the first discovery after an install can be slow (new GPU libraries scanned), so a retry decides
  throw new ServeUnavailableError(`Ollama did not report its GPUs within ${timeoutMs} ms: ${logTail(serve.output())}`);
}

/** `install ollama-remove`: runs Ollama's own uninstaller, only for an Ollama this installer put there. */
export async function ollamaRemove(ctx: InstallContext, deps: OllamaDeps = realOllamaDeps(ctx.root)): Promise<StepResult> {
  const state = loadInstallState(ctx.root);
  if (state.ollama !== "installed") return { ok: true, detail: "Ollama was not installed by Mine AI; kept." };
  const exe = deps.ollamaExe();
  if (exe === null) return forgetOllama(ctx, "Ollama was already removed.");
  if (!isOurOllama(state, exe)) return forgetOllama(ctx, `The Ollama Mine AI installed is gone; the Ollama at ${exe} is not Mine AI's and was kept.`);
  const uninstaller = join(dirname(exe), UNINSTALLER_FILE);
  if (!deps.fileExists(uninstaller)) {
    return failure(`There is no uninstaller next to ${exe}.`, "Remove Ollama in Windows Settings > Apps, then run this step again to clear Mine AI's record of it.");
  }
  const kept = await reasonToKeepOllama(ctx, exe, state.modelPulledByUs === true, deps);
  if (kept !== null) return { ok: true, detail: `Ollama kept: ${kept} Remove it in Windows Settings > Apps if you want it gone.` };
  const result = await deps.run(uninstaller, SETUP_FLAGS);
  if (result.code !== 0) return failure(`The Ollama uninstaller ended with code ${result.code}: ${logTail(result.output)}`, "Close Ollama (system tray) and run the uninstall again.");
  return forgetOllama(ctx, "Ollama removed.");
}

function forgetOllama(ctx: InstallContext, detail: string): StepResult {
  // the model store stays recorded: the model may still be there until the player's data goes
  const { ollama: _removed, ollamaPath: _gone, ...rest } = loadInstallState(ctx.root);
  saveInstallState(ctx.root, rest);
  return { ok: true, detail };
}

/**
 * Ollama's own uninstaller can delete the models folder (its log offers "Remove models"; the silent default is
 * unmeasured, W5), so it runs only when the store holds nothing but the model we pulled. Null: nothing stands in the way.
 * With a store of our own, our serve lists only that one, so the default store is looked at too.
 */
async function reasonToKeepOllama(ctx: InstallContext, exe: string, modelPulledByUs: boolean, deps: OllamaDeps): Promise<string | null> {
  try {
    const names = await withOurOllamaServe(exe, ctx.manifest, ctx.root, (serve) => listModelNames(serve, deps), deps);
    const ours = modelPulledByUs ? withLatestTag(ctx.manifest.ollama.model) : null;
    const others = names.filter((name) => name !== ours);
    if (others.length > 0) return `it still holds models Mine AI did not pull (${others.join(", ")}) and its uninstaller may delete them.`;
    const defaultStore = loadInstallState(ctx.root).ollamaModels === undefined ? null : deps.defaultStoreWithModels();
    return defaultStore === null ? null : `it holds models in ${defaultStore} that Mine AI did not pull and its uninstaller may delete them.`;
  } catch (error) {
    if (!(error instanceof ServeUnavailableError)) throw error;
    return `its models could not be checked (${error.message}) and its uninstaller may delete them.`;
  }
}

/** Runs a program without a console window; a program that cannot start gives a null code and the reason as output. */
export function runCommand(exe: string, args: string[]): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
      resolve({ code, output: `${stdout}${stderr}${code === null && error ? error.message : ""}` });
    });
  });
}

export function realOllamaDeps(root: string): OllamaDeps {
  return {
    ...realServeDeps,
    ollamaExe: () => ollamaExeFor(root),
    run: runCommand,
    downloadVerified,
    fileExists: existsSync,
    defaultStoreWithModels: () => defaultStoreWithModels(),
    removeFile: (path) => rmSync(path, { force: true }),
  };
}
