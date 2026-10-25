import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coverageMarkdown, NO_COVERAGE, summarizeLcov, writeCoverageSummary } from "./coverage-summary.js";

/** Records in the shape Bun 1.4.2 writes (`bun test --coverage-reporter=lcov`, 2026-10-21): FNF/FNH, no FN/FNDA lines. */
function record(path: string, lines: { found: number; hit: number }, functions?: { found: number; hit: number }): string {
  const fn = functions === undefined ? [] : [`FNF:${functions.found}`, `FNH:${functions.hit}`];
  return ["TN:", `SF:${path}`, ...fn, "DA:7,61", "DA:75,0", `LF:${lines.found}`, `LH:${lines.hit}`, "end_of_record"].join("\n");
}

/** Three whole records of a local run (`bun test ./scripts ./src/world --coverage`, Bun 1.4.2, 2026-10-21). */
const REAL = `TN:
SF:src/world/air-supply.ts
FNF:1
FNH:0
DA:4,0
DA:5,0
DA:6,0
LF:3
LH:0
end_of_record
TN:
SF:src/world/inventory-capacity.ts
FNF:2
FNH:2
DA:4,31
DA:5,7
DA:6,34
DA:7,87
LF:4
LH:4
end_of_record
TN:
SF:src/world/workstations.ts
FNF:1
FNH:1
DA:9,49
DA:12,41
LF:2
LH:2
end_of_record
`;

test("real Bun records give totals and per-file rates", () => {
  const summary = summarizeLcov(REAL);
  expect(summary.lines).toEqual({ hit: 6, found: 9 });
  expect(summary.functions).toEqual({ hit: 3, found: 4 });
  expect(summary.files.map((file) => file.path)).toEqual(["src/world/air-supply.ts", "src/world/inventory-capacity.ts", "src/world/workstations.ts"]);
});

test("totals are summed over records, not averaged: 3/5 and 1/11 give 25.0 %", () => {
  const markdown = coverageMarkdown(summarizeLcov([record("a.ts", { found: 5, hit: 3 }), record("b.ts", { found: 11, hit: 1 })].join("\n")));
  expect(markdown).toContain("| 25.0 % (4 / 16) |");
});

test("a file with no lines is left out of the lowest list", () => {
  const summary = summarizeLcov([record("types.ts", { found: 0, hit: 0 }), record("a.ts", { found: 4, hit: 1 })].join("\n"));
  expect(coverageMarkdown(summary)).not.toContain("types.ts");
  expect(coverageMarkdown(summary)).toContain("| `a.ts` | 25.0 % |");
});

test("a record without FNF counts no functions", () => {
  const summary = summarizeLcov([record("a.ts", { found: 2, hit: 2 }), record("b.ts", { found: 2, hit: 1 }, { found: 4, hit: 3 })].join("\n"));
  expect(summary.functions).toEqual({ hit: 3, found: 4 });
});

test("the ten lowest files are listed, lowest first", () => {
  const records = Array.from({ length: 12 }, (_, i) => record(`f${i}.ts`, { found: 12, hit: i }));
  const markdown = coverageMarkdown(summarizeLcov(records.join("\n")));
  expect(markdown).toContain("| `f0.ts` | 0.0 % |");
  expect(markdown).toContain("| `f9.ts` | 75.0 % |");
  expect(markdown).not.toContain("f10.ts");
  expect(markdown.indexOf("f0.ts")).toBeLessThan(markdown.indexOf("f1.ts"));
});

test("percentages are rounded to one decimal: 2/3 gives 66.7", () => {
  expect(coverageMarkdown(summarizeLcov(record("a.ts", { found: 3, hit: 2 }, { found: 3, hit: 2 })))).toContain("| 66.7 % (2 / 3) | 66.7 % (2 / 3) |");
});

test("a path with spaces is kept whole", () => {
  expect(summarizeLcov(record("src/my dir/a b.ts", { found: 1, hit: 1 })).files[0]?.path).toBe("src/my dir/a b.ts");
});

test("the summary says how it differs from Bun's text row", () => {
  expect(coverageMarkdown(summarizeLcov(REAL))).toContain("unweighted mean");
});

test("empty input says there is no coverage data", () => {
  expect(coverageMarkdown(summarizeLcov(""))).toBe(NO_COVERAGE);
});

test("a missing lcov file writes the no-data line", () => {
  const dir = mkdtempSync(join(tmpdir(), "coverage-summary-"));
  const out = join(dir, "summary.md");
  writeCoverageSummary(join(dir, "missing.info"), out);
  expect(readFileSync(out, "utf8").trim()).toBe(NO_COVERAGE);
});
