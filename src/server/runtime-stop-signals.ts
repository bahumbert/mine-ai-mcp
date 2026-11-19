/** What the runtime process does on SIGINT and SIGTERM (a standalone host's runtime or one a brain embeds). */

export interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * A standalone runtime stops on the first signal. An embedded one (a brain's child, plan 2026-11-18-in-process-runtime
 * D2) must not: a group signal (Ctrl+C in the terminal) reaches the child with its parent, and the parent has to cancel
 * the running action through the link before the runtime goes. So the listener stays, does nothing while the parent is
 * connected (a signal with no listener would end the process), and stops the runtime only once the parent is gone; the
 * parent's own stop SIGKILLs after its grace.
 */
export function handleStopSignals(
  source: SignalSource,
  options: { readonly embedded: boolean; readonly isConnected: () => boolean; readonly requestStop: () => void },
): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    if (options.embedded) {
      source.on(signal, () => {
        if (!options.isConnected()) options.requestStop();
      });
    } else {
      source.once(signal, options.requestStop);
    }
  }
}
