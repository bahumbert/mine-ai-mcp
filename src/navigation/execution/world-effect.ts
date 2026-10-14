import type { NavigationBot } from "../bot.js";
import type { BlockMatcher, PlannedOperation } from "../movements/movement.js";
import type { BlockPosition } from "../world/world.js";
import type { AttemptToken, ExpectedMutationLedger, MutationResult } from "./mutations.js";

export type WorldEffectResult =
  | MutationResult
  | { readonly kind: "effect_failed"; readonly observation: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "invalidated" };

/**
 * How long a cancelled effect may take to settle. Live 2026-10-11 (orders test, Vex): a dig whose block update never came
 * (the bot was teleported mid-dig) cannot be stopped once mineflayer's dig timer has fired, so its completion never
 * settled and every cancel above it waited for ever. Past this the effect is abandoned, not awaited.
 */
export const EFFECT_DRAIN_MS = 2_000;

/** Waits for a cancelled effect to settle, but no longer than {@link EFFECT_DRAIN_MS}; the abandoned promise is left to settle alone. */
async function drained(completion: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<void>((resolve) => { timer = setTimeout(resolve, EFFECT_DRAIN_MS); });
  try {
    await Promise.race([completion.then(() => undefined, () => undefined), abandoned]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own an interaction until both its physical work and world confirmation settle. */
export async function executeWorldEffect(options: {
  readonly bot: NavigationBot;
  readonly ledger: ExpectedMutationLedger;
  readonly signal: AbortSignal;
  readonly token: AttemptToken;
  readonly operation: Exclude<PlannedOperation, { kind: "move" }>;
  readonly targets: readonly {
    readonly position: BlockPosition;
    readonly before: BlockMatcher;
    readonly after: BlockMatcher;
    readonly owned?: readonly BlockPosition[];
  }[];
  readonly deadlineMs: number;
  readonly invalidated?: Promise<{ readonly kind: "invalidated" }>;
}): Promise<{ readonly result: WorldEffectResult; readonly issued: boolean }> {
  const { bot, ledger, signal, operation, token, deadlineMs } = options;
  if (signal.aborted) return { result: { kind: "cancelled" }, issued: false };
  using resources = new DisposableStack();
  const expectations = options.targets.map((target) => ledger.expect({ ...target, token, operation: operation.kind, deadlineMs }));
  for (const expectation of expectations) resources.defer(() => expectation.detach());
  const stopped = new AbortController();
  const cancelled = new Promise<{ kind: "cancelled" }>((resolve) => {
    const abort = () => resolve({ kind: "cancelled" });
    signal.addEventListener("abort", abort, { once: true });
    resources.defer(() => signal.removeEventListener("abort", abort));
  });
  const expired = new Promise<{ kind: "expired" }>((resolve) => {
    const timer = setTimeout(() => {
      ledger.expire(deadlineMs);
      resolve({ kind: "expired" });
    }, Math.max(0, deadlineMs - Date.now()));
    resources.defer(() => clearTimeout(timer));
  });
  const effect = bot.startEffect(operation, token, AbortSignal.any([signal, stopped.signal]));
  const completion = effect.completion.catch((cause: unknown) => ({
    kind: "failed" as const,
    observation: cause instanceof Error ? cause.message : String(cause),
  }));
  const mutations = Promise.all(expectations.map((expectation) => expectation.result));
  try {
    const result = await Promise.race([
      Promise.all([completion, mutations]).then(([finished, changes]): WorldEffectResult =>
        finished.kind === "failed"
          ? { kind: "effect_failed", observation: finished.observation }
          : changes.find((change) => change.kind !== "confirmed") ?? changes[0]!,
      ),
      completion.then((finished): WorldEffectResult | Promise<never> =>
        finished.kind === "failed"
          ? { kind: "effect_failed", observation: finished.observation }
          : new Promise<never>(() => {}),
      ),
      ...expectations.map((expectation) => expectation.result.then((change) =>
        change.kind === "confirmed" ? new Promise<never>(() => {}) : change,
      )),
      cancelled,
      expired,
      ...(options.invalidated ? [options.invalidated] : []),
    ]);
    if (result.kind !== "confirmed") {
      // Stop pending preparation as well as an already issued dig. Cancellation
      // requests release; the completion promise establishes physical release.
      stopped.abort(result.kind);
      effect.cancel();
      await drained(completion);
    }
    return { result, issued: effect.issued };
  } finally {
    if (effect.issued) for (const expectation of expectations) expectation.markIssued();
  }
}
