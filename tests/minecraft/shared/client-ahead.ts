// The scenario clients the daemon boots before their trial: a submission's spare clients, waiting for `init`, handed to its trials through Mine Labs' `clientProvider`.
import { spawnClientAhead, type ClientAhead, type ClientCommandSpec, type ClientProvider } from "mine-labs";
import { CLIENT_BOOTED_MESSAGE } from "../client-boot-marker.ts";
import type { ScenarioServerConfig } from "./config.ts";

export type ClientAheadSpawner = (client: ClientCommandSpec) => ClientAhead;

type ClientsAheadConfig = Pick<ScenarioServerConfig, "clientsAhead" | "clientsAheadMax" | "clientBootBoundMs" | "clientBootFailureLimit" | "clientBootedMemMb" | "clientRampMs">;

export interface ClientsAheadDeps {
  readonly config: ClientsAheadConfig;
  readonly log: (message: string) => void;
  /** Spawns a client process (Mine Labs' `spawnClientAhead`); injectable for the tests. */
  readonly spawn?: ClientAheadSpawner;
  /** The clock the scheduler's young-client window runs on (default `Date.now`). */
  readonly now?: () => number;
}

/** The tuple that makes clients interchangeable: the working directory, the command and its arguments (the environment is `init`'s). */
export function clientTupleOf(client: ClientCommandSpec): string {
  return JSON.stringify([client.cwd ?? null, client.command, client.args]);
}

function labelOf(client: ClientCommandSpec): string {
  return [client.command, ...client.args].join(" ");
}

const STDERR_LINES_KEPT = 10;

interface Spare {
  readonly id: number;
  readonly submission: number;
  readonly tuple: string;
  readonly client: ClientCommandSpec;
  readonly ahead: ClientAhead;
  readonly spawnedAt: number;
  readonly spawnedPerf: number;
  /** Spawned for a trial already admitted: that trial's reserve is the whole client, so the spare reserves nothing of its own. */
  readonly covered: boolean;
  /** The trial this client is kept for; null while it is any trial's of its submission. */
  claimedBy: number | null;
  bootedAfterMs: number | null;
  state: "waiting" | "handed" | "killed" | "lost";
  stopWatching: () => void;
}

interface BootFailures { readonly count: number; readonly reason: string }

/** Where a trial's client comes from when the daemon booted it ahead; one per daemon, its spares kept per submission. */
export class ClientsAhead {
  readonly #spares = new Map<number, Spare[]>();
  /** Failed boots in a row per submission and client tuple; a boot that succeeds, or a client that reaches its trial, clears it. */
  readonly #failures = new Map<string, BootFailures>();
  readonly #spawnProcess: ClientAheadSpawner;
  readonly #now: () => number;
  #nextId = 1;
  #listener: (() => void) | null = null;

  constructor(private readonly deps: ClientsAheadDeps) {
    this.#spawnProcess = deps.spawn ?? (client => spawnClientAhead(client));
    this.#now = deps.now ?? Date.now;
  }

  /** The listener is called when a client is lost or a tuple given up, so the scheduler can boot another or fail the trials that cannot get one. */
  onChange(listener: () => void): void {
    this.#listener = listener;
  }

