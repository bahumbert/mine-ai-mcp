// What the machine is doing, from /proc: CPU busy share over a window, available memory, a process's resident size.
import { readFile } from "node:fs/promises";
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

/** Reads the machine; keeps the previous /proc/stat reading so each call returns the share since the last. */
export class MachineProbe {
  #previous: CpuTimes | null = null;

  readonly threads = availableParallelism();

  async read(): Promise<{ readonly cpuBusy: number | null; readonly memAvailableMb: number; readonly threads: number }> {
    const times = parseCpuTimes(await readFile("/proc/stat", "utf8"));
    const cpuBusy = cpuBusyBetween(this.#previous, times);
    this.#previous = times;
    return { cpuBusy, memAvailableMb: memAvailableMbOf(await readFile("/proc/meminfo", "utf8")), threads: this.threads };
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
