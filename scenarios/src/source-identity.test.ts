// Exercise source retention from a mirror with no Git metadata or executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

test("source identity retains hashes and sources with a supplied HEAD or no HEAD, without Git", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "source-identity-"));
  try {
    await mkdir(path.join(root, "scenarios", "src"), { recursive: true });
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "artifacts"));
    await writeFile(path.join(root, "src", "sample.ts"), "export {};\n");
    await cp(new URL("./source-identity.ts", import.meta.url), path.join(root, "scenarios", "src", "source-identity.ts"));
    for (const head of ["1234567890abcdef", ""]) {
      const result = spawnSync(process.execPath, ["-e", 'import { recordSourceIdentity } from "./scenarios/src/source-identity.ts"; await recordSourceIdentity();'], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, PATH: "", MINE_LABS_ARTIFACTS_DIR: path.join(root, "artifacts"), MINE_AI_SOURCE_HEAD: head },
      });
      assert.equal(result.status, 0, result.stderr);
      const identity = JSON.parse(await readFile(path.join(root, "artifacts", "qualification-source.json"), "utf8"));
      const retained = JSON.parse(gunzipSync(await readFile(path.join(root, "artifacts", "qualification-source.json.gz"))).toString());
      assert.equal(identity.head, head || null);
      assert.equal(retained.head, identity.head);
      assert.deepEqual(identity.files.find((file: { path: string }) => file.path === "src/sample.ts"), {
        path: "src/sample.ts", sha256: "8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881",
      });
      assert.equal(retained.files.find((file: { path: string }) => file.path === "src/sample.ts").source, "export {};\n");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
