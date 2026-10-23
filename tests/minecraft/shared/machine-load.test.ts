import test from "node:test";
import assert from "node:assert/strict";
import { cpuBusyBetween, memAvailableMbOf, parseCpuTimes, residentMbOf } from "./machine-load.ts";

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
