// Bench verification shared by submissions, with independently cancellable waiters.
import type { ResultClass } from "./result-class.ts";

export type BenchVerdict = { kind: "verified"; seconds: number } | { kind: "infra"; name: string; cause: string } | { kind: "unproven"; class: ResultClass; cause?: string };
export interface CanaryRun {
  readonly done: Promise<{ class: ResultClass; cause?: string; selfMade?: boolean; elapsedMs: number }>;
  waitReport(): string | null;
}

interface Flight {
  readonly abort: AbortController;
  readonly waiters: Set<(text: string) => void>;
  readonly done: Promise<BenchVerdict>;
  run?: CanaryRun;
  timer?: ReturnType<typeof setInterval>;
}

/** Only a cause explicitly known not to come from the scenario may block a batch. */
function verdictOf(path: string, result: Awaited<CanaryRun["done"]>): BenchVerdict {
  if (result.class === "pass") return { kind: "verified", seconds: result.elapsedMs / 1000 };
  if (result.class === "infra" && result.selfMade === false) return { kind: "infra", name: path, cause: result.cause ?? "bench failed without a cause" };
  return { kind: "unproven", class: result.class, ...(result.cause === undefined ? {} : { cause: result.cause }) };
}

/** One report is read for the run and delivered to its current waiters. */
function reportWait(flight: Flight): void {
  const text = flight.run?.waitReport();
  if (text) for (const notify of flight.waiters) notify(text);
}

export class BenchState {
  #verified = false;
  #seconds = 0;
  readonly #flights = new Map<string, Flight>();

  constructor(readonly waitReportMs = 5000) {}

  isVerified(): boolean { return this.#verified; }
  sawInfra(): void { this.#verified = false; }
  sawPass(): void { this.#verified = true; }

  /** Share a path's canary until it ends or loses its last waiter. */
  ensure(path: string, start: (signal: AbortSignal) => Promise<CanaryRun>, waiter: AbortSignal, onWait: (text: string) => void): Promise<BenchVerdict | "left"> {
    if (waiter.aborted) return Promise.resolve("left");
    if (this.#verified) return Promise.resolve({ kind: "verified", seconds: this.#seconds });
    const flight = this.#flights.get(path) ?? this.#start(path, start);
    return new Promise(resolve => {
      const notify = (text: string) => onWait(text);
      const finish = (verdict: BenchVerdict | "left") => {
        waiter.removeEventListener("abort", leave);
        flight.waiters.delete(notify);
        resolve(verdict);
      };
      const leave = () => {
        finish("left");
        if (flight.waiters.size !== 0) return;
        flight.abort.abort("no canary waiters left");
        clearInterval(flight.timer);
        if (this.#flights.get(path) === flight) this.#flights.delete(path);
      };
      flight.waiters.add(notify);
      waiter.addEventListener("abort", leave, { once: true });
      if (flight.run) { const text = flight.run.waitReport(); if (text) onWait(text); }
      void flight.done.then(finish);
    });
  }

  /** Run lifetime belongs to the bench, including its report timer and abandoned-result guard. */
  #start(path: string, start: (signal: AbortSignal) => Promise<CanaryRun>): Flight {
    const abort = new AbortController();
    const flight: Flight = {
      abort, waiters: new Set(),
      done: Promise.resolve().then(() => start(abort.signal)).then(async run => {
        flight.run = run;
        if (!abort.signal.aborted) {
          reportWait(flight);
          flight.timer = setInterval(() => reportWait(flight), this.waitReportMs);
        }
        return verdictOf(path, await run.done);
      }).catch((error: unknown): BenchVerdict => ({ kind: "unproven", class: "product", cause: error instanceof Error ? error.message : String(error) }))
        .then(verdict => {
          clearInterval(flight.timer);
          if (this.#flights.get(path) === flight) this.#flights.delete(path);
          if (!abort.signal.aborted && verdict.kind === "verified") { this.#seconds = verdict.seconds; this.sawPass(); }
          if (!abort.signal.aborted && (verdict.kind === "infra" || verdict.kind === "unproven" && verdict.class === "infra")) this.sawInfra();
          return verdict;
        }),
    };
    this.#flights.set(path, flight);
    return flight;
  }
}
