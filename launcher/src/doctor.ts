// `mine-ai doctor`: what a bug report needs, in one screen (versions, GPU answer, free disk space, ports, settings, last errors).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { findRunningLauncher, realLockDeps } from "./control.ts";
import { realDiskDeps } from "./install/disk.ts";
import { driveLines, orFallback, type NamedFolder } from "./install/disk-report.ts";
import { assessGpu, remoteVerdictText } from "./install/gpu.ts";
import type { StackStatus } from "./stack.ts";
import { javaPath } from "./install/java.ts";
import { modelStore } from "./install/model.ts";
import { ollamaExeFor, parseOllamaVersion, runCommand } from "./install/ollama.ts";
import { loadInstallState } from "./install/state.ts";
import type { Manifest } from "./manifest.ts";
import { appRoot } from "./paths.ts";
import { freePort } from "./ports.ts";
import { settingsFileExists, settingsPath, type Settings } from "./settings.ts";

const ERROR_LINES_SHOWN = 20;
/** Only the end of a log is read: an Ollama log can be hundreds of MB, and the newest lines are the ones that matter. */
const LOG_TAIL_BYTES = 256 * 1024;
const ERROR_LINE = /\b(error|exception|fatal|failed|fail)\b/iu;
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z/u;

export interface DoctorDeps {
  readonly bunVersion: string;
  readonly platform: string;
  /** The version `ollama --version` names; null when there is no ollama.exe. */
  ollamaVersion(): Promise<string | null>;
  javaInstalled(): boolean;
  /** The adapters and the model verdict, one line each. */
  gpuSummary(): Promise<string[]>;
  /** One line per drive Mine AI uses: its free space and what is on it (`C: 115.1 GB free (app folder, data folder)`). */
  diskLines(): Promise<string[]>;
  /** `mine-ai`: the running launcher or one of its programs holds it; `other`: some other program does. */
  portOwner(port: number): Promise<"free" | "mine-ai" | "other">;
}

const PORT_OWNER_TEXT = { free: "free", "mine-ai": "in use by Mine AI", other: "in use by another program (Mine AI picks the next free port)" } as const;

/** The ports the running launcher holds: its control port, its bots' hosts, our Ollama and the local server. */
async function portsHeldByLauncher(root: string, manifest: Manifest): Promise<ReadonlySet<number>> {
  const launcher = await findRunningLauncher(root, realLockDeps);
  if (launcher?.controlPort == null) return new Set();
  try {
    const status = (await (await fetch(`http://127.0.0.1:${launcher.controlPort}/status`, { signal: AbortSignal.timeout(2_000) })).json()) as StackStatus;
    const server = status.server === "local" && status.join ? [Number(status.join.split(":")[1])] : [];
    return new Set([launcher.controlPort, ...status.bots.map((bot) => bot.hostPort), ...(status.llm.kind === "local" ? [manifest.ollama.port] : []), ...server]);
  } catch {
    return new Set([launcher.controlPort]);
  }
}

/**
 * The folders whose drives the doctor measures: the app folder, the data folder, the Ollama folder (where `ollama.exe`
 * is, when one is found) and the model store; `lookups` replace the real ones in tests. A lookup that fails (a corrupt
 * install state) leaves its folder out: the doctor is what a bug report is made of, it must not crash on the file it reports.
 */
export function doctorFolders(root: string, manifest: Manifest, app: string, lookups: { findOllama?: (root: string) => string | null; storeOf?: (root: string, manifest: Manifest) => string } = {}): NamedFolder[] {
  const ollamaExe = orFallback(() => (lookups.findOllama ?? ollamaExeFor)(root), null);
  const store = orFallback(() => (lookups.storeOf ?? modelStore)(root, manifest), null);
  return [
    { what: "app folder", folder: app },
    { what: "data folder", folder: root },
    ...(ollamaExe === null ? [] : [{ what: "Ollama", folder: dirname(ollamaExe) }]),
    ...(store === null ? [] : [{ what: "Ollama models", folder: store }]),
  ];
}

export function realDoctorDeps(root: string, manifest: Manifest, app: string = appRoot()): DoctorDeps {
  let held: Promise<ReadonlySet<number>> | undefined;
  return {
    bunVersion: Bun.version,
    platform: `${process.platform} ${process.arch}`,
    ollamaVersion: async () => {
      const exe = ollamaExeFor(root);
      return exe === null ? null : (parseOllamaVersion((await runCommand(exe, ["--version"])).output) ?? "(version not readable)");
    },
    javaInstalled: () => existsSync(javaPath(root)),
    gpuSummary: async () => {
      const report = await assessGpu(null, manifest);
      const adapters = report.adapters.map((adapter, i) => `Adapter ${i + 1}: ${adapter.name}, ${(adapter.bytes / 1024 ** 3).toFixed(1)} GiB`);
      return [...adapters, report.choice.kind === "local" ? `Local model ${report.choice.model} can run here.` : remoteVerdictText(report.choice)];
    },
    diskLines: () => driveLines(doctorFolders(root, manifest, app), realDiskDeps),
    portOwner: async (port) => {
      held ??= portsHeldByLauncher(root, manifest);
      if ((await held).has(port)) return "mine-ai";
      return (await freePort(port)) === port ? "free" : "other";
    },
  };
}

