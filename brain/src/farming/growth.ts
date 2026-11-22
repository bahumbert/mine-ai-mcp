// A farm's growth stage from a `tend_crops` reading, and the words for it (stage and dry farmland).
import type { FarmState, KnownFarm } from "../memory.ts";

/** See facts/farming.md "Where crops grow" (T1); 128 to the farm middle's chunk centre, unmeasured. */
export const GROWTH_REACH = 128;
/** A longer gap between position readings may hide a trip away; that interval is unknown, never near. */
export const READING_GAP_MS = 120_000;

/** Minutes sampled near a farm, unknown, and elapsed since its last tend in this process. */
export interface Near {
  readonly near: number;
  readonly unknown: number;
  readonly since: number;
}

/** Measures growth before harvesting against the previous after-reading; incomplete intervals keep the old pace. */
export function nextPace(previous: KnownFarm | undefined, beforeStage: number | null, near: Near | null): number | undefined {
  const stage = previous?.state.stage;
  if (previous?.paceFresh === false || stage === undefined || beforeStage === null || near === null || near.unknown > 0 || near.near < 1 || beforeStage < stage) return previous?.pace;
  return (beforeStage - stage) / near.near;
}

/** Remaining near-minutes at the measured pace; a zero pace gives no finite ripe estimate. */
export function ripeInNearMinutes(farm: KnownFarm, near: Near | null): number | null {
  const { stage, ripeAge } = farm.state;
  if (farm.pace === undefined || farm.pace <= 0 || stage === undefined || ripeAge === undefined || near === null) return null;
  return (ripeAge - stage) / farm.pace - near.near;
}

/** The observed stage at the tend and the time sampled near it, shared by the hint and known place. */
export function describeNearTend(farm: KnownFarm, minutesSince: number, near: Near | null): string {
  const { stage, ripeAge } = farm.state;
  const growth = stage === undefined || ripeAge === undefined ? "" : `stage ${stage.toFixed(1)}/${ripeAge}; `;
  const time = near === null ? "near time unknown" : `near ${Math.round(near.near)} min${near.unknown > 0 ? ` (${Math.round(near.unknown)} min unknown)` : ""}`;
  return `${growth}tend ${minutesSince} min ago; ${time}`;
}

/** Growth since a tend, qualified by the pace actually seen rather than a promised growth rate. */
export function describeGrowthSince(farm: KnownFarm, minutesSince: number, near: Near | null): string {
  const observed = describeNearTend(farm, minutesSince, near);
  if (near === null) return observed;
  if (farm.pace === 0) return `${observed}; seen pace 0; ripe time unknown`;
  const remaining = ripeInNearMinutes(farm, near);
  if (remaining === null) return `${observed}; pace unknown`;
  if (remaining <= 0) return `${observed}; seen pace: ripe now`;
  return `${observed}; seen pace ${(farm.pace! * 10).toFixed(1)} stages/10 near-min; ripe in ~${Math.round(remaining)} more near-min`;
}

/**
 * A farm's growth stage from one `tend_crops` reading: the mean age of the cells holding `block` (the farm's own crop;
 * keys `<block> age <n>`, ` ripe` appended when ripe: src/actions/tend-crops/contract.ts `after.crops`), over the
 * cells the tend read. Null when none of its cells stands or the runtime reported no ripe age (an older runtime).
 */
export function cropStage(crops: Readonly<Record<string, number>>, ripeAge: number | undefined, block: string): { readonly stage: number; readonly ripeAge: number } | null {
  if (ripeAge === undefined) return null;
  const prefix = `${block} age `;
  let cells = 0;
  let ages = 0;
  for (const [key, count] of Object.entries(crops)) {
    if (!key.startsWith(prefix)) continue;
    const age = /^(\d+)(?: ripe)?$/u.exec(key.slice(prefix.length))?.[1];
    if (age === undefined) continue;
    cells += count;
    ages += Number(age) * count;
  }
  return cells === 0 ? null : { stage: ages / cells, ripeAge };
}

/**
 * The growth part of a farm's sentence: `at stage 3.0 of 7`, then the dry farmland (crops on it grow slower; the 4
 * blocks of water reach: game rule, unmeasured). Empty without a stage and without dry farmland.
 */
export function describeStage(state: FarmState): string {
  const parts: string[] = [];
  if (state.stage !== undefined && state.ripeAge !== undefined) parts.push(`at stage ${state.stage.toFixed(1)} of ${state.ripeAge}`);
  if (state.dry !== undefined && state.dry > 0) parts.push(`${state.dry} dry farmland (grows slower; water within 4 blocks hydrates it)`);
  return parts.join(", ");
}
