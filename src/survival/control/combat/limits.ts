// Bounds shared by a hostile fight and its missing-target release.
import type { ReflexLimits } from "../contract.js";

/** A combat claim lasts at most ten minutes, or thirty seconds without progress; its first stand-down is ten seconds. */
export const COMBAT_LIMITS: ReflexLimits = { ceilingMs: 600_000, noProgressMs: 30_000, standDownMs: 10_000 };
