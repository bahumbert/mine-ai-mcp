import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitProgram, importerReport, missingGitMessage, parseCheckArgs, siblingTests, suiteTestCommand, typecheckPlan } from "./check.js";
import { IMPORTER_DEPTH, IMPORTER_TEST_CAP } from "./import-graph.js";

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
