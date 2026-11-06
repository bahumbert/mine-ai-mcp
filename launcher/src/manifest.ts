/** The installer's pinned downloads and every number the owner may tune (`packaging/manifest.json`), validated once. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appRoot } from "./paths.ts";

const httpsUrl = z.url().refine((url) => url.startsWith("https:"), "a download URL must be https");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u, "expected 64 lowercase hex digits (SHA-256)");
const sha1 = z.string().regex(/^[0-9a-f]{40}$/u, "expected 40 lowercase hex digits (SHA-1)");
const positiveInt = z.number().int().positive();
const downloadSha256 = z.strictObject({ url: httpsUrl, sha256 });

/** Shape of `packaging/manifest.json`; strict, so a misspelled key fails at load, not at the step that needs it. */
export const manifestSchema = z.strictObject({
  version: z.string().min(1),
  minecraft: z.strictObject({
    version: z.string().min(1),
    jar: z.strictObject({ url: httpsUrl, sha1 }),
    /** Server heap in MB: `perRamGb` per GiB of the machine's RAM, clamped to `min`..`max`. */
    memoryMb: z.strictObject({ min: positiveInt, perRamGb: positiveInt, max: positiveInt }),
  }),
  java: z.strictObject({
    url: httpsUrl,
    sha256,
    /** Bytes of the unpacked JRE (`du -sb`, measured again whenever the pin changes): the disk check counts them beside the zip. */
    installedBytes: positiveInt,
  }),
  ollama: z.strictObject({
    url: httpsUrl,
    sha256,
    /** Bytes of the installed Ollama folder (`du -sb`, measured again whenever the pin changes): the disk check counts them beside the setup. */
    installedBytes: positiveInt,
    minVersion: z.string().min(1),
    port: positiveInt,
    env: z.record(z.string(), z.string()),
    model: z.string().min(1),
    minVramGiB: positiveInt,
    minRamGiB: positiveInt,
  }),
  brainEnv: z.record(z.string(), z.string()),
  brainModelSlots: positiveInt,
  bun: downloadSha256,
  defaultBots: z.array(z.string().min(1)),
  waits: z.strictObject({
    ollamaUpMs: positiveInt,
    warmUpMs: positiveInt,
    serverDoneMs: positiveInt,
    hostHealthMs: positiveInt,
    serverStopMs: positiveInt,
    // The longest a model download may send nothing: Bun ends a fetch silent for 360 s with a raw TimeoutError, so the
    // pull turns that limit off and uses this bound, which says what happened and leaves the resume to the next run.
    modelPullIdleMs: positiveInt,
  }),
  release: z.strictObject({ latestUrl: httpsUrl }),
  /** `reserveBytes` stays free on each drive a step downloads to, counted once per drive (spec 2026-11-06 D1). */
  disk: z.strictObject({ reserveBytes: positiveInt }),
  /**
   * In-game bot commands (spec D7): per-sender cooldown, refusal repeat, console poll, age limit of a heard line, delay
   * before the listener joins, and the longest a held answer waits for a way out (the listener joining after our own stop).
   */
  commands: z.strictObject({
    cooldownMs: positiveInt,
    refusalEveryMs: positiveInt,
    pollMs: positiveInt,
    maxAgeMs: positiveInt,
    listenerAfterMs: positiveInt,
    answerWaitMs: positiveInt,
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;

/** `<app root>/packaging/manifest.json`, next to `launcher/` in the installed app and in the repository. */
export const shippedManifestPath = (): string => join(appRoot(), "packaging", "manifest.json");

/** Reads and validates the manifest; every failure names the file and, for a schema issue, the offending key path. */
export function loadManifest(path: string = shippedManifestPath()): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the manifest ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new Error(`Invalid manifest ${path}: ${issues.join("; ")}`);
  }
  return parsed.data;
}
