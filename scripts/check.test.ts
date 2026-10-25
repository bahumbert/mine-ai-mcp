import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProgram, importerReport, missingGitMessage, parseCheckArgs, siblingTests, suiteTestCommand, typecheckPlan } from "./check.js";
import { dataReadReport, malformedReport, planDataReads, unmatchedReport } from "./data-readers.js";
import { aliasesFromPackageJson, buildReverseGraph, IMPORTER_DEPTH, IMPORTER_TEST_CAP, testsReachedBy } from "./import-graph.js";

function checkout(layout: "directory" | "file" | "none", content = ""): string {
  const root = mkdtempSync(join(tmpdir(), "check-git-"));
  if (layout === "directory") mkdirSync(join(root, ".git"));
  if (layout === "file") writeFileSync(join(root, ".git"), content);
  return root;
}

test("main checkout (.git directory) uses plain git", () => {
  expect(gitProgram(checkout("directory"))).toBe("git");
});

test("worktree whose .git file holds a Windows gitdir uses git.exe", () => {
  const root = checkout("file", "gitdir: D:/minecraft/mcp/mine-ai-mcp/.git/worktrees/x\n");
  expect(gitProgram(root)).toBe("git.exe");
});

test("Windows gitdir with backslashes and CRLF uses git.exe", () => {
  const root = checkout("file", "gitdir: D:\\repo\\.git\\worktrees\\x\r\n");
  expect(gitProgram(root)).toBe("git.exe");
});

test("worktree with a POSIX gitdir keeps plain git", () => {
  const root = checkout("file", "gitdir: /mnt/d/repo/.git/worktrees/x\n");
  expect(gitProgram(root)).toBe("git");
});

test("no .git at all keeps plain git", () => {
  expect(gitProgram(checkout("none"))).toBe("git");
});

test("missing git.exe gives a clear message, not an empty change list", () => {
  expect(missingGitMessage("git.exe")).toContain("git.exe");
  expect(missingGitMessage("git.exe")).toContain("Windows gitdir");
});

test("check arguments: a base, --depth, both, none", () => {
  expect(parseCheckArgs([])).toEqual({ base: undefined, depth: IMPORTER_DEPTH });
  expect(parseCheckArgs(["origin/main"])).toEqual({ base: "origin/main", depth: IMPORTER_DEPTH });
  expect(parseCheckArgs(["--depth", "0"])).toEqual({ base: undefined, depth: 0 });
  expect(parseCheckArgs(["HEAD~1", "--depth", "3"])).toEqual({ base: "HEAD~1", depth: 3 });
});

test("a --depth that is not a whole number is refused", () => {
  expect(() => parseCheckArgs(["--depth", "two"])).toThrow("--depth");
  expect(() => parseCheckArgs(["--depth"])).toThrow("--depth");
});

test("the importer summary counts direct, deeper and dropped tests and names each origin", () => {
  const lines = importerReport(
    {
      tests: [
        { file: "src/a.test.ts", depth: 1, from: "src/a.ts" },
        { file: "src/m.test.ts", depth: 2, from: "src/a.ts" },
      ],
      dropped: 3,
      depthOneOverCap: false,
      outsideSuite: ["scenarios/flat/x.test.ts"],
    },
    ["src/broken.ts"],
  );
  expect(lines[0]).toBe(
    `check: importers: 2 test file(s) (1 changed or direct, 1 at depth 2 or more, 3 dropped over the cap of ${IMPORTER_TEST_CAP}: bun run test for all)`,
  );
  expect(lines).toContain("  src/m.test.ts <- src/a.ts (2)");
  expect(lines).toContain("check: scenarios/flat/x.test.ts is reached but outside bun run test: not run");
  expect(lines).toContain("check: cannot parse src/broken.ts: its imports are not followed");
});

test("direct tests alone over the cap are named in the summary", () => {
  const tests = Array.from({ length: 2 }, (_, i) => ({ file: `src/t${i}.test.ts`, depth: 1, from: "src/a.ts" }));
  const lines = importerReport({ tests, dropped: 4, depthOneOverCap: true, outsideSuite: [] }, []);
  expect(lines).toContain(`check: depths 0 and 1 alone are 2 test files, over the cap of ${IMPORTER_TEST_CAP}`);
});

test("bun run test passes the arguments after --all to bun test only", () => {
  expect(suiteTestCommand(["./src", "./brain"], [])).toEqual(["bun", "test", "./src", "./brain"]);
  expect(suiteTestCommand(["./src"], ["--coverage", "--coverage-dir=coverage"])).toEqual(["bun", "test", "./src", "--coverage", "--coverage-dir=coverage"]);
});

test("typechecks the projects with changed files and those importing them, each once, in project order", () => {
  const plan = typecheckPlan(["src/a.ts", "src/b.ts"], new Map([["tests/", "tests/x.ts"], ["src/", "src/c.ts"], ["scenarios/", "scenarios/src/s.ts"]]));
  expect(plan).toEqual([
    { script: "typecheck", reason: "changed" },
    { script: "typecheck:scenarios", reason: "scenarios/src/s.ts imports a changed file" },
    { script: "typecheck:tests", reason: "tests/x.ts imports a changed file" },
  ]);
});

