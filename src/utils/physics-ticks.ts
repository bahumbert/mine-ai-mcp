interface PhysicsTickSource {
  on(event: "physicsTick", listener: () => void): unknown;
  off(event: "physicsTick", listener: () => void): unknown;
}

/** The ticks a wait needed did not all come within its wall-clock bound: physics has stopped (a ride, an unloaded chunk, a death). */
export class PhysicsStoppedError extends Error {
  constructor(readonly wallMs: number) {
    super(`no physics tick for ${wallMs} ms`);
    this.name = "PhysicsStoppedError";
  }
}

/** The wall-clock bound for one tick to come when a caller waits tick by tick: 20 client ticks. */
export const PHYSICS_TICK_WALL_MS = 1_000;

export interface PhysicsTickWaitOptions {
  /** Reject `PhysicsStoppedError` when the ticks have not all come within this many wall-clock milliseconds. Without it the wait ends on ticks or abort only. */
  readonly wallMs?: number;
}

/** Wait for observed physics, releasing immediately on abort even if physics has stopped. */
export async function waitForPhysicsTicks(
  source: PhysicsTickSource,
  ticks: number,
  signal: AbortSignal,
  options: PhysicsTickWaitOptions = {},
): Promise<void> {
  signal.throwIfAborted();
  if (ticks <= 0) return;
  await new Promise<void>((resolve, reject) => {
    let remaining = ticks;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      source.off("physicsTick", tick);
      signal.removeEventListener("abort", abort);
      if (timer !== undefined) clearTimeout(timer);
    };
    const tick = () => {
      if (--remaining > 0) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    source.on("physicsTick", tick);
    signal.addEventListener("abort", abort, { once: true });
    const { wallMs } = options;
    if (wallMs !== undefined)
      timer = setTimeout(() => {
        cleanup();
        reject(new PhysicsStoppedError(wallMs));
      }, wallMs);
  });
}

/**
 * Wait tick by tick until `done()`, for at most `maxTicks` ticks, each within `wallMs`; answers whether `done()` holds.
 * Physics that stopped ends the wait with the answer as it stands, for a caller that checks it next; an abort still
 * rejects with the signal's reason.
 */
export async function physicsTicksUntil(
  source: PhysicsTickSource,
  done: () => boolean,
  maxTicks: number,
  signal: AbortSignal,
  wallMs = PHYSICS_TICK_WALL_MS,
): Promise<boolean> {
  for (let tick = 0; tick < maxTicks && !done(); tick += 1) {
    try {
      await waitForPhysicsTicks(source, 1, signal, { wallMs });
    } catch (cause) {
      if (cause instanceof PhysicsStoppedError) break;
      throw cause;
    }
  }
  return done();
}
