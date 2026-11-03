// Decides local model or remote endpoint from the display adapters (registry), what Ollama reports it can use, and RAM.
import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { promisify } from "node:util";
import type { Manifest } from "../manifest.ts";
import type { InstallContext } from "./step.ts";

const GIB = 1024 ** 3;
const DISPLAY_ADAPTER_CLASS_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
const MEMORY_VALUE = "HardwareInformation.qwMemorySize";
const SIZE_UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: GIB, TiB: 1024 ** 4 };
const KNOWN_LIBRARIES = ["cuda", "rocm", "vulkan", "metal", "cpu"] as const;

export type DisplayAdapter = { bytes: number };
export type ComputeLibrary = (typeof KNOWN_LIBRARIES)[number];
export type ComputeDevice = { library: ComputeLibrary; name: string; totalBytes: number; freeBytes: number };
/** A remote verdict: `reason` is the facts, `hint` the next action (the installer shows both, so neither repeats the other). */
export type ModelChoice = { kind: "local"; model: string } | { kind: "remote"; reason: string; hint: string };
const REMOTE_ENDPOINT = "a remote endpoint: any OpenAI-compatible service (a URL, an API key and a model name)";
type ModelRequirements = { ollama: Pick<Manifest["ollama"], "model" | "minVramGiB" | "minRamGiB"> };

/** What the installer shows and the next steps read: the facts behind the choice. `compute` is null before Ollama ran. */
export type GpuReport = { adapters: DisplayAdapter[]; compute: ComputeDevice[] | null; ramBytes: number; choice: ModelChoice };
export type GpuStepResult = { ok: true; detail: string; report: GpuReport };

export type GpuFacts = {
  readRegistry(): Promise<string>;
  totalRamBytes(): number;
};

/** The dedicated memory of each display adapter in `reg query ... /v HardwareInformation.qwMemorySize` output. */
export function parseRegistryVram(text: string): DisplayAdapter[] {
  const adapters: DisplayAdapter[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes(MEMORY_VALUE)) continue;
    const bytes = registryValueBytes(line);
    if (bytes !== null) adapters.push({ bytes });
  }
  return adapters;
}

/** REG_QWORD and REG_DWORD print `0x<hex>`; some drivers write REG_BINARY, 8 hex-pair bytes least significant first. */
function registryValueBytes(line: string): number | null {
  const number = /REG_(?:QWORD|DWORD)\s+0x([0-9a-f]+)/iu.exec(line);
  if (number) return Number(BigInt(`0x${number[1]}`));
  const binary = /REG_BINARY\s+([0-9a-f]+)\s*$/iu.exec(line);
  if (!binary || binary[1].length % 2 !== 0) return null;
  const pairs = binary[1].match(/../gu) ?? [];
  return Number(BigInt(`0x${pairs.reverse().join("")}`));
}

/** The devices Ollama says it will run on: one `msg="inference compute"` line each. Dropped-device lines are ignored. */
export function parseOllamaCompute(text: string): ComputeDevice[] {
  const devices: ComputeDevice[] = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line.includes('msg="inference compute"')) continue;
    const fields = logFields(line);
    const library = fields.library?.toLowerCase();
    const total = sizeBytes(fields.total);
    if (!isKnownLibrary(library) || total === null) continue;
    devices.push({
      library,
      name: fields.description ?? fields.name ?? library,
      totalBytes: total,
      freeBytes: sizeBytes(fields.available) ?? 0,
    });
  }
  return devices;
}

function isKnownLibrary(library: string | undefined): library is ComputeLibrary {
  return KNOWN_LIBRARIES.some((known) => known === library);
}

/** `key=value` and `key="quoted value"` pairs of one Go slog text line. */
function logFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of line.matchAll(/(\w+)=(?:"([^"]*)"|(\S+))/gu)) fields[match[1]] = match[2] ?? match[3];
  return fields;
}

/** "24.0 GiB", "457.0 MiB", "0 B" as Ollama prints sizes. */
function sizeBytes(text: string | undefined): number | null {
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/u.exec(text ?? "");
  const unit = match ? SIZE_UNITS[match[2]] : undefined;
  return match && unit ? Math.round(Number(match[1]) * unit) : null;
}

/**
 * Stage 1 (`compute` null): the registry's largest adapter. Stage 2: the most free memory on a non-cpu device Ollama
 * reports (spec D4: free VRAM), since the registry also lists adapters Ollama drops or cannot use. Too little RAM goes
 * remote either way (the model's commit lands in RAM beside the game, W1 facts).
 */
export function chooseModel(adapters: DisplayAdapter[], compute: ComputeDevice[] | null, ramBytes: number, manifest: ModelRequirements): ModelChoice {
  const { model, minVramGiB, minRamGiB } = manifest.ollama;
  const vramBytes = compute === null ? largest(adapters.map((a) => a.bytes)) : largest(compute.filter((d) => d.library !== "cpu").map((d) => d.freeBytes));
  if (vramBytes < minVramGiB * GIB) {
    const seen = compute === null ? "the largest display adapter has" : "the GPU Ollama can use has only";
    const free = compute === null ? "" : " free";
    return { kind: "remote", reason: `The local model needs ${minVramGiB} GiB of video memory; ${seen} ${formatGiB(vramBytes)}${free}.`, hint: compute === null ? `Use ${REMOTE_ENDPOINT}.` : `Close programs that use the GPU and run the installer again, or use ${REMOTE_ENDPOINT}.` };
  }
  if (ramBytes < minRamGiB * GIB) {
    return { kind: "remote", reason: `The local model needs ${minRamGiB} GiB of RAM; this PC has ${formatGiB(ramBytes)}.`, hint: `Use ${REMOTE_ENDPOINT}.` };
  }
  return { kind: "local", model };
}

/** A remote verdict as one text for a log or a summary: the facts, then what to do. */
export function remoteVerdictText(choice: Extract<ModelChoice, { kind: "remote" }>): string {
  return `${choice.reason} ${choice.hint}`;
}

function largest(values: number[]): number {
  return values.reduce((max, value) => Math.max(max, value), 0);
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GiB`;
}

/** The adapters and RAM of this PC with the model choice; a registry that cannot be read is a remote answer. */
export async function assessGpu(compute: ComputeDevice[] | null, manifest: ModelRequirements, facts: GpuFacts = realGpuFacts): Promise<GpuReport> {
  const ramBytes = facts.totalRamBytes();
  try {
    const adapters = parseRegistryVram(await facts.readRegistry());
    return { adapters, compute, ramBytes, choice: chooseModel(adapters, compute, ramBytes, manifest) };
  } catch (error) {
    const reason = `Could not read the display adapters (${error instanceof Error ? error.message : String(error)}).`;
    return { adapters: [], compute, ramBytes, choice: { kind: "remote", reason, hint: `Use ${REMOTE_ENDPOINT}.` } };
  }
}

/** `install gpu`: stage 1, before anything is downloaded. */
export async function gpu(ctx: InstallContext, facts: GpuFacts = realGpuFacts): Promise<GpuStepResult> {
  const report = await assessGpu(null, ctx.manifest, facts);
  const detail = report.choice.kind === "local" ? `Local model ${report.choice.model} can run here.` : remoteVerdictText(report.choice);
  return { ok: true, detail, report };
}

const realGpuFacts: GpuFacts = {
  async readRegistry() {
    const { stdout } = await promisify(execFile)("reg.exe", ["query", DISPLAY_ADAPTER_CLASS_KEY, "/s", "/v", MEMORY_VALUE], { encoding: "latin1", windowsHide: true });
    return stdout;
  },
  totalRamBytes: totalmem,
};
