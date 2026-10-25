import test from "node:test";
import assert from "node:assert/strict";
import {
  cpuBusyBetween, loadAverage1Of, MachineProbe, memAvailableMbOf, ownCpuBetween, parseCpuTimes, parseProcessTimes, residentMbOf, treeJiffies,
  type ProcessTimes, type ProcIo,
} from "./machine-load.ts";

const STAT_A = "cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 10 0 5 80 5 0 0 0 0 0\nintr 1";
const STAT_B = "cpu  300 0 150 900 50 0 0 0 0 0\ncpu0 30 0 15 90 5 0 0 0 0 0";

test("the busy share between two /proc/stat readings counts user+system over all time, idle and iowait as idle", () => {
  const busy = cpuBusyBetween(parseCpuTimes(STAT_A), parseCpuTimes(STAT_B));
  // delta busy = 200 + 100 = 300, delta total = 300 + 100 = 400
  assert.equal(busy, 0.75);
});

test("two identical readings give no share instead of a division by zero", () => {
  assert.equal(cpuBusyBetween(parseCpuTimes(STAT_A), parseCpuTimes(STAT_A)), null);
});

test("the first reading has no previous one: no share", () => {
  assert.equal(cpuBusyBetween(null, parseCpuTimes(STAT_A)), null);
});

test("a /proc/stat without an aggregate cpu line throws", () => {
  assert.throws(() => parseCpuTimes("intr 1"), /cpu/u);
});

test("MemAvailable is read in megabytes from /proc/meminfo", () => {
  assert.equal(memAvailableMbOf("MemTotal:       32428000 kB\nMemAvailable:   29646848 kB\n"), 28_952);
});

test("a /proc/meminfo with no MemAvailable throws", () => {
  assert.throws(() => memAvailableMbOf("MemTotal: 1 kB\n"), /MemAvailable/u);
});

test("the resident size of a process comes from VmRSS of /proc/<pid>/status", () => {
  assert.equal(residentMbOf("Name:\tjava\nVmRSS:\t 1572864 kB\nThreads:\t40\n"), 1_536);
});

test("a status with no VmRSS (a zombie) is zero resident", () => {
  assert.equal(residentMbOf("Name:\tjava\nState:\tZ\n"), 0);
});

// pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime ...
function procStat(pid: number, comm: string, ppid: number, utime: number, stime: number, cutime = 0, cstime = 0): string {
  return `${pid} (${comm}) S ${ppid} 1 1 0 -1 4194560 100 0 0 0 ${utime} ${stime} ${cutime} ${cstime} 20 0 1 0 5 1000 100 18446744073709551615`;
}

test("a process's jiffies are its utime + stime only (a reaped child's time is in cutime and was counted while it lived), read after the last ')' so a name with spaces and parentheses does not shift the fields", () => {
  assert.deepEqual(parseProcessTimes(procStat(7, "java (x) y", 3, 100, 50, 20, 10)), { pid: 7, ppid: 3, jiffies: 150 });
});

test("a stat line that is cut or empty is no process (it left while it was read)", () => {
  assert.equal(parseProcessTimes(""), null);
  assert.equal(parseProcessTimes("7 (java) S 3"), null);
});

test("the tree of a pid is the pid and every descendant through the parent links, and nothing else", () => {
  const all: ProcessTimes[] = [
    { pid: 1, ppid: 0, jiffies: 9_000 }, { pid: 10, ppid: 1, jiffies: 5 }, { pid: 11, ppid: 10, jiffies: 7 },
    { pid: 12, ppid: 11, jiffies: 11 }, { pid: 20, ppid: 1, jiffies: 99 },
  ];
  assert.deepEqual([...treeJiffies(all, 10)].sort(([a], [b]) => a - b), [[10, 5], [11, 7], [12, 11]]);
  assert.deepEqual([...treeJiffies(all, 999)], [], "a root that is not listed has no tree");
});

test("the own share is the jiffies the tree used in the window over the machine's total jiffies, a new process counting from its start", () => {
  const before = new Map([[10, 100], [11, 200]]);
  const after = new Map([[10, 160], [11, 260], [12, 40]]);
  // 60 + 60 + 40 = 160 jiffies of a 400 jiffy window
  assert.equal(ownCpuBetween(before, after, 400, 0.9), 0.4);
});

test("a process that left the tree takes its time with it: the delta is never negative", () => {
  const before = new Map([[10, 100], [11, 500]]);
  const after = new Map([[10, 150]]);
  assert.equal(ownCpuBetween(before, after, 500, 0.9), 0.1);
  assert.equal(ownCpuBetween(new Map([[10, 500]]), new Map([[10, 100]]), 500, 0.9), 0, "a counter that went back counts 0");
});

test("the own share is never above the busy share (counters read at different instants)", () => {
  assert.equal(ownCpuBetween(new Map([[10, 0]]), new Map([[10, 450]]), 400, 0.5), 0.5);
});

