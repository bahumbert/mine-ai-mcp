import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { installLshwStub, pathWithStubFirst, putLshwStubOnPath } from "./lshw-stub.ts";

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "lshw-stub-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// The stub is a POSIX sh script for the WSL servers: Windows has neither `sh` as a command nor `lshw`.
test("the stub lshw is an executable that exits 1 at once, so the server's hardware probe gives up instead of hanging; installing it again changes nothing", { skip: process.platform === "win32" }, async () => {
  await inTempDir(async dir => {
    const stubDir = await installLshwStub(dir);
    const text = await readFile(join(stubDir, "lshw"), "utf8");
    assert.equal(await installLshwStub(dir), stubDir, "a daemon restart, or start-server.sh, wrote it before");
    assert.equal(await readFile(join(stubDir, "lshw"), "utf8"), text);
    assert.ok(((await stat(join(stubDir, "lshw"))).mode & 0o111) !== 0, "lshw must be executable");
    const result = spawnSync("lshw", ["-class", "processor"], { env: { PATH: stubDir }, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  });
});

test("the stub directory goes first on PATH once; a missing or empty PATH becomes the stub directory alone, never an empty entry that means the current directory", () => {
  const first = `/tmp/stubs${delimiter}/usr/bin${delimiter}/bin`;
  assert.equal(pathWithStubFirst(`/usr/bin${delimiter}/bin`, "/tmp/stubs"), first);
  assert.equal(pathWithStubFirst(first, "/tmp/stubs"), first);
  assert.equal(pathWithStubFirst(undefined, "/tmp/stubs"), "/tmp/stubs");
  assert.equal(pathWithStubFirst("", "/tmp/stubs"), "/tmp/stubs");
});

test("putting the stub on a process's PATH changes that environment in place, in the temp directory start-server.sh also uses, and twice changes nothing more", async () => {
  await inTempDir(async dir => {
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const logs: string[] = [];
    await putLshwStubOnPath(line => logs.push(line), env, dir);
    assert.equal(env.PATH, `${join(dir, "mine-ai-stubs")}${delimiter}/usr/bin`);
    await putLshwStubOnPath(line => logs.push(line), env, dir);
    assert.equal(env.PATH, `${join(dir, "mine-ai-stubs")}${delimiter}/usr/bin`);
    const defaults: Record<string, string | undefined> = {};
    await putLshwStubOnPath(line => logs.push(line), defaults);
    assert.equal(defaults.PATH, join(tmpdir(), "mine-ai-stubs"));
    assert.equal(logs.length, 0, "a stub that was written logs nothing");
  });
});

test("a stub that cannot be written is logged with where to read about it and leaves PATH as it was, so the daemon still starts", async () => {
  await inTempDir(async dir => {
    const notADirectory = join(dir, "file");
    await writeFile(notADirectory, "");
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const logs: string[] = [];
    await putLshwStubOnPath(line => logs.push(line), env, notADirectory);
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(logs.length, 1);
    assert.match(logs[0]!, /lshw stub not installed .*05-testing-and-ops\.md/);
  });
});
