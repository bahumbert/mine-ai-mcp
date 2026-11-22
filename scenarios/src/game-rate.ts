// Judges native loot against the world-age span rather than the server's wall-clock speed.

/** Surplus loot cannot make a requested collection look faster than it was. */
export function dropsPerGameMinute(gained: number, requested: number, startAge: number, endAge: number): number {
  return Math.min(gained, requested) * 1_200 / Math.max(1, endAge - startAge);
}

/** Require the requested loot and its game-time rate, with an observed world age at both ends. */
export function judgeDrops(options: {
  readonly gained: number;
  readonly requested: number;
  readonly startAge: number | null;
  readonly endAge: number | null;
  readonly minimumPerMinute: number;
}) {
  const { gained, requested, startAge, endAge, minimumPerMinute } = options;
  if (startAge === null || endAge === null)
    return { passed: false, dropsPerMinute: null, elapsedTicks: null, reason: "no world age heard" } as const;
  const dropsPerMinute = dropsPerGameMinute(gained, requested, startAge, endAge);
  return { passed: gained >= requested && dropsPerMinute >= minimumPerMinute,
    dropsPerMinute, elapsedTicks: endAge - startAge, reason: null } as const;
}
