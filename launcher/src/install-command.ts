// `mine-ai install <step> [--accept-eula] [--dir <folder>] [--no-model] [--json <file>]`: the installer's way into the
// install steps (spec D2, D3). `--dir` is for `install ollama` and `install disk`: the folder Ollama's setup installs
// into when Ollama is missing. `--no-model` is for `install disk` only: the GPU verdict is remote, so no model line.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
import { parseArgs } from "node:util";
import { UsageError, type CliContext } from "./cli-context.ts";
import { diskReport, realDiskReportDeps, type DiskReport, type DiskReportDeps } from "./install/disk-report.ts";
import { endpointTest } from "./install/endpoint.ts";
import { gpu, type GpuReport } from "./install/gpu.ts";
import { java } from "./install/java.ts";
import { model, modelOnDisk, modelRemove } from "./install/model.ts";
import { ollama, ollamaExeFor, ollamaRemove } from "./install/ollama.ts";
import { server } from "./install/server.ts";
import { stepFailure, type InstallContext, type StepResult } from "./install/step.ts";
import type { Manifest } from "./manifest.ts";
import { loadSettings } from "./settings.ts";

export const INSTALL_STEP_NAMES = ["gpu", "disk", "ollama", "ollama-remove", "model", "model-remove", "java", "server", "endpoint-test"] as const;
export type InstallStepName = (typeof INSTALL_STEP_NAMES)[number];

/** What a step returns: a plain `StepResult`, or one carrying the GPU report (`gpu`, and `ollama` after its stage 2) or the disk report (`disk`). */
type StepOutput = StepResult | DiskReport | { readonly ok: true; readonly detail: string; readonly report: GpuReport };
/** `dir`: the `--dir` folder, given to `ollama` and `disk` only; `noModel`: `--no-model`, `disk` only (any other step is refused them before it runs). */
export type InstallSteps = Record<InstallStepName, (ctx: InstallContext, acceptEula: boolean, dir?: string, noModel?: boolean) => Promise<StepOutput>>;

/** `install disk` with the dependencies `depsFor` gives (the real ones unless a test gives its own). */
export const diskStep =
  (depsFor: (ctx: InstallContext) => DiskReportDeps = realDiskReportDeps): InstallSteps["disk"] =>
  (ctx, _acceptEula, dir, noModel) =>
    diskReport(ctx, { dir, noModel: noModel === true }, depsFor(ctx));

export const realInstallSteps: InstallSteps = {
  gpu: (ctx) => gpu(ctx),
  disk: diskStep(),
  ollama: (ctx, _acceptEula, dir) => ollama(ctx, undefined, dir === undefined ? {} : { dir }),
  "ollama-remove": (ctx) => ollamaRemove(ctx),
  model: (ctx) => model(ctx),
  "model-remove": (ctx) => modelRemove(ctx),
  java: (ctx) => java(ctx),
  server: (ctx, acceptEula) => server(ctx, acceptEula),
  "endpoint-test": (ctx) => endpointTest(ctx),
};

/**
 * What the installer reads from `--json`. A step that says this PC cannot run the local model ends `ok:false` with the
 * reason as `error` and `remote:true`, which the installer takes as "show the remote endpoint page" (`mine-ai.iss`
 * `AcceptLocalModel`, `CheckGpuOnce`); the report stays in the file for the doctor and bug reports.
 */
function installerResult(output: StepOutput): Record<string, unknown> {
  if ("report" in output && output.report.choice.kind === "remote") return { ok: false, error: output.report.choice.reason, hint: output.report.choice.hint, remote: true, report: output.report };
  return { ...output };
}

/** Prints `PROGRESS <fraction> <label>` when the thousandth or the label changed, so the installer's callback is not flooded by a download. */
function progressPrinter(out: (line: string) => void): InstallContext["onProgress"] {
  let lastPermille = -1;
  let lastLabel = "";
  return (fraction, label) => {
    const permille = Math.round(Math.min(Math.max(fraction, 0), 1) * 1000);
    const oneLine = label.replace(/\s+/gu, " ").trim();
    if (permille === lastPermille && oneLine === lastLabel) return;
    [lastPermille, lastLabel] = [permille, oneLine];
    out(`PROGRESS ${(permille / 1000).toFixed(3)} ${oneLine}`);
  };
}

interface InstallArguments {
  step: InstallStepName;
  acceptEula: boolean;
  dir: string | undefined;
  noModel: boolean;
  json: string | undefined;
}

