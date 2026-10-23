import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenarioFiles } from "./scenario-files.ts";

const CONTRACT_DIR = fileURLToPath(new URL("../contract/scenarios", import.meta.url));
const ONE_FILE = join(CONTRACT_DIR, "air-supply-under-water.yaml");

test("a directory loads every YAML in it, sorted, with ids relative to the directory", async () => {
  const { scenarios, errors } = await loadScenarioFiles([CONTRACT_DIR]);
  assert.deepEqual(errors, []);
  assert.ok(scenarios.length >= 12, `${scenarios.length} contract scenarios`);
  assert.equal(scenarios.find(entry => entry.id === "air-supply-under-water")?.scenario.name, "contract-air-supply-under-water");
  assert.deepEqual(scenarios.map(entry => entry.id), [...scenarios.map(entry => entry.id)].sort((a, b) => a.localeCompare(b)));
});

test("a single file keeps its basename as id", async () => {
  const { scenarios } = await loadScenarioFiles([ONE_FILE]);
  assert.deepEqual(scenarios.map(entry => entry.id), ["air-supply-under-water"]);
});

test("several inputs prefix each id with the input's number, as Mine Labs does", async () => {
  const { scenarios } = await loadScenarioFiles([ONE_FILE, ONE_FILE]);
  assert.deepEqual(scenarios.map(entry => entry.id), ["1/air-supply-under-water"], "the same file twice loads once");
});

test("a YAML that fails to load is one error and the others still load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scenario-files-"));
  try {
    const broken = join(dir, "broken.yaml");
    await writeFile(broken, "name: [unterminated\n");
    const { scenarios, errors } = await loadScenarioFiles([broken, ONE_FILE]);
    assert.equal(scenarios.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /broken\.yaml/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a path that does not exist is an error, not a throw", async () => {
  const { scenarios, errors } = await loadScenarioFiles([resolve("/nonexistent/path.yaml")]);
  assert.deepEqual(scenarios, []);
  assert.match(errors[0] ?? "", /nonexistent/u);
});
