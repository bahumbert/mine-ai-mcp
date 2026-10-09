import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BRAIN_LOG_FILE, BrainLog, PREVIOUS_BRAIN_LOG_FILE } from "./brain-log.ts";

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("the brain log appends numbered events; a new run keeps only the previous run's log", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-log-"));
  const path = join(dir, BRAIN_LOG_FILE);
  writeFileSync(path, "{\"seq\":1}\n");
  const log = new BrainLog(path);
  log.write({ kind: "progress", objective: "get 2 dirt", fact: "gathering 2 dirt for getting 2 dirt", asked: false }, new Date("2026-10-02T18:00:00Z"));
  log.write({ kind: "state", stack: [], step: null });
  const [first, second] = lines(path);
  assert.deepEqual(first, { seq: 1, at: "2026-10-02T18:00:00.000Z", kind: "progress", objective: "get 2 dirt", fact: "gathering 2 dirt for getting 2 dirt", asked: false });
  assert.equal(second?.seq, 2);
  assert.deepEqual(lines(join(dir, PREVIOUS_BRAIN_LOG_FILE)), [{ seq: 1 }]);
});

test("past its size cap the log starts again, the full one kept as the previous log", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-log-"));
  const log = new BrainLog(join(dir, BRAIN_LOG_FILE), 300);
  for (let index = 0; index < 5; index += 1) log.write({ kind: "state", stack: [{ text: `objective ${index}`, requester: null }], step: null });
  assert.ok(lines(join(dir, BRAIN_LOG_FILE)).length < 5);
  assert.ok(lines(join(dir, PREVIOUS_BRAIN_LOG_FILE)).length > 0);
  assert.equal(lines(join(dir, BRAIN_LOG_FILE)).at(-1)?.seq, 5);
});
