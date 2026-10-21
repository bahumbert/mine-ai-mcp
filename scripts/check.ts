/**
 * `bun run check`: the quick loop. Typechecks the projects with changed files or with files importing them (type-only
 * imports included), and runs the tests next to the changed files (`x.ts` → `x.test.ts`) plus the tests that load
 * them through up to `IMPORTER_DEPTH` importers (`--depth <n>`; `--depth 0` = next-to only): uncommitted work by
 * default, `bun run check origin/main` for the whole branch.
 * `bun run test` (`--all`): every project present in this checkout (the monitor is not in every one); arguments after
 * `--all` go to its `bun test` call (`bun run test -- --coverage`).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  aliasesFromPackageJson,
  buildReverseGraph,
  IMPORTER_DEPTH,
  IMPORTER_TEST_CAP,
  projectsImporting,
  testsReachedBy,
  type ReverseGraph,
  type TestsReached,
} from "./import-graph.js";

const PROJECTS: readonly { readonly dir: string; readonly typecheck: string; readonly tests: string }[] = [
  { dir: "src/", typecheck: "typecheck", tests: "./src" },
  { dir: "scenarios/", typecheck: "typecheck:scenarios", tests: "./scenarios/src" },
  { dir: "tests/", typecheck: "typecheck:tests", tests: "./tests" },
  { dir: "brain/", typecheck: "typecheck:brain", tests: "./brain" },
  { dir: "monitor/", typecheck: "typecheck:monitor", tests: "./monitor" },
  { dir: "scripts/", typecheck: "typecheck:scripts", tests: "./scripts" },
];

/**
 * A worktree's `.git` is a file `gitdir: <path>`; created from Windows the path is `D:/...`, which git inside WSL cannot
 * resolve ("not a git repository"). Then the Windows git (`git.exe`, reachable from WSL by interop) is the one that works.
 */
export function gitProgram(root: string = process.cwd()): "git" | "git.exe" {
  const dotGit = join(root, ".git");
  try {
    if (!statSync(dotGit).isFile()) return "git";
    return /^gitdir:\s*[A-Za-z]:[\\/]/u.test(readFileSync(dotGit, "utf8")) ? "git.exe" : "git";
  } catch {
    return "git";
  }
}

export function missingGitMessage(program: string): string {
  return `check: cannot run ${program}. This worktree's .git file holds a Windows gitdir that WSL git cannot read, so the Windows git (git.exe) is needed on the WSL PATH; refusing to report "no changed file".`;
}

/** `check [<base>] [--depth <n>]`; throws on a `--depth` that is not a whole number. */
export function parseCheckArgs(args: readonly string[]): { base: string | undefined; depth: number } {
  let base: string | undefined;
  let depth = IMPORTER_DEPTH;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--depth") {
      base = args[i];
      continue;
    }
    const value = args[++i];
    if (value === undefined || !/^\d+$/u.test(value)) throw new Error(`check: --depth needs a whole number, got ${value ?? "nothing"}`);
    depth = Number(value);
  }
  return { base, depth };
}

/** The lines `check` prints about the importer tests before running them. */
export function importerReport(reached: TestsReached, unparsed: readonly string[]): string[] {
  const direct = reached.tests.filter((entry) => entry.depth <= 1).length;
  const dropped = reached.dropped > 0 ? `, ${reached.dropped} dropped over the cap of ${IMPORTER_TEST_CAP}: bun run test for all` : "";
  const lines = [`check: importers: ${reached.tests.length} test file(s) (${direct} changed or direct, ${reached.tests.length - direct} at depth 2 or more${dropped})`];
  if (reached.depthOneOverCap) lines.push(`check: depths 0 and 1 alone are ${direct} test files, over the cap of ${IMPORTER_TEST_CAP}`);
  for (const entry of reached.tests) lines.push(`  ${entry.file} <- ${entry.from} (${entry.depth})`);
  for (const file of reached.outsideSuite) lines.push(`check: ${file} is reached but outside bun run test: not run`);
  for (const file of unparsed) lines.push(`check: cannot parse ${file}: its imports are not followed`);
  return lines;
}

