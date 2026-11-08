/** Install step `server`: the pinned vanilla server jar, `server.properties` for bots, and `eula.txt` only when accepted. */
import { totalmem } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest } from "../manifest.ts";
import type { DiskDeps } from "./disk.ts";
import { downloadFailureHint, downloadVerified } from "./download.ts";
import { freeSpaceHint, guardDownload, spaceGuardFor } from "./space-guard.ts";
import { failure, stepFailure, type InstallContext, type StepResult } from "./step.ts";

const EULA_URL = "https://aka.ms/MinecraftEULA";
const GIB = 1024 ** 3;

/** The text of an existing `server.properties` with `managed` keys set in place (others, comments and order kept), missing ones appended. */
function withManagedProperties(existing: string, managed: ReadonlyMap<string, string>): string {
  const pending = new Map(managed);
  const lines = existing === "" ? [] : existing.replace(/\r?\n$/u, "").split(/\r?\n/u);
  const updated = lines.map((line) => {
    const key = line.startsWith("#") ? "" : line.slice(0, Math.max(line.indexOf("="), 0));
    if (key === "" || !pending.has(key)) return line;
    const value = pending.get(key)!;
    pending.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of pending) updated.push(`${key}=${value}`);
  return `${updated.join("\n")}\n`;
}

/** Server heap in MB: the manifest's MB per GiB of RAM, clamped between its min and max. */
export function serverMemoryMb(manifest: Manifest, totalRamBytes: number = totalmem()): number {
  const { min, perRamGb, max } = manifest.minecraft.memoryMb;
  return Math.min(max, Math.max(min, Math.floor((perRamGb * totalRamBytes) / GIB)));
}

async function isEulaAccepted(eulaPath: string): Promise<boolean> {
  if (!existsSync(eulaPath)) return false;
  return /^eula=true\s*$/mu.test(await readFile(eulaPath, "utf8"));
}

export interface ServerDeps {
  readonly fetchImpl?: typeof fetch;
  /** The free-space reads of the guard; the real disk when absent. */
  readonly disk?: DiskDeps;
}

/**
 * Downloads the jar and writes `server.properties` (`online-mode=false`, `server-ip=127.0.0.1`, the settings' port,
 * `difficulty=normal`; other keys of an existing file kept). `eula.txt` is written only with `acceptEula`; an
 * `eula.txt` already saying true (an earlier acceptance) lets an update run without the flag.
 */
export async function server(ctx: InstallContext, acceptEula: boolean, deps: ServerDeps = {}): Promise<StepResult> {
  const { server: serverSettings } = ctx.settings;
  if (serverSettings.kind !== "local") {
    return failure(`The settings choose a ${serverSettings.kind} server, not a local one.`, "Run `mine-ai configure --server-local` first, then this step again.");
  }
  const dir = join(ctx.root, "server");
  const eulaPath = join(dir, "eula.txt");
  if (!acceptEula && !(await isEulaAccepted(eulaPath))) {
    return failure("EULA not accepted.", `Read the Minecraft EULA (${EULA_URL}) and run this step with --accept-eula; the installer asks for it on its server page.`);
  }
  await mkdir(dir, { recursive: true });
  const jar = join(dir, "server.jar");
  const jarGuard = spaceGuardFor(ctx, deps.disk, freeSpaceHint(), (downloadBytes) => [{ what: "the Minecraft server", folder: dir, bytes: downloadBytes }]);
  try {
    const noRoom = await guardDownload(jarGuard, existsSync(jar), (beforeBody) =>
      downloadVerified(ctx.manifest.minecraft.jar.url, jar, { sha1: ctx.manifest.minecraft.jar.sha1 }, (fraction) => ctx.onProgress(fraction * 0.95, "Downloading the Minecraft server"), deps.fetchImpl, undefined, { beforeBody }),
    );
    if (noRoom !== null) return noRoom;
  } catch (error) {
    return stepFailure(error, downloadFailureHint(error));
  }
  const propertiesPath = join(dir, "server.properties");
  const existing = existsSync(propertiesPath) ? await readFile(propertiesPath, "utf8") : "";
  const managed = new Map([
    ["online-mode", "false"],
    ["server-ip", "127.0.0.1"],
    ["server-port", String(serverSettings.port)],
    ["difficulty", "normal"],
  ]);
  await writeFile(propertiesPath, withManagedProperties(existing, managed));
  if (acceptEula) await writeFile(eulaPath, `#By changing the setting below to TRUE you are indicating your agreement to our EULA (${EULA_URL}).\neula=true\n`);
  ctx.onProgress(1, "Minecraft server ready");
  return { ok: true, detail: `Minecraft ${ctx.manifest.minecraft.version} server ready in ${dir} (port ${serverSettings.port}, online-mode off).` };
}
