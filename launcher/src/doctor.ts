// `mine-ai doctor`: what a bug report needs, in one screen (versions, GPU answer, ports, settings, last errors).
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { findRunningLauncher, realLockDeps } from "./control.ts";
import { assessGpu, remoteVerdictText } from "./install/gpu.ts";
import type { StackStatus } from "./stack.ts";
import { javaPath } from "./install/java.ts";
import { ollamaExeFor, parseOllamaVersion, runCommand } from "./install/ollama.ts";
import { loadInstallState } from "./install/state.ts";
import type { Manifest } from "./manifest.ts";
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

export function realDoctorDeps(root: string, manifest: Manifest): DoctorDeps {
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
      const adapters = report.adapters.map((adapter, i) => `Adapter ${i + 1}: ${(adapter.bytes / 1024 ** 3).toFixed(1)} GiB`);
      return [...adapters, report.choice.kind === "local" ? `Local model ${report.choice.model} can run here.` : remoteVerdictText(report.choice)];
    },
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

function describeLlm(settings: Settings): string {
  return settings.llm.kind === "remote" ? `remote ${settings.llm.baseUrl}, model ${settings.llm.model} (key not shown)` : `local, model ${settings.llm.model}`;
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
    "Ports:",
    ...(await portLines(manifest, settings, deps)),
    `Settings: ${settingsPath(root)}${settingsFileExists(root) ? "" : " (not found: the values below are the defaults)"}`,
    `  model: ${describeLlm(settings)}`,
    `  server: ${describeServer(settings)}`,
    `  bots: ${settings.bots.join(", ") || "(none)"}`,
    `Logs: ${join(root, "logs")}`,
    ...(errors.length === 0 ? ["No errors in the logs."] : [`Last ${errors.length} error lines:`, ...errors]),
  ];
}
