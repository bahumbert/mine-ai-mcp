// Reading a server's health: the `tick query` answer, and the clock that says it stopped answering.

export interface TickReading { readonly meanMs: number; readonly p95Ms: number }

/** `tick query` of 1.21.4: "Average time per tick: 0.8ms ..." and "P95: 1.2ms ..."; null when it carries no percentile yet. */
export function parseTickQuery(answer: string): TickReading | null {
  const mean = /Average time per tick:\s*([\d.]+)ms/u.exec(answer);
  const p95 = /P95:\s*([\d.]+)ms/u.exec(answer);
  return mean && p95 ? { meanMs: Number(mean[1]), p95Ms: Number(p95[1]) } : null;
}

/**
 * A server that was asked and has not answered for `stallAfterMs` is stalled (RCON times out each command, so silence means it stopped ticking or died).
 * The silence counts from the first question after the last answer, not from the last answer: time nobody asked the server (the sampler was
 * blocked, or had not sampled it yet) is not its silence (spec 2026-11-15 F3).
 */
export class StallWatch {
  #firstAskedAt: number | null = null;

  constructor(private readonly stallAfterMs: number) {}

  /** A question was sent at `at`; the first one since the last answer starts the silence. */
  asked(at: number): void {
    this.#firstAskedAt ??= at;
  }

  /** An answer, whatever it said: nothing is pending any more. */
  answered(_at: number): void {
    this.#firstAskedAt = null;
  }

  isStalled(now: number): boolean {
    return this.#firstAskedAt !== null && now - this.#firstAskedAt >= this.stallAfterMs;
  }
}