  /** Clients booted or booting and not yet handed to a trial, in one submission or (without an id) in all. */
  waitingCount(submission?: number): number {
    if (submission !== undefined) return this.#sparesOf(submission).length;
    return [...this.#spares.values()].reduce((sum, spares) => sum + spares.length, 0);
  }

  counts(submission: number): { readonly booted: number; readonly booting: number } {
    const spares = this.#sparesOf(submission);
    const booted = spares.filter(spare => spare.bootedAfterMs !== null).length;
    return { booted, booting: spares.length - booted };
  }

  /** Clients of this tuple that no trial has claimed. */
  unclaimedCount(submission: number, client: ClientCommandSpec): number {
    const tuple = clientTupleOf(client);
    return this.#sparesOf(submission).filter(spare => spare.tuple === tuple && spare.claimedBy === null).length;
  }

  /** Memory the clients spawned for queued trials are still growing into: their booted size for the ramp, then they are in MemAvailable. */
  youngMb(now: number): number {
    const { clientRampMs, clientBootedMemMb } = this.deps.config;
    let sum = 0;
    for (const spares of this.#spares.values()) {
      for (const spare of spares) if (!spare.covered && now - spare.spawnedAt < clientRampMs) sum += clientBootedMemMb;
    }
    return sum;
  }

  /** Why no client of this tuple is booted for the submission any more (it failed to boot too many times in a row), or null. */
  brokenReason(submission: number, client: ClientCommandSpec): string | null {
    const failures = this.#failures.get(failureKey(submission, clientTupleOf(client)));
    if (!failures || failures.count < this.deps.config.clientBootFailureLimit) return null;
    return `scenario client '${labelOf(client)}' (cwd ${client.cwd ?? "the daemon's"}) failed to boot ${failures.count} times in a row, the last time it ${failures.reason}; no more are started for this submission. The client host died or hung before it loaded its driver (a driver that fails to load is the trial's own error, not this one): fix how it starts (its working directory, bun, the host's own imports; its stderr is quoted above) and submit again.`;
  }

  /** Boots one client for the submission (kept for `claim.trial` when given); null when it started, else why it did not. */
  spawn(submission: number, client: ClientCommandSpec, claim?: { readonly trial: number; readonly covered: boolean }): string | null {
    const refusal = this.#refusalToSpawn(submission, client);
    if (refusal) return refusal;
    // The lane's values come with `init`: a spawn-time value would be the one of whichever trial asked first.
    const bare = { ...client, env: {} };
    let ahead: ClientAhead;
    try {
      ahead = this.#spawnProcess(bare);
    } catch (error) {
      this.#recordBootFailure(submission, client, `could not start (${error instanceof Error ? error.message : String(error)})`);
      return `could not start the client: ${error instanceof Error ? error.message : String(error)}`;
    }
    const spare: Spare = {
      id: this.#nextId++, submission, tuple: clientTupleOf(client), client, ahead, spawnedAt: this.#now(), spawnedPerf: performance.now(),
      covered: claim?.covered ?? false, claimedBy: claim?.trial ?? null, bootedAfterMs: null, state: "waiting", stopWatching: () => {},
    };
    this.#spares.set(submission, [...this.#sparesOf(submission), spare]);
    this.#watch(spare);
    return null;
  }

  /** Keeps up to `count` unclaimed clients of this tuple (booted first) for the trial; returns how many it took. */
  claim(submission: number, trial: number, client: ClientCommandSpec, count: number): number {
    const tuple = clientTupleOf(client);
    const free = this.#sparesOf(submission).filter(spare => spare.tuple === tuple && spare.claimedBy === null).sort(bootedFirst);
    const taken = free.slice(0, count);
    for (const spare of taken) spare.claimedBy = trial;
    return taken.length;
  }

  /**
   * The provider a trial hands to Mine Labs: the client kept for it, else a booted one, else one still booting; undefined when there is
   * none (the trial spawns its own, as before). It throws when the tuple was given up, whatever client is left.
   */
  providerFor(submission: number, trial: number, log: (message: string) => void): ClientProvider {
    return (client, username) => {
      const broken = this.brokenReason(submission, client);
      if (broken) throw new Error(broken);
      const spare = this.#takeSpare(submission, trial, clientTupleOf(client));
      if (!spare) return undefined;
      log(this.#handoverLine(spare, username));
      return spare.ahead;
    };
  }

  /** A trial ended: the clients it claimed and did not take go back to its submission's spares, still waiting for `init`. */
  trialEnded(trial: number): void {
    for (const spares of this.#spares.values()) for (const spare of spares) if (spare.claimedBy === trial) spare.claimedBy = null;
  }

  /** The submission ended or was cancelled: kills every client it has not handed over. Returns how many. */
  release(submission: number, reason: string): number {
    const spares = this.#sparesOf(submission);
    this.#spares.delete(submission);
    for (const key of [...this.#failures.keys()]) if (key.startsWith(`${submission}|`)) this.#failures.delete(key);
    for (const spare of spares) this.#kill(spare, "killed");
    if (spares.length > 0) this.deps.log(`s${submission}: ${spares.length} clients booted ahead killed unused (${reason})`);
    return spares.length;
  }

  #sparesOf(submission: number): Spare[] {
    return this.#spares.get(submission) ?? [];
  }

  /** The submission's cap or the total cap is reached: no spawn would be accepted now, whatever the client. */
  isFull(submission: number): boolean {
    return this.#capRefusal(submission) !== null;
  }

  #capRefusal(submission: number): string | null {
    const { clientsAhead, clientsAheadMax } = this.deps.config;
    const own = this.waitingCount(submission);
    if (own >= clientsAhead) return `${own} clients of this submission are already booted or booting (the cap is ${clientsAhead})`;
    const all = this.waitingCount();
    if (all >= clientsAheadMax) return `${all} clients are already booted or booting in all submissions (the cap is ${clientsAheadMax})`;
    return null;
  }

  #refusalToSpawn(submission: number, client: ClientCommandSpec): string | null {
    return this.brokenReason(submission, client) ?? this.#capRefusal(submission);
  }

  /** Watches the child's output for the booted line, and its exit and the boot bound on the wall clock. */
  #watch(spare: Spare): void {
    const { child } = spare.ahead;
    let seen = "";
    const onData = (chunk: Buffer | string): void => {
      seen = (seen + String(chunk)).slice(-2 * CLIENT_BOOTED_MESSAGE.length);
      if (seen.includes(CLIENT_BOOTED_MESSAGE)) this.#booted(spare);
    };
    child.stdout.on("data", onData);
    const bound = this.deps.config.clientBootBoundMs;
    const timer = setTimeout(() => {
      this.#recordLoss(spare, `did not boot within ${bound / 1_000} s`);
    }, bound);
    spare.stopWatching = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
    };
    void spare.ahead.closed.then(() => this.#recordLoss(spare, this.#exitText(spare.ahead)));
  }

  #booted(spare: Spare): void {
    if (spare.state !== "waiting" || spare.bootedAfterMs !== null) return;
    spare.bootedAfterMs = Math.round(performance.now() - spare.spawnedPerf);
    spare.stopWatching();
    this.#failures.delete(failureKey(spare.submission, spare.tuple));
    this.deps.log(`client boot s${spare.submission} ${labelOf(spare.client)}: boot=${spare.bootedAfterMs} ms`);
  }

