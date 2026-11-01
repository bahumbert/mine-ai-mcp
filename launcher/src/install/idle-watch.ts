// One silence bound for the steps that wait on a network stream (a pinned download, the model pull): Bun has no idle timeout of its own.

export interface IdleWatch {
  /** Aborts when the bound fires: the fetch ends, and a reader built on it ends too. */
  readonly signal: AbortSignal;
  fired(): boolean;
  /** Starts the bound over: it fires `ms` from now unless armed again (also ends a pause). Nothing runs before the first call. */
  arm(): void;
  /** No bound until the next `arm` (the stream is silent on purpose, as Ollama is while it verifies the layers it pulled). */
  pause(): void;
  /** Releases the timer; the watch never fires after it. */
  stop(): void;
}

export function idleWatch(ms: number): IdleWatch {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const pause = () => clearTimeout(timer);
  return {
    signal: controller.signal,
    fired: () => fired,
    arm() {
      pause();
      timer = setTimeout(() => {
        fired = true;
        controller.abort();
      }, ms);
    },
    pause,
    stop: pause,
  };
}