function git(...args: string[]): string[] {
  const program = gitProgram();
  let result: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    result = Bun.spawnSync([program, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    console.error(missingGitMessage(program));
    process.exit(1);
  }
  if (!result.success) {
    console.error(`check: ${program} ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
    process.exit(1);
  }
  return result.stdout.toString().split("\n").map((line) => line.replace(/\r$/u, "")).filter((line) => line.length > 0);
}

function run(command: string[]): boolean {
  console.log(`$ ${command.join(" ")}`);
  return Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }).success;
}

function inProject(file: string): boolean {
  return PROJECTS.some((project) => file.startsWith(project.dir));
}

/** Changed `.ts`/`.tsx`/`.json` paths since `base` plus untracked ones, deleted paths included (a rename gives its old path too). */
function changedPaths(base: string): string[] {
  const paths = [...git("diff", "--name-only", "--no-renames", base), ...git("ls-files", "--others", "--exclude-standard")];
  return [...new Set(paths)].filter((file) => /\.(ts|tsx|json)$/u.test(file) && inProject(file));
}

/** The reverse import graph of every tracked or untracked source of the projects; `deleted` stay resolvable. */
function repositoryGraph(deleted: readonly string[]): ReverseGraph {
  const files = git("ls-files", "--cached", "--others", "--exclude-standard").filter((file) => inProject(file) && existsSync(file));
  const sources = new Map(files.filter((file) => /\.tsx?$/u.test(file)).map((file) => [file, readFileSync(file, "utf8")] as const));
  const known = new Set([...files, ...deleted]);
  return buildReverseGraph(sources, { known, aliases: aliasesFromPackageJson(JSON.parse(readFileSync("package.json", "utf8"))) });
}

/** Path prefixes of the suite's test paths (`src/`, `scenarios/src/`...), for the projects present in this checkout. */
function suiteTestRoots(): string[] {
  return PROJECTS.filter((project) => existsSync(project.dir)).map((project) => `${project.tests.slice(2)}/`);
}

/** `x.test.ts` beside each changed `x.ts` (a changed test is itself), inside the suite's test paths only: `check` runs no test CI does not. */
export function siblingTests(changedSources: readonly string[], testRoots: readonly string[]): string[] {
  return changedSources
    .map((file) => (file.includes(".test.") ? file : file.replace(/\.(tsx?)$/u, ".test.$1")))
    .filter((file) => testRoots.some((root) => file.startsWith(root)));
}

/** The tests loading the changed files through importers, printed with their origin; empty at depth 0. */
function importerTests(changed: readonly string[], graph: ReverseGraph, depth: number, testRoots: readonly string[]): string[] {
  if (depth === 0) return [];
  const reached = testsReachedBy(changed, graph, { depth, cap: IMPORTER_TEST_CAP, testRoots });
  for (const line of importerReport(reached, graph.unparsed)) console.log(line);
  return reached.tests.map((entry) => entry.file);
}

/**
 * The typecheck scripts to run, in project order: the projects holding a changed `.ts` file, then those importing a
 * changed file (`importing`: project dir -> one importer; owner 2026-10-21 Q1: a `src/` change can break `tests/` types).
 */
export function typecheckPlan(changedSources: readonly string[], importing: ReadonlyMap<string, string>): { script: string; reason: string }[] {
  return PROJECTS.flatMap((project) => {
    if (changedSources.some((file) => file.startsWith(project.dir))) return [{ script: project.typecheck, reason: "changed" }];
    const importer = importing.get(project.dir);
    return importer === undefined ? [] : [{ script: project.typecheck, reason: `${importer} imports a changed file` }];
  });
}

/** The suite's `bun test` call: every test path, then the arguments given after `--all` (`--coverage ...` in CI). */
export function suiteTestCommand(testPaths: readonly string[], extraArgs: readonly string[]): string[] {
  return ["bun", "test", ...testPaths, ...extraArgs];
}

/** `bun run test [-- <bun test args>]`: every typecheck, then every test path. */
function runAll(extraArgs: readonly string[]): never {
  const present = PROJECTS.filter((project) => existsSync(project.dir));
  for (const project of present) {
    if (!run(["bun", "run", "--silent", project.typecheck])) process.exit(1);
  }
  process.exit(run(suiteTestCommand(present.map((project) => project.tests), extraArgs)) ? 0 : 1);
}

function parsedArgsOrExit(): ReturnType<typeof parseCheckArgs> {
  try {
    return parseCheckArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

function main(): never {
  if (process.argv[2] === "--all") runAll(process.argv.slice(3));
  const args = parsedArgsOrExit();
  const base = args.base === undefined ? "HEAD" : git("merge-base", "HEAD", args.base)[0] ?? "HEAD";
  const changedAll = changedPaths(base);
  const changed = changedAll.filter((file) => /\.(ts|tsx)$/u.test(file) && existsSync(file));
  if (changedAll.length === 0) {
    console.log("check: no changed TypeScript file");
    process.exit(0);
  }
  const startedAt = performance.now();
  const graph = repositoryGraph(changedAll.filter((file) => !existsSync(file)));
  console.log(`check: import graph built in ${((performance.now() - startedAt) / 1000).toFixed(1)} s`);
  const testRoots = suiteTestRoots();
  const tests = [...new Set([...siblingTests(changed, testRoots), ...importerTests(changedAll, graph, args.depth, testRoots)])].filter(existsSync);
  const typechecks = typecheckPlan(changed, projectsImporting(changedAll, graph, PROJECTS.map((project) => project.dir)));
  let ok = true;
  for (const typecheck of typechecks) {
    if (typecheck.reason !== "changed") console.log(`check: ${typecheck.script}: ${typecheck.reason}`);
    ok = run(["bun", "run", "--silent", typecheck.script]) && ok;
  }
  if (tests.length > 0) ok = run(["bun", "test", ...tests.map((file) => `./${file}`)]) && ok;
  else console.log("check: no test file next to or importing the changed files (bun run test for everything)");
  console.log(`check: ${changedAll.length} changed file(s), ${tests.length} test file(s): ${ok ? "OK" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) main();
