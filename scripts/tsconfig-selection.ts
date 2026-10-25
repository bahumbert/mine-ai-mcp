/**
 * Which typechecks a changed compiler config or lockfile selects for `bun run check`: the `extends` chains of the
 * tsconfig files are read from the files (JSONC), never listed by hand.
 */
import { posix } from "node:path";

export const TSCONFIG_FILE = /(^|\/)tsconfig(\.[^/]+)?\.json$/u;
/** A change here can break any project's typecheck or install: `check` typechecks all of them and leaves the suite to pre-push-review. */
const ROOT_CONFIG_FILE = /^(tsconfig(\.[^/]+)?\.json|package\.json|bun\.lock)$/u;
export const FULL_SUITE_POINTER = "check: a dependency or root config changed: the full suite runs in pre-push-review";

/** The paths among `paths` that can select a typecheck: a root config, `package.json`, `bun.lock` or a `tsconfig*.json`. */
export function configFiles(paths: readonly string[]): string[] {
  return paths.filter((file) => ROOT_CONFIG_FILE.test(file) || TSCONFIG_FILE.test(file));
}

/** Drops the last comma of `out` when only whitespace follows it: a `}` or `]` is about to close the list. */
function dropTrailingComma(out: string[]): void {
  let last = out.length - 1;
  while (last >= 0 && /^\s*$/u.test(out[last]!)) last--;
  if (last >= 0 && out[last] === ",") out[last] = "";
}

/** `text` as JSON: a BOM, `//` and block comments and trailing commas removed outside strings (tsconfig files are JSONC). */
function stripJsonc(text: string): string {
  const out: string[] = [];
  for (let i = text.startsWith("﻿") ? 1 : 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out.push(text.slice(i, end + 1));
      i = end;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out.push("\n");
    } else if (char === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close < 0 ? text.length : close + 1;
    } else {
      if (char === "}" || char === "]") dropTrailingComma(out);
      out.push(char);
    }
  }
  return out.join("");
}

/**
 * Each tsconfig path (relative to the repository root, `/`-separated) -> the tsconfig paths it extends, read from the
 * file's text. A package name (`@tsconfig/bun`) is left out; a file that does not parse extends nothing and is named in
 * `unparsed` (its dependents cannot be found through it).
 */
export function tsconfigExtends(configs: ReadonlyMap<string, string>): { extendsOf: Map<string, string[]>; unparsed: string[] } {
  const extendsOf = new Map<string, string[]>();
  const unparsed: string[] = [];
  for (const [path, text] of configs) {
    let extended: unknown;
    try {
      extended = (JSON.parse(stripJsonc(text)) as { extends?: unknown }).extends;
    } catch {
      unparsed.push(path);
    }
    const parents = (Array.isArray(extended) ? extended : [extended]).filter((parent): parent is string => typeof parent === "string" && parent.startsWith("."));
    extendsOf.set(path, parents.map((parent) => posix.normalize(posix.join(posix.dirname(path), parent.endsWith(".json") ? parent : `${parent}.json`))));
  }
  return { extendsOf, unparsed };
}

/** `changed` and every config extending it, through any chain, each with its reason (config path -> reason). */
function configsAffectedBy(changed: string, extendsOf: ReadonlyMap<string, readonly string[]>, reasons: Map<string, string>): void {
  reasons.set(changed, `${changed} changed`);
  const queue = [changed];
  for (const config of queue) {
    const dependents = [...extendsOf].filter(([dependent, parents]) => parents.includes(config) && !reasons.has(dependent));
    for (const [dependent] of dependents) {
      reasons.set(dependent, `${changed} changed (${dependent} extends it)`);
      queue.push(dependent);
    }
  }
}

/**
 * The typechecks a changed compiler config or lockfile selects (project dir -> reason, in project order). A root
 * config, `package.json` or `bun.lock` selects every project, with `pointer` to say the full suite is not run here; a
 * project's `tsconfig*.json` selects its project and each project whose tsconfig extends it, through any chain.
 * A deleted config selects the same: `extendsOf` is read from the files that remain.
 */
export function configTypechecks(
  changedFiles: readonly string[],
  extendsOf: ReadonlyMap<string, readonly string[]>,
  projectDirs: readonly string[],
): { reasons: Map<string, string>; pointer: string | undefined } {
  const root = changedFiles.find((file) => ROOT_CONFIG_FILE.test(file));
  if (root !== undefined) return { reasons: new Map(projectDirs.map((dir) => [dir, `${root} changed`])), pointer: FULL_SUITE_POINTER };
  const configReasons = new Map<string, string>();
  for (const changed of changedFiles.filter((file) => TSCONFIG_FILE.test(file))) configsAffectedBy(changed, extendsOf, configReasons);
  const reasons = new Map<string, string>();
  for (const dir of projectDirs) {
    const config = [...configReasons.keys()].find((file) => file.startsWith(dir));
    if (config !== undefined) reasons.set(dir, configReasons.get(config)!);
  }
  return { reasons, pointer: undefined };
}
