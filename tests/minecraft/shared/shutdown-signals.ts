// SIGTERM, SIGINT and SIGHUP stop the daemon's servers before it exits (Mine Labs reaps its children only on a clean exit).

/** Runs `shutdown` on the first of the three signals; returns the function that removes the handlers. */
export function installShutdownSignals(shutdown: (reason: string) => Promise<void>): () => void {
  let started = false;
  const handlers = (["SIGTERM", "SIGINT", "SIGHUP"] as const).map(signal => {
    const handler = (): void => {
      if (started) return;
      started = true;
      void shutdown(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  return () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
}
