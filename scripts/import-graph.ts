/**
 * Reverse import graph for `bun run check`: which test files load a changed file, through how many importers.
 * Pure (no git, no disk, no exit): `check.ts` reads the files and `package.json` and passes them in.
 */
import { posix } from "node:path";

/**
 * Importer levels followed from a changed file (plan 2026-10-21-check-importers-coverage, measured on 8954c22): depth 2
 * is the smallest that reaches `mine-process.test.ts` from e7201c8 (the miss this exists for); depth 3 already reaches
 * a third of the suite (95-109 test files) for one world file.
 */
export const IMPORTER_DEPTH = 2;

/** About 55 s of `bun test` at 0.35 s per file (same plan); over it, only the direct importers' tests run. */
export const IMPORTER_TEST_CAP = 150;

/** The `package.json` mappings a specifier can go through: `#src/*`-style imports and the package's own exports. */
export interface ImportAliases {
  /** Prefix aliases, `#src/` -> `src/` (from `"#src/*": "./src/*"`). */
  readonly prefixes: readonly { readonly alias: string; readonly target: string }[];
  /** Full specifiers of the package's own name, `@scope/name/transport` -> `src/server/http.ts`. */
  readonly selfExports: ReadonlyMap<string, string>;
}

export interface ReverseGraph {
  /** Target file -> files importing it at runtime (type-only imports are not edges). */
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Target file -> files importing it at runtime or for its types only, re-exports included (for the typecheck). */
  readonly typeImporters: ReadonlyMap<string, ReadonlySet<string>>;
  /** Files whose every statement is a re-export: they cost no level (the `actions/<x>/index.ts` barrels). */
  readonly reexportOnly: ReadonlySet<string>;
  /** Files the transpiler could not scan (mid-edit syntax error): their imports are not followed. */
  readonly unparsed: readonly string[];
}

export interface ReachedTest {
  readonly file: string;
  /** Importer levels between the change and the test: 0 for a changed test file, 1 for a direct importer. */
  readonly depth: number;
  /** The changed file the test was reached from (the nearest one). */
  readonly from: string;
}

export interface TestsReached {
  /** Tests to run, nearest first. */
  readonly tests: readonly ReachedTest[];
  /** Tests deeper than 1 left out because the set was over the cap. */
  readonly dropped: number;
  /** The tests at depth 0 and 1 alone are over the cap (they still all run). */
  readonly depthOneOverCap: boolean;
  /** Tests reached outside the suite's test paths: `bun run test` never runs them, so `check` does not either. */
  readonly outsideSuite: readonly string[];
}

/** Reads the aliases out of a parsed `package.json` (`imports` wildcards, `name` + `exports`). */
export function aliasesFromPackageJson(pkg: unknown): ImportAliases {
  const json = (pkg ?? {}) as { name?: unknown; imports?: Record<string, unknown>; exports?: Record<string, unknown> };
  const prefixes = Object.entries(json.imports ?? {})
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[0].endsWith("*") && entry[1].endsWith("*"))
    .map(([alias, target]) => ({ alias: alias.slice(0, -1), target: posix.normalize(target.slice(0, -1)) }));
  const selfExports = new Map<string, string>();
  if (typeof json.name === "string") {
    for (const [subpath, value] of Object.entries(json.exports ?? {})) {
      const target = exportTarget(value);
      if (target !== undefined) selfExports.set(posix.join(json.name, subpath), posix.normalize(target));
    }
  }
  return { prefixes, selfExports };
}

/** The file an `exports` entry points at: a string, or its `import` (else `default`) condition. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  const chosen = conditions.import ?? conditions.default;
  return typeof chosen === "string" ? chosen : undefined;
}

/**
 * The repository file a specifier in `from` loads, or `undefined` for a package or a file not in `known`.
 * Paths are repository-relative with `/`; a `.js` specifier names its `.ts` (NodeNext style).
 */
