// The Inno Setup script (packaging/windows/mine-ai.iss) compiled for real with Inno Setup's ISCC, when Inno Setup is installed.
// A serial test: `bun run test:fast` leaves this file to `bun run test` (plan 2026-11-18-unit-reds T4). Its ISCC child runs through
// WSL interop, which fails `accept4 failed 110` while the machine is busy (alone 2.9 s; 10.2 s to that failure at load 47-126).
// `bun run check` runs it when its imports change or the script changes (the declaration below), and pre-push runs it in `bun run test`.
// check-reads: packaging/windows/*.iss
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findInnoCompiler } from "./build-windows.ts";
import { issPath, repoRoot } from "./iss-test-support.ts";

interface TestCompiler {
  readonly program: string;
  /** A path of this machine as the compiler reads it (WSL: `wslpath -w`). */
  readonly path: (file: string) => string;
}

/** ISCC.exe: on Windows from `INNO_SETUP` or the default folders (as the release build); in WSL the same folders through the Windows drive. Undefined when Inno Setup is not installed. */
function findIsccForTests(): TestCompiler | undefined {
  if (process.platform === "win32") {
    try {
      return { program: findInnoCompiler(process.env, existsSync), path: (file) => file };
    } catch {
      return undefined;
    }
  }
  const users = existsSync("/mnt/c/Users") ? readdirSync("/mnt/c/Users").map((user) => `/mnt/c/Users/${user}/AppData/Local/Programs/Inno Setup 6`) : [];
  const folders = process.env.INNO_SETUP === undefined ? ["/mnt/c/Program Files (x86)/Inno Setup 6", "/mnt/c/Program Files/Inno Setup 6", ...users] : [process.env.INNO_SETUP];
  const program = folders.map((folder) => join(folder, "ISCC.exe")).find((file) => existsSync(file));
  if (program === undefined) return undefined;
  return { program, path: (file) => spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim() };
}

// Pascal Script is only checked by a real compile: a typo or a property Inno lacks on the endpoint page is otherwise found by the
// master's build. ISCC runs on a stand-in stage folder (a bun.exe and a persona file), so the compile takes seconds.
// Facts "Inno Setup script": MSYS2_ARG_CONV_EXCL="*" keeps Git Bash from rewriting the /D arguments; the /D paths are absolute.
// The limit is also the ISCC child's watchdog: a test limit does not stop a synchronous child.
const ISCC_LIMIT_MS = 20_000;
const compiler = findIsccForTests();
// limit: 5 x the worst measured pass (3.3 s, 3 runs while one test:fast ran, load 2-3; alone 1.9-2.2 s in 5 runs), rounded up to 10 s = 20 s
test("the real script compiles with Inno Setup's ISCC", { skip: compiler === undefined ? "ISCC.exe not found (set INNO_SETUP to Inno Setup 6's folder; in WSL as a /mnt/c/... path)" : false, timeout: ISCC_LIMIT_MS }, () => {
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  const work = mkdtempSync(join(repoRoot, ".tmp", "iss-compile-"));
  try {
    const stage = join(work, "stage");
    mkdirSync(join(stage, "personas"), { recursive: true });
    writeFileSync(join(stage, "bun.exe"), "stand-in");
    writeFileSync(join(stage, "personas", "stand-in.json"), "{}");
    const args = [`/DStageDir=${compiler!.path(stage)}`, `/DOutputDir=${compiler!.path(join(work, "out"))}`, "/DAppVersion=0.0.0", compiler!.path(issPath)];
    const result = spawnSync(compiler!.program, args, { encoding: "utf8", timeout: ISCC_LIMIT_MS, env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" } });
    const output = `${result.stdout}\n${result.stderr}`;
    // ISCC prints "Error on line <n> in <file>: Column <c>:" and, on the next line, what is wrong.
    const error = output.slice(Math.max(0, output.search(/^Error on line/mu)));
    const expired = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    assert.equal(result.status, 0, expired ? `ISCC passed its ${ISCC_LIMIT_MS / 1000} s watchdog and was killed\n${error}` : error);
  } finally {
    // maxRetries: a virus scanner may hold the freshly written setup exe for a moment on Windows.
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
