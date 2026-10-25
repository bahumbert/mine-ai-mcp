/**
 * `bun scripts/coverage-summary.ts <lcov.info> <out.md>`: the coverage section of the PR report, from Bun's lcov file.
 * Totals are summed (lines run / lines loaded), unlike Bun's text "All files" row, which averages the per-file rates.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface Ratio {
  readonly hit: number;
  readonly found: number;
}

export interface CoverageSummary {
  readonly lines: Ratio;
  readonly functions: Ratio;
  readonly files: readonly { readonly path: string; readonly lines: Ratio }[];
}

export const NO_COVERAGE = "No coverage data.";

/** Files listed under the totals, lowest line rate first. */
const LOWEST_FILES_SHOWN = 10;

/** Sums the `LF/LH/FNF/FNH` counts of every `SF ... end_of_record` record (a missing count is 0). */
export function summarizeLcov(text: string): CoverageSummary {
  const files: { path: string; lines: Ratio }[] = [];
  const totals = { linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0 };
  let current: { path: string; counts: Map<string, number> } | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (line.startsWith("SF:")) current = { path: line.slice(3), counts: new Map() };
    else if (line === "end_of_record" && current !== undefined) {
      const count = (key: string) => current?.counts.get(key) ?? 0;
      files.push({ path: current.path, lines: { hit: count("LH"), found: count("LF") } });
      totals.linesHit += count("LH");
      totals.linesFound += count("LF");
      totals.functionsHit += count("FNH");
      totals.functionsFound += count("FNF");
      current = undefined;
    } else if (current !== undefined) {
      const match = /^(LF|LH|FNF|FNH):(\d+)$/u.exec(line);
      if (match !== null) current.counts.set(match[1]!, Number(match[2]));
    }
  }
  return { lines: { hit: totals.linesHit, found: totals.linesFound }, functions: { hit: totals.functionsHit, found: totals.functionsFound }, files };
}

function percent(ratio: Ratio): string {
  return ratio.found === 0 ? "-" : `${((ratio.hit / ratio.found) * 100).toFixed(1)} %`;
}

/** The markdown section: one totals row, the lowest-covered loaded files, and how the totals are counted. */
export function coverageMarkdown(summary: CoverageSummary): string {
  if (summary.files.length === 0) return NO_COVERAGE;
  const lowest = summary.files
    .filter((file) => file.lines.found > 0)
    .sort((a, b) => a.lines.hit / a.lines.found - b.lines.hit / b.lines.found || a.path.localeCompare(b.path))
    .slice(0, LOWEST_FILES_SHOWN);
  const ratio = (value: Ratio) => `${percent(value)} (${value.hit} / ${value.found})`;
  return [
    "| Lines | Functions | Files loaded |",
    "|---|---|---|",
    `| ${ratio(summary.lines)} | ${ratio(summary.functions)} | ${summary.files.length} |`,
    "",
    `Lowest line coverage (${lowest.length} files):`,
    "",
    "| File | Lines |",
    "|---|---|",
    ...lowest.map((file) => `| \`${file.path}\` | ${percent(file.lines)} |`),
    "",
    "Summed over the files a test loads (Bun); Bun's text 'All files' row is the unweighted mean of per-file rates, so it differs.",
  ].join("\n");
}

/** Writes the section for `lcovPath` to `outPath`; a missing file gives the no-data line (the suite never ran). */
export function writeCoverageSummary(lcovPath: string, outPath: string): void {
  const text = existsSync(lcovPath) ? readFileSync(lcovPath, "utf8") : "";
  writeFileSync(outPath, `${coverageMarkdown(summarizeLcov(text))}\n`);
}

if (import.meta.main) {
  const [lcovPath, outPath] = process.argv.slice(2);
  if (lcovPath === undefined || outPath === undefined) {
    console.error("usage: bun scripts/coverage-summary.ts <lcov.info> <out.md>");
    process.exit(1);
  }
  writeCoverageSummary(lcovPath, outPath);
}