export function localSpecifierTarget(from: string, specifier: string, known: ReadonlySet<string>, aliases: ImportAliases): string | undefined {
  const selfTarget = aliases.selfExports.get(specifier);
  if (selfTarget !== undefined) return known.has(selfTarget) ? selfTarget : undefined;
  const base = specifierBase(from, specifier, aliases);
  if (base === undefined) return undefined;
  const candidates = [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), `${base}.ts`, `${base}/index.ts`];
  return candidates.find((candidate) => known.has(candidate));
}

/** The repository path a relative or `#alias` specifier names before extension rules; `undefined` for a package. */
function specifierBase(from: string, specifier: string, aliases: ImportAliases): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return posix.join(posix.dirname(from), specifier);
  const prefix = aliases.prefixes.find((entry) => specifier.startsWith(entry.alias));
  return prefix === undefined ? undefined : posix.join(prefix.target, specifier.slice(prefix.alias.length));
}

const REEXPORT_STATEMENT = /^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'][^"']+["']\s*;?/u;

/** Whether every statement of `source` (comments removed) is `export * from`, `export {..} from` or `export type {..} from`. */
export function isReexportOnly(source: string): boolean {
  let rest = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
  let statements = 0;
  for (let match = REEXPORT_STATEMENT.exec(rest); match !== null; match = REEXPORT_STATEMENT.exec(rest)) {
    rest = rest.slice(match[0].length);
    statements++;
  }
  return statements > 0 && rest.trim() === "";
}

/**
 * The specifiers of the import and export statements of `source`, type-only ones included: a line starting with
 * `import`/`export` (its first string: `from "x"`, `import "x"`, `import a = require("x")`) or the `} from "x"` closing
 * line of a multi-line one. A regex, not the transpiler: it keeps type imports and reads a file that does not parse;
 * anchored at line starts so import text inside a string (a test fixture) is not taken for an import (review 2026-10-21).
 */
function staticSpecifiers(source: string): string[] {
  const statementLines = /^\s*(?:import|export)\b[^"'\n]*["']([^"'\n]+)["']|^[^"'\n]*\}\s*from\s*["']([^"'\n]+)["']/gmu;
  return [...source.matchAll(statementLines)].map((match) => (match[1] ?? match[2])!);
}

/** Records `file` as an importer of each resolved target of `specifiers`. */
function addEdges(
  edges: Map<string, Set<string>>,
  file: string,
  specifiers: readonly string[],
  options: { readonly known: ReadonlySet<string>; readonly aliases: ImportAliases },
): void {
  for (const specifier of specifiers) {
    const target = localSpecifierTarget(file, specifier, options.known, options.aliases);
    if (target === undefined || target === file) continue;
    let set = edges.get(target);
    if (set === undefined) edges.set(target, (set = new Set()));
    set.add(file);
  }
}

/** Import kinds that load a file at runtime; Bun's scanner already leaves type-only imports out. */
const RUNTIME_IMPORT_KINDS = new Set(["import-statement", "dynamic-import", "require-call"]);

const TRANSPILERS = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };

/** The runtime specifiers of one file; throws on a syntax error. `scanImports` also throws on a `#!` line, so it goes first. */
function runtimeSpecifiers(file: string, source: string): string[] {
  const transpiler = file.endsWith(".tsx") ? TRANSPILERS.tsx : TRANSPILERS.ts;
  const withoutShebang = source.startsWith("#!") ? source.slice(source.indexOf("\n") + 1) : source;
  return transpiler
    .scanImports(withoutShebang)
    .filter((entry) => RUNTIME_IMPORT_KINDS.has(entry.kind))
    .map((entry) => entry.path);
}

/**
 * Builds target -> importers over `sources` (path -> text). `known` holds every path a specifier may name: the sources,
 * the `.json` data files and deleted files (so their former importers still point at them).
 */
export function buildReverseGraph(
  sources: ReadonlyMap<string, string>,
  options: { readonly known: ReadonlySet<string>; readonly aliases: ImportAliases },
): ReverseGraph {
  const importers = new Map<string, Set<string>>();
  const typeImporters = new Map<string, Set<string>>();
  const reexportOnly = new Set<string>();
  const unparsed: string[] = [];
  for (const [file, source] of sources) {
    addEdges(typeImporters, file, staticSpecifiers(source), options);
    let specifiers: string[];
    try {
      specifiers = runtimeSpecifiers(file, source);
    } catch {
      unparsed.push(file);
      continue;
    }
    if (isReexportOnly(source)) reexportOnly.add(file);
    addEdges(importers, file, specifiers, options);
    // A runtime load is a type dependency too (a `require` or dynamic import the line scan does not see).
    addEdges(typeImporters, file, specifiers, options);
  }
  return { importers, typeImporters, reexportOnly, unparsed };
}

/** A test file by the repository's naming (`x.test.ts`, as the sibling rule of `check.ts`). */
export function isTestFile(file: string): boolean {
  return /\.test\.tsx?$/u.test(file);
}

/**
 * Every file within `depth` importer levels of `starts`, with its level and nearest start: breadth-first from all
 * starts at once; a reached test is not walked further (a changed test is); a re-export-only file costs no level.
 */
function importerLevels(starts: readonly string[], graph: ReverseGraph, depth: number): Map<string, { depth: number; from: string }> {
  const reached = new Map<string, { depth: number; from: string }>();
  let frontier = starts.map((file) => ({ file, from: file }));
  for (let level = 0; level <= depth && frontier.length > 0; level++) {
    const atLevel: { file: string; from: string }[] = [];
    const queue = [...frontier];
    for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
      if (reached.has(entry.file)) continue;
      reached.set(entry.file, { depth: level, from: entry.from });
      atLevel.push(entry);
      // A barrel's importers sit at the barrel's own level; a changed barrel (level 0) is walked like any start.
      if (level > 0 && graph.reexportOnly.has(entry.file)) queue.push(...importersOf(entry, graph));
    }
    frontier = atLevel
      .filter((entry) => (level === 0 || !isTestFile(entry.file)) && !(level > 0 && graph.reexportOnly.has(entry.file)))
      .flatMap((entry) => importersOf(entry, graph));
  }
  return reached;
}

