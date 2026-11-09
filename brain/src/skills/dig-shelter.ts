// The model-callable shelter skill supplies objective, memory and liveness context to the shelter flow.
import type { Step } from "../actions.ts";
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
    dayCame: async () => (await context.runtime.status()).clock?.phase !== "night",
    onHole: context.rememberShelter,
  }, step);
}
