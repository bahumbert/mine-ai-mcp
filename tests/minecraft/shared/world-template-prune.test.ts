// What the daemon deletes from the template store (spec 2026-10-30-scenario-clients-ext4 D11 "Prune"): the build leftovers of dead processes and templates unused for a week.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTemplates, TEMPLATE_UNUSED_MAX_AGE_MS } from "./world-template-prune.ts";

const NOW_MS = Date.parse("2026-10-31T12:00:00Z");
const DAY_MS = 86_400_000;

function withStore(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "template-prune-"));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function setTime(path: string, ageMs: number): void {
  utimesSync(path, (NOW_MS - ageMs) / 1000, (NOW_MS - ageMs) / 1000);
}

/** A finished template; `usedAgoMs` ages its `.last-used`, `builtAgoMs` its `template.json` (what a template nobody copied yet is judged by). */
function makeTemplate(dir: string, key: string, options: { usedAgoMs?: number; builtAgoMs?: number } = {}): string {
  const template = join(dir, key);
  mkdirSync(join(template, "region"), { recursive: true });
  writeFileSync(join(template, "region", "r.0.0.mca"), "x");
  writeFileSync(join(template, "template.json"), "{}\n");
  setTime(join(template, "template.json"), options.builtAgoMs ?? 0);
  if (options.usedAgoMs !== undefined) {
    writeFileSync(join(template, ".last-used"), "");
    setTime(join(template, ".last-used"), options.usedAgoMs);
  }
  return template;
}

const ports = (alive: readonly number[]) => ({ pidAlive: (pid: number) => alive.includes(pid), now: () => NOW_MS });

test("a build leftover of a dead process goes, one of a live process stays (tmp of a key, a build server's root, a probe root); tmpsOnly leaves every template, whatever its age", () => withStore(dir => {
  for (const name of ["abc.tmp-100", "build.tmp-100", "probe.tmp-100", "abc.tmp-200"]) mkdirSync(join(dir, name));
  makeTemplate(dir, "old", { usedAgoMs: 30 * DAY_MS });
  const removed = pruneTemplates(dir, new Set(), { tmpsOnly: true }, ports([200]));
  assert.deepEqual(removed.sort(), ["abc.tmp-100", "build.tmp-100", "probe.tmp-100"]);
  assert.equal(existsSync(join(dir, "abc.tmp-200")), true);
  assert.equal(existsSync(join(dir, "old")), true);
}));

test("a template that is not a current key and unused for more than 7 days goes (by its .last-used, else by its template.json); a current key stays however old", () => withStore(dir => {
  makeTemplate(dir, "stale", { usedAgoMs: TEMPLATE_UNUSED_MAX_AGE_MS + DAY_MS });
  makeTemplate(dir, "current", { usedAgoMs: 30 * DAY_MS });
  makeTemplate(dir, "recent", { usedAgoMs: DAY_MS });
  makeTemplate(dir, "built-long-ago", { builtAgoMs: 9 * DAY_MS });
  makeTemplate(dir, "built-today", { builtAgoMs: 1000 });
  assert.deepEqual(pruneTemplates(dir, new Set(["current"]), {}, ports([])).sort(), ["built-long-ago", "stale"]);
  assert.deepEqual(["stale", "current", "recent", "built-long-ago", "built-today"].map(name => existsSync(join(dir, name))), [false, true, true, false, true]);
}));

test("a directory without template.json is a build that did not finish: it is not judged by age, only a dead pid's tmp is removed", () => withStore(dir => {
  mkdirSync(join(dir, "half"));
  setTime(join(dir, "half"), 30 * DAY_MS);
  assert.deepEqual(pruneTemplates(dir, new Set(), {}, ports([])), []);
}));

test("a missing store is no error", () => {
  assert.deepEqual(pruneTemplates("/tmp/no-such-template-store-p3b", new Set(), {}, ports([])), []);
});