function parseInstallArguments(args: readonly string[]): InstallArguments {
  const { values, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: { "accept-eula": { type: "boolean" }, dir: { type: "string" }, "no-model": { type: "boolean" }, json: { type: "string" } } });
  const step = positionals[0];
  if (!INSTALL_STEP_NAMES.includes(step as InstallStepName)) throw new UsageError(`install needs one step: ${INSTALL_STEP_NAMES.join(", ")}.`);
  if (values.dir !== undefined && step !== "ollama" && step !== "disk") throw new UsageError(`--dir is for \`install ollama --dir <folder>\` and \`install disk --dir <folder>\` only; \`install ${step}\` does not take it.`);
  if (values["no-model"] === true && step !== "disk") throw new UsageError(`--no-model is for \`install disk --no-model\` only; \`install ${step}\` does not take it.`);
  return { step: step as InstallStepName, acceptEula: values["accept-eula"] === true, dir: values.dir === undefined ? undefined : checkedFolder(values.dir), noModel: values["no-model"] === true, json: values.json };
}

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const ROOT_FOLDER = /^(?:[A-Za-z]:)?[\\/]*$/u;

/**
 * The `--dir` folder as Ollama's setup gets it. Absolute only: an empty or relative folder would make the setup install
 * into its own working folder, and `\Apps` names a folder of the current drive. A trailing separator goes (Inno's
 * argument parser does not undo the escape of `\"`), except on a drive root.
 */
function checkedFolder(dir: string): string {
  if (!WINDOWS_ABSOLUTE.test(dir) && !(process.platform !== "win32" && posix.isAbsolute(dir))) throw new UsageError(`--dir needs an absolute folder, such as D:\\Apps\\Ollama (got "${dir}").`);
  return ROOT_FOLDER.test(dir) ? dir : dir.replace(/[\\/]+$/u, "");
}

async function runStep({ step, acceptEula, dir, noModel }: InstallArguments, context: CliContext, steps: InstallSteps): Promise<StepOutput> {
  try {
    const manifest = context.loadManifest();
    const settings = loadSettings(context.root, manifest);
    return await steps[step]({ manifest, settings, root: context.root, onProgress: progressPrinter(context.out) }, acceptEula, dir, noModel);
  } catch (error) {
    return stepFailure(error, "Run the installer again to resume: the steps that are done are not repeated. If it repeats, `mine-ai doctor` lists the last errors.");
  }
}

/** The GPU step needs no install state: a state file that cannot be read must not stop its answer reaching the installer. */
function ollamaExeOrNull(findOllama: (root: string) => string | null, root: string): string | null {
  try {
    return findOllama(root);
  } catch {
    return null;
  }
}

/** Same reason: the model page's hint must never turn a GPU verdict into a failure. The tag comes from the manifest, so it needs no model folder. */
function modelHint(context: CliContext, modelPresent: (root: string, manifest: Manifest) => boolean): { model: string | null; modelInstalled: boolean } {
  try {
    const manifest = context.loadManifest();
    try {
      return { model: manifest.ollama.model, modelInstalled: modelPresent(context.root, manifest) };
    } catch {
      return { model: manifest.ollama.model, modelInstalled: false };
    }
  } catch {
    return { model: null, modelInstalled: false };
  }
}

/**
 * Runs one step; exit code 0 when it succeeded, 1 when not. The `--json` file is written on every path. `install gpu`
 * also writes `ollamaExe` (the `ollama.exe` of this data root, or null): the installer shows it as the Ollama folder;
 * and `model` with `modelInstalled` (the model's files are already on disk): the model page says so before the pull.
 */
export async function runInstallCommand(
  args: readonly string[],
  context: CliContext,
  steps: InstallSteps = realInstallSteps,
  findOllama: (root: string) => string | null = ollamaExeFor,
  modelPresent: (root: string, manifest: Manifest) => boolean = (root, manifest) => modelOnDisk(root, manifest),
): Promise<number> {
  const parsed = parseInstallArguments(args);
  const output = installerResult(await runStep(parsed, context, steps));
  const result = parsed.step === "gpu" ? { ...output, ollamaExe: ollamaExeOrNull(findOllama, context.root), ...modelHint(context, modelPresent) } : output;
  const { json } = parsed;
  if (json !== undefined) {
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify(result));
  } else context.out(result.ok === true ? String(result.detail) : `${String(result.error)} ${String(result.hint)}`.trim());
  return result.ok === true ? 0 : 1;
}
