// The Inno Setup script (packaging/windows/mine-ai.iss) read through its #includes: the structure checks. The real ISCC compile is
// in iss-compile-real.serial.test.ts (a serial test, left out of `bun run test:fast`).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { issIncludes, issPath, repoRoot } from "./iss-test-support.ts";

test("launcher tests do not read the unexpanded installer script by path", () => {
  const source = join(repoRoot, "launcher", "src");
  const tests = readdirSync(source, { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".test.ts"));
  const rawReads = tests.filter((name) => /(?:readFileSync|Bun\.file)\s*\([^;]*?["'`][^"'`]*mine-ai\.iss["'`]/su.test(readFileSync(join(source, name), "utf8")));
  assert.deepEqual(rawReads, [], "read the script through iss-test-support so includes are visible");
});

test("every #include of the script names a file next to it, and each included file starts with a comment saying what it holds", () => {
  const includes = issIncludes();
  assert.deepEqual(includes.filter((include) => !include.exists).map((include) => include.name), [], "an #include names a file that does not exist (ISCC would stop there)");
  for (const include of includes) {
    const first = readFileSync(include.path, "utf8").split(/\r?\n/u).find((line) => line.trim() !== "");
    assert.match(first ?? "", /^\/\/ \S/u, `${include.name} starts with no header comment`);
  }
});

test("the endpoint page's code is in endpoint-page.iss, pulled in by the script, and the script itself no longer holds it", () => {
  const includes = issIncludes();
  const endpoint = includes.find((include) => include.name === "endpoint-page.iss");
  assert.ok(endpoint, "mine-ai.iss has no #include \"endpoint-page.iss\"");
  const own = readFileSync(endpoint.path, "utf8");
  const script = readFileSync(issPath, "utf8");
  for (const name of ["CreateEndpointPage", "ListModels", "ApplyEndpointCorrection", "RemoteKeyChanged", "ListKeyArguments", "RemoteLlmArguments"]) {
    assert.match(own, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is not in endpoint-page.iss`);
    assert.doesNotMatch(script, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is still in mine-ai.iss`);
  }
  // The include is inside [Code]: the expanded script holds the functions after its [Code] line.
  assert.ok(script.indexOf('#include "endpoint-page.iss"') > script.indexOf("[Code]"));
});
