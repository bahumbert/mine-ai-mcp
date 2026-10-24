// The scenario files the docs name exist: a move or a rename of a YAML is caught here, not by a reader who copies a command that does not run.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));

/** `tests/minecraft/<...>.yaml`, written out in full (a pattern with `<name>` or `*` names no file). */
const FULL_PATH = /tests\/minecraft\/[A-Za-z0-9_./-]+\.yaml/gu;
/** The README sits in tests/minecraft: it also writes a path from there (`scenarios/craft/workshop.yaml`). */
const README_RELATIVE_PATH = /(?<![A-Za-z0-9_./-])(?:scenarios|templates|contract)\/[A-Za-z0-9_./-]+\.yaml/gu;

function yamlPathsIn(text: string, patterns: readonly RegExp[]): string[] {
  const found = patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[0]));
  return [...new Set(found.map(path => (path.startsWith("tests/minecraft/") ? path : `tests/minecraft/${path}`)))];
}

function missingFrom(text: string, patterns: readonly RegExp[]): { readonly found: number; readonly missing: string[] } {
  const paths = yamlPathsIn(text, patterns);
  return { found: paths.length, missing: paths.filter(path => !existsSync(join(REPO, path))) };
}

test("every scenario path tests/minecraft/README.md names exists", () => {
  const { found, missing } = missingFrom(readFileSync(join(REPO, "tests/minecraft/README.md"), "utf8"), [FULL_PATH, README_RELATIVE_PATH]);
  assert.ok(found >= 5, `the README names ${found} scenario paths: the pattern stopped matching`);
  assert.deepEqual(missing, [], "README paths with no file");
});

const KNOWLEDGE = join(REPO, ".agent/knowledge/05-testing-and-ops.md");

// CI checks out the public repository, which has no .agent: the file is checked wherever it is present.
test("every scenario path .agent/knowledge/05-testing-and-ops.md names exists", { skip: existsSync(KNOWLEDGE) ? false : ".agent is not in this checkout (the public repository has none)" }, () => {
  const { found, missing } = missingFrom(readFileSync(KNOWLEDGE, "utf8"), [FULL_PATH]);
  assert.ok(found >= 1, `05-testing-and-ops.md names ${found} scenario paths: the pattern stopped matching`);
  assert.deepEqual(missing, [], "05-testing-and-ops.md paths with no file");
});

test("a path that is not a file is reported, a pattern with <name> or * is not read as a path", () => {
  const text = "run tests/minecraft/scenarios/collect/no-such-scenario.yaml, not tests/minecraft/scenarios/<behavior>/*.yaml or scenarios/craft/<name>.yaml";
  assert.deepEqual(missingFrom(text, [FULL_PATH, README_RELATIVE_PATH]), { found: 1, missing: ["tests/minecraft/scenarios/collect/no-such-scenario.yaml"] });
});
