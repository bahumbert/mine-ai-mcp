import type { Bot } from "mineflayer";
import { serverPacedSignal, type ServerPacedSignal } from "../../src/world/server-paced.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../tests/minecraft/drivers/server-ticks.ts";

/** Server ticks a cancelled hunt gets to settle: the old 10 wall seconds as game time at 20 tps, 20 s at 10 tps. */
const SETTLE_TICKS = 200;

/**
 * Settle a reconsideration hunt after proof or a fixture failure. A hunt that ignores its cancellation fails after
 * `SETTLE_TICKS` server ticks, or when the server's clock stops (the shared server-paced budget's bounds).
 */
export async function settleReconsiderationHunt<T>(
  hunt: Promise<T>, child: AbortController, failure: Promise<never>, bot: Pick<Bot, "time">,
): Promise<T> {
  let budget: ServerPacedSignal | undefined;
  let startBudget = () => {};
  const timeout = new Promise<never>((_, reject) => {
    startBudget = () => {
      budget = serverPacedSignal(bot, SETTLE_TICKS, { stoppedMs: DRIVER_CLOCK_STOPPED_MS });
      budget.signal.addEventListener("abort", () => reject(new Error("hunt did not settle after cancel")), { once: true });
    };
    if (child.signal.aborted) startBudget(); else child.signal.addEventListener("abort", startBudget, { once: true });
  });
  const failed = failure.catch((reason: unknown) => {
    child.abort(reason);
    return { reason };
  });
  try {
    const result = await Promise.race([hunt.then((value) => ({ value })), failed, timeout]);
    if ("value" in result) return result.value;
    await Promise.race([hunt.then(() => {}, () => {}), timeout]);
    throw result.reason;
  } finally {
    child.signal.removeEventListener("abort", startBudget);
    budget?.[Symbol.dispose]();
  }
}
