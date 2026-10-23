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
  if (queryOutstanding.has(server)) return;
  queryOutstanding.add(server);
  // No bound of our own: RCON times each command out at 10 s, and an answer that comes late still shows the server alive.
  const answer = await server.command("tick query").catch(() => null).finally(() => queryOutstanding.delete(server));
  if (answer === null) return;
  deps.pool.answered(id, deps.now());
  const reading = parseTickQuery(answer);
  if (!reading && !unparsedLogged.has(server)) {
    unparsedLogged.add(server);
    deps.log(`server ${id}: tick query answer not understood, tick time unknown: ${answer.slice(0, 200)}`);
  }
  const pid = server.javaPid();
  deps.pool.setHealth(id, { msptP95: reading?.p95Ms ?? null, residentMb: pid === null ? 0 : await deps.residentMbOf(pid) });
}

export async function sampleOnce(deps: SamplerDeps): Promise<void> {
  const [machine] = await Promise.all([
    deps.machine.read(),
    ...deps.pool.healthTargets().map(target => readServerHealth(deps, target.id, target.server)),
  ]);
  const now = deps.now();
  await deps.pool.stopStalled(now);
  deps.scheduler.onSample(machine, now);
  await deps.pool.reap(now, deps.scheduler.queuedKeys());
}