test("the own share is null without a previous reading, a window or a busy share", () => {
  assert.equal(ownCpuBetween(null, new Map([[10, 1]]), 400, 0.5), null);
  assert.equal(ownCpuBetween(new Map(), new Map([[10, 1]]), 0, 0.5), null);
  assert.equal(ownCpuBetween(new Map(), new Map([[10, 1]]), 400, null), null);
});

test("the 1-minute load average is the first field of /proc/loadavg", () => {
  assert.equal(loadAverage1Of("3.52 2.10 1.00 4/812 12345\n"), 3.52);
  assert.equal(loadAverage1Of("not a loadavg"), null);
});

/** /proc as plain text: stat lines move between reads as the test changes `files`. */
function fakeProc(files: Map<string, string>): ProcIo {
  return {
    readText: async path => { const text = files.get(path); if (text === undefined) throw new Error(`ENOENT ${path}`); return text; },
    listPids: async () => [...files.keys()].flatMap(path => (/^\/proc\/(\d+)\/stat$/u.exec(path) ? [Number(/(\d+)/u.exec(path)![1])] : [])),
  };
}

const meminfo = "MemTotal: 1 kB\nMemAvailable:   20971520 kB\n";

test("the probe reads own cpu over the same window as the busy share, from the daemon's tree only, and the load average", async () => {
  const files = new Map<string, string>([
    ["/proc/stat", "cpu  100 0 50 800 50 0 0 0 0 0"], ["/proc/meminfo", meminfo], ["/proc/loadavg", "2.5 1 1 1/1 1"],
    ["/proc/100/stat", procStat(100, "bun", 1, 10, 0)], ["/proc/101/stat", procStat(101, "java", 100, 100, 0)],
    ["/proc/200/stat", procStat(200, "foreign", 1, 5_000, 0)],
  ]);
  const probe = new MachineProbe(fakeProc(files), 100);
  const first = await probe.read();
  assert.equal(first.cpuBusy, null);
  assert.equal(first.ownCpu, null, "no window yet");
  files.set("/proc/stat", "cpu  300 0 150 900 50 0 0 0 0 0");
  files.set("/proc/101/stat", procStat(101, "java", 100, 220, 0));
  files.set("/proc/200/stat", procStat(200, "foreign", 1, 5_200, 0));
  const second = await probe.read();
  assert.equal(second.cpuBusy, 0.75);
  assert.equal(second.ownCpu, 0.3, "120 of the 400 jiffies of the window; the foreign process's 200 are not ours");
  assert.equal(second.load1, 2.5);
  assert.equal(second.memAvailableMb, 20_480);
});

test("a process of the tree that is gone between the listing and its read is skipped, and an unreadable tree gives null, never a throw", async () => {
  const files = new Map<string, string>([
    ["/proc/stat", "cpu  100 0 50 800 50 0 0 0 0 0"], ["/proc/meminfo", meminfo], ["/proc/loadavg", "1 1 1 1/1 1"],
    ["/proc/100/stat", procStat(100, "bun", 1, 10, 0)], ["/proc/101/stat", procStat(101, "java", 100, 100, 0)],
  ]);
  const io = fakeProc(files);
  const flaky: ProcIo = { ...io, listPids: async () => [100, 101, 102] };
  const probe = new MachineProbe(flaky, 100);
  await probe.read();
  files.set("/proc/stat", "cpu  300 0 150 900 50 0 0 0 0 0");
  files.set("/proc/101/stat", procStat(101, "java", 100, 160, 0));
  assert.equal((await probe.read()).ownCpu, 0.15, "pid 102 never existed: skipped");
  const blind = new MachineProbe({ readText: io.readText, listPids: async () => { throw new Error("EACCES"); } }, 100);
  await blind.read();
  assert.equal((await blind.read()).ownCpu, null);
});

test("a child that exits and is reaped adds nothing: its time was counted while it lived and its parent's cutime is not read", async () => {
  const files = new Map<string, string>([
    ["/proc/stat", "cpu  100 0 50 800 50 0 0 0 0 0"], ["/proc/meminfo", meminfo], ["/proc/loadavg", "1 1 1 1/1 1"],
    ["/proc/100/stat", procStat(100, "bun", 1, 10, 0)], ["/proc/101/stat", procStat(101, "java", 100, 100, 0)],
  ]);
  const probe = new MachineProbe(fakeProc(files), 100);
  await probe.read();
  files.set("/proc/stat", "cpu  300 0 150 900 50 0 0 0 0 0");
  files.delete("/proc/101/stat");
  files.set("/proc/100/stat", procStat(100, "bun", 1, 10, 0, 100, 0));
  assert.equal((await probe.read()).ownCpu, 0, "the java server left and its 100 jiffies came back as the parent's cutime");
});