  /** The client is gone before a trial took it (it exited or hit the boot bound): drop it, count a failed boot if it had not booted, tell the scheduler. */
  #recordLoss(spare: Spare, reason: string): void {
    if (spare.state !== "waiting") return;
    this.#kill(spare, "lost");
    const detail = [reason, this.#stderrTail(spare.ahead)].filter(Boolean).join(": ");
    if (spare.bootedAfterMs === null) {
      this.deps.log(`client boot failed s${spare.submission} ${labelOf(spare.client)}: ${detail}`);
      this.#recordBootFailure(spare.submission, spare.client, detail);
    } else {
      this.deps.log(`client booted ahead died while it waited, s${spare.submission} ${labelOf(spare.client)}: ${detail}`);
    }
    this.#changed();
  }

  #recordBootFailure(submission: number, client: ClientCommandSpec, reason: string): void {
    const key = failureKey(submission, clientTupleOf(client));
    const count = (this.#failures.get(key)?.count ?? 0) + 1;
    this.#failures.set(key, { count, reason });
    if (count !== this.deps.config.clientBootFailureLimit) return;
    this.deps.log(`s${submission} gave up booting clients ahead for ${labelOf(client)}: ${count} failed boots in a row`);
    // Every trial of this tuple fails now: a client still booting (or one that boots after this) would be taken by none of them.
    const tuple = clientTupleOf(client);
    for (const spare of this.#sparesOf(submission)) if (spare.tuple === tuple) this.#kill(spare, "lost");
  }

  #kill(spare: Spare, state: "killed" | "lost"): void {
    if (spare.state !== "waiting") return;
    spare.state = state;
    spare.stopWatching();
    const spares = this.#spares.get(spare.submission);
    if (spares && state === "lost") this.#spares.set(spare.submission, spares.filter(other => other !== spare));
    try {
      spare.ahead.child.kill("SIGKILL");
    } catch {
      // Already gone: nothing is left to stop.
    }
  }

  #takeSpare(submission: number, trial: number, tuple: string): Spare | null {
    const candidates = this.#sparesOf(submission)
      .filter(spare => spare.tuple === tuple && (spare.claimedBy === null || spare.claimedBy === trial))
      .sort((first, second) => Number(second.claimedBy === trial) - Number(first.claimedBy === trial) || bootedFirst(first, second));
    for (const spare of candidates) {
      // The exit may not have been reported yet: what the process says now is read at the pick.
      const gone = this.#goneText(spare.ahead);
      if (gone) {
        this.#recordLoss(spare, gone);
        continue;
      }
      spare.state = "handed";
      spare.stopWatching();
      this.#spares.set(submission, this.#sparesOf(submission).filter(other => other !== spare));
      // Only a client that had booted proves the tuple starts: one taken while it still boots may be about to fail.
      if (spare.bootedAfterMs !== null) this.#failures.delete(failureKey(submission, tuple));
      return spare;
    }
    return null;
  }

  #handoverLine(spare: Spare, username: string): string {
    const elapsed = Math.round(performance.now() - spare.spawnedPerf);
    if (spare.bootedAfterMs === null) return `client '${username}' taken from ahead: still booting after ${elapsed} ms, the trial waits for the rest`;
    return `client '${username}' taken from ahead: booted in ${spare.bootedAfterMs} ms, waited ${elapsed - spare.bootedAfterMs} ms for its trial`;
  }

  #goneText(ahead: ClientAhead): string | null {
    const error = ahead.spawnError();
    if (error) return `could not start (${error.message})`;
    const { child } = ahead;
    return child.exitCode === null && child.signalCode === null ? null : this.#exitText(ahead);
  }

  #exitText(ahead: ClientAhead): string {
    const error = ahead.spawnError();
    if (error) return `could not start (${error.message})`;
    const { exitCode, signalCode } = ahead.child;
    return `exited${exitCode === null ? "" : ` with code ${exitCode}`}${signalCode ? ` (${signalCode})` : ""}`;
  }

  #stderrTail(ahead: ClientAhead): string {
    return ahead.recentOutput().filter(({ stream }) => stream === "stderr").slice(-STDERR_LINES_KEPT).map(({ line }) => line.trim()).join("; ");
  }

  #changed(): void {
    try {
      this.#listener?.();
    } catch (error) {
      this.deps.log(`client ahead: the listener failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function failureKey(submission: number, tuple: string): string {
  return `${submission}|${tuple}`;
}

function bootedFirst(first: Spare, second: Spare): number {
  return Number(second.bootedAfterMs !== null) - Number(first.bootedAfterMs !== null);
}
