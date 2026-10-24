// What the machine is doing, from /proc: CPU busy share over a window, how much of it our own process tree used, available memory.
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";

export interface CpuTimes { readonly busy: number; readonly total: number }

/** The aggregate `cpu` line of /proc/stat: busy = everything but idle and iowait. */
export function parseCpuTimes(stat: string): CpuTimes {
  const line = stat.split("\n").find(candidate => candidate.startsWith("cpu "));
  if (!line) throw new Error("/proc/stat has no aggregate cpu line");
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    line.trim().split(/\s+/u).slice(1).map(Number);
  const busy = user + nice + system + irq + softirq + steal;
  return { busy, total: busy + idle + iowait };
}

/** Share of the machine's time busy between two readings; null without a previous reading or a window. */
export function cpuBusyBetween(previous: CpuTimes | null, current: CpuTimes): number | null {
  if (!previous) return null;
  const total = current.total - previous.total;
  return total > 0 ? (current.busy - previous.busy) / total : null;
}

export function memAvailableMbOf(meminfo: string): number {
  const match = /^MemAvailable:\s+(\d+) kB/mu.exec(meminfo);
  if (!match) throw new Error("/proc/meminfo has no MemAvailable");
  return Math.floor(Number(match[1]) / 1024);
}

/** VmRSS of /proc/<pid>/status in MB; a process that holds no memory any more (zombie) has none. */
export function residentMbOf(status: string): number {
  const match = /^VmRSS:\s+(\d+) kB/mu.exec(status);
  return match ? Math.floor(Number(match[1]) / 1024) : 0;
}

/** The first field of /proc/loadavg; null when the text is not one. */
export function loadAverage1Of(loadavg: string): number | null {
  const value = Number(loadavg.trim().split(/\s+/u)[0]);
  return Number.isFinite(value) ? value : null;
}

export interface ProcessTimes {
  readonly pid: number;
  readonly ppid: number;
  /** utime + stime in the jiffies of /proc/stat: the process's own time. cutime and cstime are left out: a child that exits was counted while it ran, and its whole life lands again in its parent's cutime (review T7c). */
  readonly jiffies: number;
}

/** /proc/<pid>/stat; the name sits in parentheses and may hold spaces or parentheses, so the fields are counted after the last `)`. Null for a cut line. */
export function parseProcessTimes(stat: string): ProcessTimes | null {
  const open = stat.indexOf(" (");
  const close = stat.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const pid = Number(stat.slice(0, open));
  const fields = stat.slice(close + 2).trim().split(/\s+/u);
  // fields[0] is the state (field 3 of proc(5)); ppid is field 4, utime 14, stime 15.
  const [ppid, utime, stime] = [fields[1], fields[11], fields[12]].map(Number);
  if (![pid, ppid, utime, stime].every(Number.isFinite)) return null;
  return { pid, ppid: ppid!, jiffies: utime! + stime! };
}

/** The jiffies of `root` and of every descendant (by parent links), by pid; empty when `root` is not listed. */
export function treeJiffies(all: readonly ProcessTimes[], root: number): Map<number, number> {
  const children = new Map<number, ProcessTimes[]>();
  for (const process of all) children.set(process.ppid, [...(children.get(process.ppid) ?? []), process]);
  const tree = new Map<number, number>();
  const rootProcess = all.find(process => process.pid === root);
  const pending = rootProcess ? [rootProcess] : [];
  for (let next = pending.pop(); next; next = pending.pop()) {
    tree.set(next.pid, next.jiffies);
    pending.push(...(children.get(next.pid) ?? []).filter(child => !tree.has(child.pid)));
  }
  return tree;
}

/**
 * The share of the machine our tree used in a window: what each process of `current` used since `previous` (a process
 * that was not there counts from its start; one that left took its time with it; a counter that went back counts 0),
 * over the window's total jiffies, never above the busy share (the counters were read at different instants).
 */
export function ownCpuBetween(
  previous: ReadonlyMap<number, number> | null,
  current: ReadonlyMap<number, number>,
  totalDelta: number,
  cpuBusy: number | null,
): number | null {
  if (!previous || totalDelta <= 0 || cpuBusy === null) return null;
  let used = 0;
  for (const [pid, jiffies] of current) used += Math.max(0, jiffies - (previous.get(pid) ?? 0));
  return Math.min(used / totalDelta, cpuBusy);
}

/** The files the probe reads; a test supplies its own. */
export interface ProcIo {
  readText(path: string): Promise<string>;
  listPids(): Promise<number[]>;
}

const REAL_PROC: ProcIo = {
  readText: path => readFile(path, "utf8"),
  listPids: async () => (await readdir("/proc")).filter(name => /^\d+$/u.test(name)).map(Number),
};

export interface MachineSnapshot {
  readonly cpuBusy: number | null;
  /** The share of the machine used by this process and its descendants over the same window; null when unreadable. */
  readonly ownCpu: number | null;
  readonly load1: number | null;
  readonly memAvailableMb: number;
  readonly threads: number;
}

/** Reads the machine; keeps the previous /proc/stat reading so each call returns the share since the last. */
export class MachineProbe {
  #previous: CpuTimes | null = null;
  #previousTree: Map<number, number> | null = null;

  readonly threads = availableParallelism();

  constructor(private readonly io: ProcIo = REAL_PROC, private readonly rootPid: number = process.pid) {}

  async read(): Promise<MachineSnapshot> {
    const times = parseCpuTimes(await this.io.readText("/proc/stat"));
    const tree = await this.#readTree();
    const cpuBusy = cpuBusyBetween(this.#previous, times);
    const ownCpu = tree && this.#previous ? ownCpuBetween(this.#previousTree, tree, times.total - this.#previous.total, cpuBusy) : null;
    this.#previous = times;
    this.#previousTree = tree;
    const load1 = loadAverage1Of(await this.io.readText("/proc/loadavg").catch(() => ""));
    return { cpuBusy, ownCpu, load1, memAvailableMb: memAvailableMbOf(await this.io.readText("/proc/meminfo")), threads: this.threads };
  }

  /** Every process of our tree; null when /proc cannot be listed. A process that left between the listing and its read is skipped. */
  async #readTree(): Promise<Map<number, number> | null> {
    try {
      const stats = await Promise.all((await this.io.listPids()).map(pid => this.io.readText(`/proc/${pid}/stat`).then(parseProcessTimes, () => null)));
      return treeJiffies(stats.filter((stat): stat is ProcessTimes => stat !== null), this.rootPid);
    } catch {
      return null;
    }
  }
}

/** Resident MB of a process, or 0 when it is gone. */
export async function residentMbOfPid(pid: number): Promise<number> {
  try {
    return residentMbOf(await readFile(`/proc/${pid}/status`, "utf8"));
  } catch {
    return 0;
  }
}
