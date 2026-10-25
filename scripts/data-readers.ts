/**
 * Data files the import graph cannot see. A module that reads repository files by path or by a directory walk (the
 * scenario YAML census, a SQL schema, a style folder) is not an importer of them, so a changed data file selected no test.
 * The reader says what it reads in one comment line, `// check-reads: <glob>[, <glob>]` (globs from the repository root,
 * `*` inside a segment, `**` across segments); a changed path matching a glob counts as a change of that reader, and
 * `check` runs the tests the import graph reaches from it. Nothing here lists a reader or a glob.
 * Any source line that opens a comment and holds the marker word is read as a declaration (or reported as a near-miss),
 * so a test fixture writing one inside a string builds the marker apart (`MARK` in `check.test.ts`).
 */

/** A line opening a comment and naming the marker: a declaration, or a near-miss of one that is reported (a marker after code is text). */
const MARKER_LINE = /^[ \t]*(?:\/\/|\/\*)[^\n]*check-reads[^\n]*$/gmu;
const DECLARATION = /^[ \t]*\/\/ check-reads:(.*)$/u;
const GLOB_CHARACTERS = /^[\w.@*/-]+$/u;

export interface DataRead {
  readonly data: string;
  readonly reader: string;
}

export interface MalformedDeclaration {
  readonly file: string;
  readonly line: number;
  readonly reason: string;
  readonly text: string;
}

export interface StaleGlob {
  readonly reader: string;
  readonly glob: string;
}

export interface DataReadPlan {
  /** Each changed path with a reader declaring a glob that matches it, sorted by data file then reader. */
  readonly reads: readonly DataRead[];
  /** The readers to start the importer walk from, each once. */
  readonly starts: readonly string[];
  readonly malformed: readonly MalformedDeclaration[];
  /** Well-formed globs matching no existing file and no changed path: the data moved or went. */
  readonly unmatched: readonly StaleGlob[];
}

/** Why a glob is not usable, or `undefined`: it must stay inside the repository and name a path. */
function globFault(glob: string): string | undefined {
  if (glob.length === 0) return "empty glob";
  if (!GLOB_CHARACTERS.test(glob)) return `"${glob}" holds a character other than letters, digits, . _ @ - / *`;
  if (glob.startsWith("/")) return `"${glob}" is not relative to the repository root`;
  const segments = glob.split("/");
  if (segments.some((segment) => segment === "")) return `"${glob}" has an empty path segment`;
  if (segments.some((segment) => segment === "." || segment === "..")) return `"${glob}" leaves the repository root`;
  return undefined;
}

/** The matcher of one well-formed glob. */
function globMatcher(glob: string): RegExp {
  const source = glob
    .replace(/\./gu, "\\.")
    .replace(/\*\*\/|\*\*|\*/gu, (star) => (star === "**/" ? "(?:.*/)?" : star === "**" ? ".*" : "[^/]*"));
  return new RegExp(`^${source}$`, "u");
}

interface Declarations {
  /** Reader -> its globs. */
  readonly globs: ReadonlyMap<string, readonly string[]>;
  readonly malformed: readonly MalformedDeclaration[];
}

/** The declarations of every source file; a malformed line contributes none of its globs. */
function declarationsIn(sources: ReadonlyMap<string, string>): Declarations {
  const globs = new Map<string, string[]>();
  const malformed: MalformedDeclaration[] = [];
  for (const [file, source] of sources) {
    if (!source.includes("check-reads")) continue;
    for (const match of source.matchAll(MARKER_LINE)) {
      const text = match[0].trim();
      const line = source.slice(0, match.index).split("\n").length;
      const declaration = DECLARATION.exec(match[0]);
      if (declaration === null) {
        malformed.push({ file, line, reason: "the marker is not `// check-reads: <glob>[, <glob>]`", text });
        continue;
      }
      const items = declaration[1]!.split(",").map((item) => item.trim());
      const fault = items.map(globFault).find((reason) => reason !== undefined);
      if (fault !== undefined) malformed.push({ file, line, reason: fault, text });
      else globs.set(file, [...(globs.get(file) ?? []), ...items]);
    }
  }
  return { globs, malformed };
}

/**
 * What the changed paths select among the readers of `sources` (file -> text). `files` are the existing files: a glob
 * matching none of them nor a changed (possibly deleted) path is reported as stale, never as a failure.
 */
export function planDataReads(changed: readonly string[], sources: ReadonlyMap<string, string>, files: readonly string[]): DataReadPlan {
  const { globs, malformed } = declarationsIn(sources);
  const reads: DataRead[] = [];
  const unmatched: StaleGlob[] = [];
  for (const [reader, readerGlobs] of globs) {
    for (const glob of readerGlobs) {
      const matches = globMatcher(glob);
      const hits = changed.filter((path) => matches.test(path));
      for (const data of hits) reads.push({ data, reader });
      if (hits.length === 0 && !files.some((file) => matches.test(file))) unmatched.push({ reader, glob });
    }
  }
  reads.sort((a, b) => a.data.localeCompare(b.data) || a.reader.localeCompare(b.reader));
  const seen = new Set<string>();
  const unique = reads.filter((read) => !seen.has(`${read.data}\0${read.reader}`) && seen.add(`${read.data}\0${read.reader}`));
  return { reads: unique, starts: [...new Set(unique.map((read) => read.reader))].sort(), malformed, unmatched };
}

/** `  <data file> via <reader>`, one line per pair. */
export function dataReadReport(reads: readonly DataRead[]): string[] {
  return reads.map((read) => `  ${read.data} via ${read.reader}`);
}

export function malformedReport(malformed: readonly MalformedDeclaration[]): string[] {
  return malformed.map((entry) => `check: ${entry.file}:${entry.line}: malformed check-reads declaration (${entry.reason}): ${entry.text}; fix or remove the line`);
}

export function unmatchedReport(unmatched: readonly StaleGlob[]): string[] {
  return unmatched.map((entry) => `check: warning: ${entry.reader}: check-reads glob ${entry.glob} matches no file; fix or remove the declaration`);
}
