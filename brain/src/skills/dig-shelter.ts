// The model-callable shelter skill supplies objective, memory and liveness context to the shelter flow.
import type { Step } from "../actions.ts";
import { BEDTIME_START_TICK, DUSK_FROM_TICK } from "../agent/situations.ts";
import { digShelterFlow } from "../shelter/dig-in.ts";
import type { SkillContext, SkillResult } from "../skills.ts";

/** Dig in when asked, protecting the objective's materials and remembering the finished hole. */
export async function digShelter(context: SkillContext, step: Extract<Step, { skill: "dig_shelter" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  return digShelterFlow({
    runtime: context.runtime,
    body: context.body,
    signal: context.signal,
    areas: context.areas ?? [],
    needed: context.needed?.(snapshot),
    alive: context.alive,
    dayCame: async () => {
      const clock = (await context.runtime.status()).clock;
      const evening = clock?.timeOfDay !== undefined && clock.timeOfDay >= DUSK_FROM_TICK && clock.timeOfDay < BEDTIME_START_TICK;
      return clock?.phase !== "night" && !evening;
    },
    onHole: context.rememberShelter,
  }, step);
}
