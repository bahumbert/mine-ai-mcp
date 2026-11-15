// One sample: read the machine and every server, tell the scheduler, stop what is idle or stalled.
import type { ScenarioServerConfig } from "./config.ts";
import { parseTickQuery } from "./health.ts";
import type { MachineReading, Scheduler } from "./scheduler.ts";
import type { ServerPool } from "./pool.ts";
import type { ScenarioServer } from "./scenario-server.ts";

export interface SamplerDeps {
  readonly pool: ServerPool;
  readonly scheduler: Scheduler;
  readonly config: ScenarioServerConfig;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly machine: { read(): Promise<MachineReading> };
  /** Resident MB of a process; 0 when it is gone. */
  readonly residentMbOf: (pid: number) => Promise<number>;
}

const unparsedLogged = new WeakSet<ScenarioServer>();
/** Mine Labs sends a server's RCON commands one at a time, so a query on top of an unanswered one only lengthens the queue. */
const queryOutstanding = new WeakSet<ScenarioServer>();

async function readServerHealth(deps: SamplerDeps, id: string, server: ScenarioServer): Promise<void> {
  // The process is read apart from the query: a dead server's query fails or never answers, and says nothing of why.
  // A server with no known pid has no reading and is left to the stall window.
  const pid = server.javaPid();
  const residentMb = pid === null ? 0 : await deps.residentMbOf(pid);
  if (pid !== null) deps.pool.noteJavaProcess(id, residentMb > 0);
  if (queryOutstanding.has(server)) return;
  queryOutstanding.add(server);
  deps.pool.asked(id, deps.now());
  // No bound of our own: RCON times each command out at 10 s, and an answer that comes late still shows the server alive.
  const answer = await server.command("tick query").catch(() => null).finally(() => queryOutstanding.delete(server));
  if (answer === null) return;
  deps.pool.answered(id, deps.now());
  const reading = parseTickQuery(answer);
  if (!reading && !unparsedLogged.has(server)) {
    unparsedLogged.add(server);
    deps.log(`server ${id}: tick query answer not understood, tick time unknown: ${answer.slice(0, 200)}`);
  }
  deps.pool.setHealth(id, { msptP95: reading?.p95Ms ?? null, residentMb });
}

/**
 * Waits for the reads at most `boundMs`; a read still running then is marked late in the pool at once (it goes on, and its own answer still
 * clears the mark). Marked here, not after the machine read: an answer that comes between the bound and the end of a slow machine read
 * must not be overwritten. The timer is cleared when the reads win, so no sample leaves one pending.
 */
async function waitForReads(deps: SamplerDeps, reads: ReadonlyMap<string, Promise<void>>, boundMs: number): Promise<void> {
  const ended = new Set<string>();
  const tracked = [...reads].map(([id, read]) => read.then(() => void ended.add(id)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>(resolve => { timer = setTimeout(resolve, boundMs); });
  try {
    await Promise.race([Promise.all(tracked), bound]);
  } finally {
    clearTimeout(timer);
  }
  for (const id of reads.keys()) if (!ended.has(id)) deps.pool.markLate(id);
}

/**
 * One sample. Nothing in it waits on a server stop (they are started, not awaited: a 20 s stop held the sample 20 s) and the tick
 * queries are waited for at most `sampleEveryMs / 2` (spec 2026-11-15 section 1, F1 and F2): a server still unanswered then is read late.
 */
export async function sampleOnce(deps: SamplerDeps): Promise<void> {
  const reads = new Map(deps.pool.healthTargets().map(target => [target.id, readServerHealth(deps, target.id, target.server)]));
  const [machine] = await Promise.all([deps.machine.read(), waitForReads(deps, reads, deps.config.sampleEveryMs / 2)]);
  const now = deps.now();
  deps.pool.stopDeadJava();
  deps.pool.stopStalled(now);
  deps.scheduler.onSample(machine, now);
  deps.pool.reap(now, deps.scheduler.queuedKeys());
}