function tailOfFile(path: string, bytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Reading from the middle of a file starts mid-line: drop that piece.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    closeSync(fd);
  }
}

/** The last error lines of every `*.log` in `<root>/logs`, oldest first by their timestamps, each tagged with its file. */
function lastErrorLines(root: string): string[] {
  const folder = join(root, "logs");
  if (!existsSync(folder)) return [];
  const found = readdirSync(folder)
    .filter((name) => name.endsWith(".log"))
    .flatMap((name) => tailOfFile(join(folder, name), LOG_TAIL_BYTES).split(/\r?\n/u).filter((line) => ERROR_LINE.test(line)).map((line) => ({ name, line, at: TIMESTAMP_PREFIX.exec(line)?.[0] ?? "" })));
  found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return found.slice(-ERROR_LINES_SHOWN).map(({ name, line }) => `  [${name}] ${line}`);
}

/** How the remote key is kept, from the settings as loaded; the key itself is never shown (spec D3). */
function describeKey(llm: Extract<Settings["llm"], { kind: "remote" }>): string {
  if (llm.keyUnreadable === true) return "key: saved for another Windows user or PC, cannot be read here";
  if (llm.apiKey === "") return "key: none";
  if (llm.clearKeyInFile === true) return "key: in clear (encrypted at the next start)";
  return llm.apiKeyProtected === undefined ? "key: in the file, readable by this user only" : "key: saved, encrypted";
}

/** The settings lines about the model: the endpoint and, for a remote one, how its key is kept. */
function describeLlm(settings: Settings): string[] {
  const { llm } = settings;
  return llm.kind === "remote" ? [`  model: remote ${llm.baseUrl}, model ${llm.model}`, `  ${describeKey(llm)}`] : [`  model: local, model ${llm.model}`];
}

function describeServer(settings: Settings): string {
  const { server } = settings;
  return server.kind === "none" ? "none" : server.kind === "local" ? `local on port ${server.port}, ${server.memoryMb} MB` : `remote ${server.host}:${server.port}`;
}

async function portLines(manifest: Manifest, settings: Settings, deps: DoctorDeps): Promise<string[]> {
  const ports: [string, number][] = [["control", settings.controlPort], ["first bot host", settings.hostBasePort], ["Ollama", manifest.ollama.port]];
  if (settings.server.kind === "local") ports.push(["Minecraft server", settings.server.port]);
  return await Promise.all(ports.map(async ([label, port]) => `  ${label}: ${port} ${PORT_OWNER_TEXT[await deps.portOwner(port)]}`));
}

/** The report as lines for the console. Reads, never changes anything. */
export async function runDoctor(root: string, manifest: Manifest, settings: Settings, deps: DoctorDeps): Promise<string[]> {
  const ollama = await deps.ollamaVersion();
  const installed = loadInstallState(root);
  const errors = lastErrorLines(root);
  return [
    `Mine AI ${manifest.version} on ${deps.platform}, Bun ${deps.bunVersion}`,
    ollama === null ? "Ollama: not installed (run `mine-ai install ollama`, or use a remote endpoint)" : `Ollama ${ollama}${installed.ollama ? ` (${installed.ollama === "installed" ? "installed by Mine AI" : "yours, left as it is"})` : ""}`,
    deps.javaInstalled() ? "Java: installed" : "Java: not installed (only needed for a local server: `mine-ai install java`)",
    "GPU:",
    ...(await deps.gpuSummary()).map((line) => `  ${line}`),
    "Disk:",
    ...(await deps.diskLines()).map((line) => `  ${line}`),
    "Ports:",
    ...(await portLines(manifest, settings, deps)),
    `Settings: ${settingsPath(root)}${settingsFileExists(root) ? "" : " (not found: the values below are the defaults)"}`,
    ...describeLlm(settings),
    `  server: ${describeServer(settings)}`,
    `  bots: ${settings.bots.join(", ") || "(none)"}`,
    `Logs: ${join(root, "logs")}`,
    ...(errors.length === 0 ? ["No errors in the logs."] : [`Last ${errors.length} error lines:`, ...errors]),
  ];
}
