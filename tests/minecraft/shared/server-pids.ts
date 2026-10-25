// The java processes of our servers: finding one by its root, keeping their pids in a file, killing the ones a dead daemon left.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname } from "node:path";

export interface ProcFs {
  list(): number[];
  /** Null when the process is gone or unreadable. */
  cmdline(pid: number): string[] | null;
  cwd(pid: number): string | null;
}

export const procFs: ProcFs = {
  list: () => readdirSync("/proc").filter(name => /^\d+$/u.test(name)).map(Number),
  cmdline: pid => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    } catch {
      return null;
    }
  },
  cwd: pid => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  },
};

function isServerJar(cmdline: readonly string[] | null): boolean {
  return cmdline !== null && cmdline.includes("-jar") && cmdline.some(word => word.endsWith("server.jar"));
}

/** The java process running `server.jar` with `serverRoot` as its working directory (Mine Labs does not expose its pid). */
export function findJavaPid(serverRoot: string, proc: ProcFs = procFs): number | null {
  return proc.list().find(pid => proc.cwd(pid) === serverRoot && isServerJar(proc.cmdline(pid))) ?? null;
}

export interface ListedServer { readonly pid: number; /** The server's root: the java process runs with it as working directory. */ readonly root: string }

/** One `pid root` line per server of a daemon, in a file next to its socket so any checkout's next start finds it. */
export class PidFile {
  /** Writes are queued: two servers started at once must not lose each other's line. */
  #writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async read(): Promise<ListedServer[]> {
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).map(line => {
        const [pid, ...root] = line.split(" ");
        return { pid: Number(pid), root: root.join(" ") };
      });
    } catch {
      return [];
    }
  }

  add(server: ListedServer): Promise<void> {
    return this.#update(listed => [...listed, server]);
  }

  remove(pid: number): Promise<void> {
    return this.#update(listed => listed.filter(server => server.pid !== pid));
  }

  clear(): Promise<void> {
    return this.#update(() => []);
  }

  #update(change: (listed: ListedServer[]) => ListedServer[]): Promise<void> {
    const next = this.#writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, change(await this.read()).map(server => `${server.pid} ${server.root}\n`).join(""));
    });
    this.#writes = next.catch(() => undefined);
    return next;
  }
}

export interface LeftoverReport { readonly killed: number[]; readonly left: number[]; readonly gone: number[] }

/**
 * Mine Labs reaps its servers only on a clean exit, so a daemon killed by SIGKILL or a WSL shutdown leaves its java processes.
 * Kills, by pid, the listed ones that still run a server.jar with the listed root as working directory; a reused pid of another
 * program is left alone.
 */
export async function killLeftoverServers(file: PidFile, proc: ProcFs, kill: (pid: number) => void): Promise<LeftoverReport> {
  const report: LeftoverReport = { killed: [], left: [], gone: [] };
  for (const { pid, root } of await file.read()) {
    if (proc.cmdline(pid) === null) report.gone.push(pid);
    else if (isServerJar(proc.cmdline(pid)) && proc.cwd(pid) === root) { kill(pid); report.killed.push(pid); }
    else report.left.push(pid);
  }
  await file.clear();
  return report;
}
