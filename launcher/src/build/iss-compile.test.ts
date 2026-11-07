// The Inno Setup script (packaging/windows/mine-ai.iss) compiled for real with Inno Setup's ISCC (a compile error is a red test) when Inno
// Setup is installed, plus the check that every `#include` of the script names a file that exists.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { findInnoCompiler } from "./build-windows.ts";
import { issIncludes, issPath, repoRoot } from "./iss-test-support.ts";

test("launcher tests do not read the unexpanded installer script by path", () => {
  const source = join(repoRoot, "launcher", "src");
  const tests = readdirSync(source, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".test.ts"));
  const rawReads = tests.filter((name) => /(?:readFileSync|Bun\.file)\s*\([^;]*?["'`][^"'`]*mine-ai\.iss["'`]/su.test(readFileSync(join(source, name), "utf8")));
  assert.deepEqual(rawReads, [], "read the script through iss-test-support so includes are visible");
});

test("every #include of the script names a file next to it, and each included file starts with a comment saying what it holds", () => {
  const includes = issIncludes();
  assert.deepEqual(includes.filter((include) => !include.exists).map((include) => include.name), [], "an #include names a file that does not exist (ISCC would stop there)");
  for (const include of includes) {
    const first = readFileSync(include.path, "utf8").split(/\r?\n/u).find((line) => line.trim() !== "");
    assert.match(first ?? "", /^\/\/ \S/u, `${include.name} starts with no header comment`);
  }
});

test("the endpoint page's code is in endpoint-page.iss, pulled in by the script, and the script itself no longer holds it", () => {
  const includes = issIncludes();
  const endpoint = includes.find((include) => include.name === "endpoint-page.iss");
  assert.ok(endpoint, "mine-ai.iss has no #include \"endpoint-page.iss\"");
  const own = readFileSync(endpoint.path, "utf8");
  const script = readFileSync(issPath, "utf8");
  for (const name of ["CreateEndpointPage", "ListModels", "ApplyEndpointCorrection", "RemoteKeyChanged", "ListKeyArguments", "RemoteLlmArguments"]) {
    assert.match(own, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is not in endpoint-page.iss`);
    assert.doesNotMatch(script, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is still in mine-ai.iss`);
  }
  // The include is inside [Code]: the expanded script holds the functions after its [Code] line.
  assert.ok(script.indexOf('#include "endpoint-page.iss"') > script.indexOf("[Code]"));
});

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
const compiler = findIsccForTests();
test("the real script compiles with Inno Setup's ISCC", { skip: compiler === undefined ? "ISCC.exe not found (set INNO_SETUP to Inno Setup 6's folder; in WSL as a /mnt/c/... path)" : false, timeout: 120_000 }, () => {
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  const work = mkdtempSync(join(repoRoot, ".tmp", "iss-compile-"));
  try {
    const stage = join(work, "stage");
    mkdirSync(join(stage, "personas"), { recursive: true });
    writeFileSync(join(stage, "bun.exe"), "stand-in");
    writeFileSync(join(stage, "personas", "stand-in.json"), "{}");
    const args = [`/DStageDir=${compiler!.path(stage)}`, `/DOutputDir=${compiler!.path(join(work, "out"))}`, "/DAppVersion=0.0.0", compiler!.path(issPath)];
    const result = spawnSync(compiler!.program, args, { encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" } });
    const output = `${result.stdout}\n${result.stderr}`;
    // ISCC prints "Error on line <n> in <file>: Column <c>:" and, on the next line, what is wrong.
    const error = output.slice(Math.max(0, output.search(/^Error on line/mu)));
    assert.equal(result.status, 0, error);
  } finally {
    // maxRetries: a virus scanner may hold the freshly written setup exe for a moment on Windows.
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
