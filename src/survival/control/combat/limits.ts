// Bounds shared by a hostile fight and its missing-target release.
import type { TickLimits } from "../contract.js";

/**
 * A combat claim lasts at most 12 000 world ticks (ten minutes at 20 tps), or 600 without progress (thirty seconds);
 * its first stand-down is 200 ticks (ten seconds).
 */
export const COMBAT_LIMITS: TickLimits = { ceilingTicks: 12_000, noProgressTicks: 600, standDownTicks: 200 };