/** The files importing `entry.file`, carrying its start. */
function importersOf(entry: { file: string; from: string }, graph: ReverseGraph): { file: string; from: string }[] {
  return [...(graph.importers.get(entry.file) ?? [])].map((file) => ({ file, from: entry.from }));
}

/**
 * The test files within `depth` importer levels of the changed `starts`. Over `cap`, the tests at depth 0 and 1 all
 * stay (even over it) and the deeper ones are dropped and counted. A test outside `testRoots` (path prefixes of the
 * suite's test paths) is listed apart: `bun run test` never runs it.
 */
export function testsReachedBy(
  starts: readonly string[],
  graph: ReverseGraph,
  options: { readonly depth: number; readonly cap: number; readonly testRoots: readonly string[] },
): TestsReached {
  const all: ReachedTest[] = [];
  const outsideSuite: string[] = [];
  for (const [file, place] of importerLevels(starts, graph, options.depth)) {
    if (!isTestFile(file)) continue;
    if (options.testRoots.some((root) => file.startsWith(root))) all.push({ file, ...place });
    else outsideSuite.push(file);
  }
  all.sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
  const near = all.filter((entry) => entry.depth <= 1);
  if (all.length <= options.cap) return { tests: all, dropped: 0, depthOneOverCap: false, outsideSuite: outsideSuite.sort() };
  return { tests: near, dropped: all.length - near.length, depthOneOverCap: near.length > options.cap, outsideSuite: outsideSuite.sort() };
}

/**
 * The projects (of `projectDirs`, path prefixes) holding a file that imports a changed file, through any number of
 * importers and type-only imports included, each with one such importer: a change there can break their types.
 */
export function projectsImporting(starts: readonly string[], graph: ReverseGraph, projectDirs: readonly string[]): Map<string, string> {
  const seen = new Set(starts);
  const projects = new Map<string, string>();
  const queue = [...starts];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const importer of graph.typeImporters.get(file) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
      const dir = projectDirs.find((prefix) => importer.startsWith(prefix));
      if (dir !== undefined && !projects.has(dir)) projects.set(dir, importer);
    }
  }
  return projects;
}
