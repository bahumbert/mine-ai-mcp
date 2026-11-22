// Shared by the iss-*.test.ts files that check the Inno Setup script (packaging/windows/mine-ai.iss): the script read with its
// `#include` files expanded in place (the [Code] section is split over several files, and a test must see all of it), the player's
// doc, the [Code] functions by name, and the stand-in CLI context the launcher calls run on.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CliContext } from "../cli-context.ts";
import { INSTALL_STEP_NAMES, type InstallSteps } from "../install-command.ts";
import { loadManifest } from "../manifest.ts";

export const repoRoot = join(import.meta.dirname, "..", "..", "..");
export const issPath = join(repoRoot, "packaging", "windows", "mine-ai.iss");

/** One `#include "<name>"` line of an Inno script. */
const INCLUDE_LINE = /^#include "([^"]+)"[ \t]*$/gmu;

export interface IssInclude {
  /** The name as the script spells it. */
  readonly name: string;
  /** Where the preprocessor looks: next to the file that includes it. */
  readonly path: string;
  readonly exists: boolean;
}

/** The files `file` includes directly, in order (the preprocessor reads a relative name from the including file's folder). */
export function issIncludes(file: string = issPath): IssInclude[] {
  return [...readFileSync(file, "utf8").matchAll(INCLUDE_LINE)].map((match) => {
    const path = join(dirname(file), match[1]!);
    return { name: match[1]!, path, exists: existsSync(path) };
  });
}

/**
 * The script as the compiler sees it: each `#include` line replaced by the text of its file, to any depth. A name that points to no
 * file stays as the `#include` line, so the checks on the code fail by what is missing (and the include test names the file).
 */
export function readIssWithIncludes(file: string = issPath, parents: readonly string[] = []): string {
  assert.equal(parents.includes(file), false, `${file} includes itself through ${parents.join(" -> ")}`);
  return readFileSync(file, "utf8").replace(INCLUDE_LINE, (line, name: string) => {
    const path = join(dirname(file), name);
    return existsSync(path) ? readIssWithIncludes(path, [...parents, file]).replace(/\r?\n$/u, "") : line;
  });
}

export const iss = readIssWithIncludes();
export const doc = readFileSync(join(repoRoot, "docs", "install", "windows.md"), "utf8");
/** The `[Code]` section without its comment lines, so a step named in a comment is not taken for a call. */
export const code = iss.slice(iss.indexOf("[Code]")).split(/\r?\n/u).filter((line) => !line.trim().startsWith("//")).join("\n");
/** The script without comment lines (`;` in the sections, `//` in [Code]). */
export const scriptLines = iss.split(/\r?\n/u).filter((line) => !/^\s*(?:;|\/\/)/u.test(line));

export const VALUES: Readonly<Record<string, string>> = { "<url>": "https://api.example.test/v1", "<key>": "sk-1", "<model>": "big-model", "<host>": "play.example", "<port>": "25570", "<ollamadir>": "D:\\Apps\\Ollama" };

export function setup() {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-iss-"));
  const out: string[] = [];
  const context: CliContext = { root, appRoot: root, out: (line) => void out.push(line), err: (line) => void out.push(line), loadManifest };
  const stepsRun: string[] = [];
  // The CLI hands `--dir` to the step as its third argument; what the step received is written back in the CLI's own words.
  const steps = Object.fromEntries(INSTALL_STEP_NAMES.map((name) => [name, async (_ctx: unknown, acceptEula: boolean, dir?: string) => (stepsRun.push([name, ...(acceptEula ? ["--accept-eula"] : []), ...(dir === undefined ? [] : ["--dir", dir])].join(" ")), { ok: true as const, detail: `${name} done` })])) as unknown as InstallSteps;
  return { root, context, stepsRun, steps };
}

/**
 * The [Code] functions and procedures with their bodies (comment lines already removed), by name. A body ends at its `end;` in column 0,
 * so a `var` or `const` block between two routines (the endpoint page's, in endpoint-page.iss) is no part of the routine before it.
 */
export function codeFunctions(): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of code.split("\n")) {
    const header = /^(?:function|procedure)\s+(\w+)/u.exec(line);
    if (header) {
      name = header[1]!;
      found.set(name, "");
    } else if (name !== undefined) {
      found.set(name, `${found.get(name)}${line}\n`);
      if (line === "end;") name = undefined;
    }
  }
  return found;
}

/** The text of one [Code] function, so a test names the function it pins. */
export function functionBody(name: string): string {
  const body = codeFunctions().get(name);
  assert.notEqual(body, undefined, `the .iss has no function ${name}`);
  return body!;
}