test("a scripts/ change typechecks scripts/ (Bun types)", () => {
  expect(typecheckPlan(["scripts/check.ts"], new Map())).toEqual([{ script: "typecheck:scripts", reason: "changed" }]);
});

test("the test beside a changed file runs only inside the suite's test paths", () => {
  expect(siblingTests(["src/a.ts", "src/b.test.ts", "scenarios/flat/combat/reflex.ts", "scenarios/flat/x.test.ts"], ["src/", "scenarios/src/"])).toEqual([
    "src/a.test.ts",
    "src/b.test.ts",
  ]);
});

test("config changes and source changes together typecheck the union, each once, a source change keeping its own reason", () => {
  const configs = new Map([["scenarios/", "tests/tsconfig.json changed (scenarios/tsconfig.json extends it)"], ["tests/", "tests/tsconfig.json changed"]]);
  const plan = typecheckPlan(["src/a.ts", "tests/x.ts"], new Map([["brain/", "brain/b.ts"]]), configs);
  expect(plan).toEqual([
    { script: "typecheck", reason: "changed" },
    { script: "typecheck:scenarios", reason: "tests/tsconfig.json changed (scenarios/tsconfig.json extends it)" },
    { script: "typecheck:tests", reason: "changed" },
    { script: "typecheck:brain", reason: "brain/b.ts imports a changed file" },
  ]);
});

test("a config-only change typechecks the projects it selects with no source file", () => {
  const plan = typecheckPlan([], new Map(), new Map([["tests/", "bun.lock changed"]]));
  expect(plan).toEqual([{ script: "typecheck:tests", reason: "bun.lock changed" }]);
});

// The declaration marker is built here so no line of this file starts with it: the scan of the suite's sources would read it.
const MARK = "// check-reads:";
const SCENARIO_GLOB = "tests/minecraft/scenarios/**/*.yaml";

/** An in-memory tree: the plan of what a change selects, then the tests the import graph reaches from the plan's starts. */
function dataReadTree(sources: Record<string, string>, extraFiles: readonly string[], changed: readonly string[], options: { cap?: number } = {}) {
  const map = new Map(Object.entries(sources));
  const files = [...map.keys(), ...extraFiles];
  const plan = planDataReads(changed, map, files);
  const graph = buildReverseGraph(map, { known: new Set([...files, ...changed]), aliases: aliasesFromPackageJson({}) });
  const reached = testsReachedBy(plan.starts, graph, { depth: IMPORTER_DEPTH, cap: options.cap ?? IMPORTER_TEST_CAP, testRoots: ["tests/"] });
  return { plan, reached };
}

const READER_TREE = {
  "tests/minecraft/arena/all-scenarios.ts": `${MARK} ${SCENARIO_GLOB}\nexport const all = 1;\n`,
  "tests/minecraft/arena/shift.test.ts": `import { all } from "./all-scenarios.ts";\nconsole.log(all);\n`,
  "tests/minecraft/arena/census.test.ts": `import { all } from "./all-scenarios.ts";\nconsole.log(all);\n`,
  "tests/minecraft/other.test.ts": `export const other = 1;\n`,
};
const YAML = "tests/minecraft/scenarios/air/breathe.yaml";

test("a changed or deleted scenario YAML runs the tests importing the file that reads it, and names the data file and its reader", () => {
  for (const existing of [[YAML], []]) {
    const { plan, reached } = dataReadTree(READER_TREE, existing, [YAML]);
    expect(plan.reads).toEqual([{ data: YAML, reader: "tests/minecraft/arena/all-scenarios.ts" }]);
    expect(reached.tests.map((entry) => entry.file)).toEqual(["tests/minecraft/arena/census.test.ts", "tests/minecraft/arena/shift.test.ts"]);
    expect(dataReadReport(plan.reads)).toEqual([`  ${YAML} via tests/minecraft/arena/all-scenarios.ts`]);
  }
});

test("a changed file no declared glob matches selects nothing", () => {
  const { plan, reached } = dataReadTree(READER_TREE, ["docs/notes.md", "tests/minecraft/contract/scenarios/x.yaml"], ["docs/notes.md", "tests/minecraft/contract/scenarios/x.yaml"]);
  expect(plan.reads).toEqual([]);
  expect(plan.starts).toEqual([]);
  expect(reached.tests).toEqual([]);
});

test("two readers matching one file are both started and both named", () => {
  const sources = { ...READER_TREE, "tests/minecraft/lanes.ts": `${MARK} tests/minecraft/**/*.yaml\n`, "tests/minecraft/lanes.test.ts": `import "./lanes.ts";\n` };
  const { plan, reached } = dataReadTree(sources, [YAML], [YAML]);
  expect(plan.reads.map((read) => read.reader)).toEqual(["tests/minecraft/arena/all-scenarios.ts", "tests/minecraft/lanes.ts"]);
  expect(plan.starts).toEqual(["tests/minecraft/arena/all-scenarios.ts", "tests/minecraft/lanes.ts"]);
  expect(reached.tests.map((entry) => entry.file)).toContain("tests/minecraft/lanes.test.ts");
});

