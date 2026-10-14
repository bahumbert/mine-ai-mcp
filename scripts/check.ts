/**
 * `bun run check`: the quick loop. Typechecks only the projects with changed files and runs only the tests next to
 * them (`x.ts` → `x.test.ts`): uncommitted work by default, `bun run check origin/main` for the whole branch.
 * `bun run test` (`--all`): every project present in this checkout (the monitor is not in every one).
 */
import { existsSync } from "node:fs";

const PROJECTS: readonly { readonly dir: string; readonly typecheck: string; readonly tests: string }[] = [
  { dir: "src/", typecheck: "typecheck", tests: "./src" },
  { dir: "scenarios/", typecheck: "typecheck:scenarios", tests: "./scenarios/src" },
  { dir: "tests/", typecheck: "typecheck:tests", tests: "./tests" },
  { dir: "brain/", typecheck: "typecheck:brain", tests: "./brain" },
  { dir: "monitor/", typecheck: "typecheck:monitor", tests: "./monitor" },
];

function git(...args: string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
  return result.success ? result.stdout.toString().split("\n").filter((line) => line.length > 0) : [];
}

function run(command: string[]): boolean {
  console.log(`$ ${command.join(" ")}`);
  return Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }).success;
}

if (process.argv[2] === "--all") {
  const present = PROJECTS.filter((project) => existsSync(project.dir));
  for (const project of present) {
    if (!run(["bun", "run", "--silent", project.typecheck])) process.exit(1);
  }
  process.exit(run(["bun", "test", ...present.map((project) => project.tests)]) ? 0 : 1);
}

const base = process.argv[2] === undefined ? "HEAD" : git("merge-base", "HEAD", process.argv[2])[0] ?? "HEAD";
const changed = [...new Set([...git("diff", "--name-only", base), ...git("ls-files", "--others", "--exclude-standard")])]
  .filter((file) => /\.(ts|tsx)$/u.test(file) && existsSync(file));
if (changed.length === 0) {
  console.log("check: no changed TypeScript file");
  process.exit(0);
}
const tests = [...new Set(changed.map((file) => (file.includes(".test.") ? file : file.replace(/\.(tsx?)$/u, ".test.$1"))).filter(existsSync))];
let ok = true;
for (const project of PROJECTS.filter((project) => changed.some((file) => file.startsWith(project.dir)))) {
  ok = run(["bun", "run", "--silent", project.typecheck]) && ok;
}
if (tests.length > 0) ok = run(["bun", "test", ...tests.map((file) => `./${file}`)]) && ok;
else console.log("check: no test file next to the changed files (bun run test for everything)");
console.log(`check: ${changed.length} changed file(s), ${tests.length} test file(s): ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
