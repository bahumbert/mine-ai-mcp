// A stub `lshw` first on the PATH of every Mine Labs server JVM. The server's hardware probe (oshi: `lshw -class processor`
// and `lshw -C display`, measured 2026-11-07 in a probe daemon) hangs in this WSL in `_hv_pcifront_read_config` and stalls
// the VM about every 60 s. The answers only feed the crash report and the CPU-load profiler, never the game; exit 1 makes
// oshi give up at once. `.agent/scripts/ops/start-server.sh` does the same for the live server, in the same directory.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const STUB_SCRIPT = "#!/bin/sh\nexit 1\n";

/** Writes the stub `lshw` (atomically: a server starting at the same moment never runs a half-written file) and returns its directory. */
export async function installLshwStub(tempDir: string = tmpdir()): Promise<string> {
  const stubDir = join(tempDir, "mine-ai-stubs");
  await mkdir(stubDir, { recursive: true });
  const partial = join(stubDir, `lshw.${process.pid}.tmp`);
  await writeFile(partial, STUB_SCRIPT, { mode: 0o755 });
  await rename(partial, join(stubDir, "lshw"));
  return stubDir;
}

/**
 * Puts the stub first on `env.PATH` in place: Mine Labs spawns its server JVM with no `env` option, so the JVM inherits the
 * process's PATH. WSL only (`PATH` is the key there; Windows names it `Path`). A stub that cannot be written (a read-only
 * or foreign-owned temp directory) is logged and skipped: the servers then run as before, with the hang risk, not stopped.
 */
export async function putLshwStubOnPath(log: (message: string) => void, env: Record<string, string | undefined> = process.env, tempDir: string = tmpdir()): Promise<void> {
  try {
    env.PATH = pathWithStubFirst(env.PATH, await installLshwStub(tempDir));
  } catch (error) {
    log(`lshw stub not installed (${error instanceof Error ? error.message : String(error)}): server JVMs may stall on oshi's lshw, see knowledge/05-testing-and-ops.md "WSL clock and VM stalls"`);
  }
}

/** `path` with `stubDir` first (once); a missing or empty PATH becomes `stubDir` alone, never an empty entry (= the current directory). */
export function pathWithStubFirst(path: string | undefined, stubDir: string): string {
  const entries = (path ?? "").split(delimiter).filter(entry => entry !== "");
  return (entries[0] === stubDir ? entries : [stubDir, ...entries]).join(delimiter);
}
