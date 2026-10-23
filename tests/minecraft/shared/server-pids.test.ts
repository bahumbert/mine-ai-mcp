import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findJavaPid, killLeftoverServers, PidFile, procFs, type ProcFs } from "./server-pids.ts";

const ROOT = "/repo/.tmp/scenario-server/servers";

function fakeProc(processes: Record<number, { cmdline: string[]; cwd: string }>): ProcFs {
  return {
    list: () => Object.keys(processes).map(Number),
    cmdline: pid => processes[pid]?.cmdline ?? null,
    cwd: pid => processes[pid]?.cwd ?? null,
  };
}

const javaServer = (cwd: string) => ({ cmdline: ["java", "-Xmx3072M", "-jar", "/home/u/.mine-labs/servers/1.21.4/server.jar", "nogui"], cwd });

test("the java pid of a server is the process running server.jar in its root", () => {
  const proc = fakeProc({ 10: javaServer(`${ROOT}/s1`), 11: javaServer(`${ROOT}/s2`), 12: { cmdline: ["bun", "x.ts"], cwd: `${ROOT}/s1` } });
  assert.equal(findJavaPid(`${ROOT}/s1`, proc), 10);
  assert.equal(findJavaPid(`${ROOT}/s9`, proc), null);
});

test("pids are kept in a file with their root, added and removed by pid, and two adds at once keep both", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pids-"));
  try {
    const file = new PidFile(join(dir, "pids"));
    await Promise.all([file.add({ pid: 10, root: "/a/s1" }), file.add({ pid: 11, root: "/a/s2" }), file.add({ pid: 12, root: "/a/s 3" })]);
    await file.remove(10);
    assert.deepEqual(await file.read(), [{ pid: 11, root: "/a/s2" }, { pid: 12, root: "/a/s 3" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a pid file that does not exist reads as empty", async () => {
  assert.deepEqual(await new PidFile("/nonexistent/dir/pids").read(), []);
});

test("leftover cleanup kills a listed pid that runs server.jar under the server root and leaves a live non-java pid alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pids-"));
  try {
    const file = new PidFile(join(dir, "pids"));
    await writeFile(join(dir, "pids"), `10 ${ROOT}/s1\n11 ${ROOT}\n12 ${ROOT}/s2\n13 ${ROOT}/s4\n`);
    const proc = fakeProc({
      10: javaServer(`${ROOT}/s1`),                       // ours: killed
      11: { cmdline: ["bun", "daemon.ts"], cwd: ROOT },    // reused pid of another program: left alone
      12: javaServer("/somewhere/else/s1"),                // pid reused by a java server of another tool (other cwd): left alone
    });                                                    // 13: gone
    const killed: number[] = [];
    const report = await killLeftoverServers(file, proc, pid => killed.push(pid));
    assert.deepEqual(killed, [10]);
    assert.deepEqual(report, { killed: [10], left: [11, 12], gone: [13] });
    assert.deepEqual(await file.read(), [], "the file is emptied: the next start lists only its own servers");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the real /proc reader finds this very process and reads its command line", () => {
  assert.ok(procFs.list().includes(process.pid));
  assert.ok((procFs.cmdline(process.pid) ?? []).length > 0);
  assert.equal(procFs.cmdline(2_000_000_000), null);
});