test("a declaration in a test file selects that test itself", () => {
  const sources = { "tests/minecraft/contract/setup.test.ts": `import "x";\n${MARK} tests/minecraft/contract/scenarios/*.yaml\n` };
  const changed = ["tests/minecraft/contract/scenarios/a.yaml"];
  const { reached } = dataReadTree(sources, changed, changed);
  expect(reached.tests).toEqual([{ file: "tests/minecraft/contract/setup.test.ts", depth: 0, from: "tests/minecraft/contract/setup.test.ts" }]);
});

test("a glob lists several globs, matches any depth with ** and one segment with *", () => {
  const sources = { "tests/r.ts": `${MARK} data/*.json, deep/**/*.yaml\n` };
  const reads = (changed: string[]) => planDataReads(changed, new Map(Object.entries(sources)), changed).reads.length;
  expect(reads(["data/a.json"])).toBe(1);
  expect(reads(["data/sub/a.json"])).toBe(0);
  expect(reads(["deep/a.yaml"])).toBe(1);
  expect(reads(["deep/x/y/a.yaml"])).toBe(1);
  expect(reads(["deep/a.yaml.bak"])).toBe(0);
});

test("a malformed declaration is reported with its file and line, and its globs are not used", () => {
  const sources = new Map([
    ["tests/a.ts", `export {};\n${MARK}\n`],
    ["tests/b.ts", `${MARK} data/*.yaml data/b.yaml\n`],
    ["tests/c.ts", `${MARK} /etc/passwd\n`],
    ["tests/d.ts", `${MARK} ../x/*.yaml\n`],
    ["tests/e.ts", `${MARK} data/a.yaml,, data/b.yaml\n`],
  ]);
  const plan = planDataReads(["data/a.yaml", "data/b.yaml"], sources, ["data/a.yaml", "data/b.yaml"]);
  expect(plan.malformed.map((entry) => `${entry.file}:${entry.line}`)).toEqual(["tests/a.ts:2", "tests/b.ts:1", "tests/c.ts:1", "tests/d.ts:1", "tests/e.ts:1"]);
  expect(plan.reads).toEqual([]);
  expect(malformedReport(plan.malformed)[0]).toContain("tests/a.ts:2");
});

test("the marker inside code or after other text is not a declaration", () => {
  const sources = new Map([["tests/a.ts", `const text = "${MARK} data/*.yaml";\nfoo(); ${MARK} data/*.yaml\n`]]);
  const plan = planDataReads(["data/a.yaml"], sources, ["data/a.yaml"]);
  expect(plan).toMatchObject({ reads: [], malformed: [] });
});

test("a well-formed glob matching no file is listed as stale, a glob matching a deleted path is not", () => {
  const sources = new Map([["tests/a.ts", `${MARK} gone/*.yaml, there/*.yaml\n`]]);
  const plan = planDataReads(["there/x.yaml"], sources, ["tests/a.ts"]);
  expect(plan.unmatched).toEqual([{ reader: "tests/a.ts", glob: "gone/*.yaml" }]);
  expect(unmatchedReport(plan.unmatched)[0]).toContain("gone/*.yaml");
  expect(planDataReads([], sources, ["gone/a.yaml", "there/b.yaml"]).unmatched).toEqual([]);
});

test("the tests a data file reaches count against the cap like any importer's", () => {
  const sources: Record<string, string> = { "tests/lib.ts": `${MARK} data/*.yaml\n`, "tests/mid.ts": `import "./lib.ts";\n` };
  for (const name of ["a", "b", "c"]) sources[`tests/${name}.test.ts`] = `import "./mid.ts";\n`;
  sources["tests/direct.test.ts"] = `import "./lib.ts";\n`;
  const { reached } = dataReadTree(sources, ["data/x.yaml"], ["data/x.yaml"], { cap: 2 });
  expect(reached.tests.map((entry) => entry.file)).toEqual(["tests/direct.test.ts"]);
  expect(reached.dropped).toBe(3);
});

test("a near-miss of the marker is reported, not ignored", () => {
  for (const line of ["//check-reads: data/*.yaml", "// check-reads : data/*.yaml", "//  check-reads: data/*.yaml", "/* check-reads: data/*.yaml */"]) {
    const plan = planDataReads(["data/a.yaml"], new Map([["tests/r.ts", `${line}\n`]]), ["data/a.yaml"]);
    expect({ line, reads: plan.reads.length, malformed: plan.malformed.length }).toEqual({ line, reads: 0, malformed: 1 });
  }
});

test("the next step is named in what check prints about a stale or malformed declaration", () => {
  expect(unmatchedReport([{ reader: "tests/a.ts", glob: "gone/*.yaml" }])[0]).toContain("fix or remove");
  expect(malformedReport([{ file: "tests/a.ts", line: 2, reason: "empty glob", text: "x" }])[0]).toContain("fix or remove");
});
