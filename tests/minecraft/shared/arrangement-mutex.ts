// One arrangement or restore at a time per server, so the fill, clone and pins of two lanes never interleave. A lane's
// own player commands, scoped unpin, settle delay and client join run outside it (T7b): lane cells are 512 blocks apart
// and an arena reaches at most 88, so those touch no chunk another lane uses (arena/lanes.ts).

interface Waiter { readonly grant: () => void; readonly onAbort: () => void }

export class ArrangementMutex {
  #held = false;
  readonly #queue: Waiter[] = [];

  /** Resolves with the release function once it is this caller's turn; rejects at once if the signal aborts first. */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (!this.#held) {
      this.#held = true;
      return Promise.resolve(this.#releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", waiter.onAbort);
          resolve(this.#releaseOnce());
        },
        onAbort: () => {
          this.#queue.splice(this.#queue.indexOf(waiter), 1);
          reject(abortReason(signal!));
        },
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#queue.shift();
      if (next) next.grant();
      else this.#held = false;
    };
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));
}
