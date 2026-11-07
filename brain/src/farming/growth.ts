// A farm's growth stage from a `tend_crops` reading, and the words for it (stage and dry farmland).
import type { FarmState } from "../memory.ts";

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
