// Reading a server's health: the `tick query` answer, and the clock that says it stopped answering.

export interface TickReading { readonly meanMs: number; readonly p95Ms: number }

/** `tick query` of 1.21.4: "Average time per tick: 0.8ms ..." and "P95: 1.2ms ..."; null when it carries no percentile yet. */
export function parseTickQuery(answer: string): TickReading | null {
  const mean = /Average time per tick:\s*([\d.]+)ms/u.exec(answer);
  const p95 = /P95:\s*([\d.]+)ms/u.exec(answer);
  return mean && p95 ? { meanMs: Number(mean[1]), p95Ms: Number(p95[1]) } : null;
}

/** A server silent for `stallAfterMs` is stalled (RCON times out each command, so silence means it stopped ticking or died). */
export class StallWatch {
  #lastAnswerAt: number;

  constructor(private readonly stallAfterMs: number, startedAt: number) {
    this.#lastAnswerAt = startedAt;
  }

  answered(at: number): void {
    this.#lastAnswerAt = at;
  }

  isStalled(now: number): boolean {
    return now - this.#lastAnswerAt >= this.stallAfterMs;
  }
}
