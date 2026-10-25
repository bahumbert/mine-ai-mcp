/** The push of a sprinting hit (0.7 in all, the sprint spent by it) and of a hit on a mob with AI (what the client hears: `knockback-scene.ts`). */
import type { ContractCheck } from "../checks.ts";
import { AI_TRIAL, SPRINT_TRIAL, knockbackFixture, runKnockbackTrials } from "./knockback-scene.ts";

const TRIALS = [SPRINT_TRIAL, AI_TRIAL];

export const attackMobKnockbackSprint: ContractCheck = {
  name: "attack-mob-knockback-sprint",
  fixture: knockbackFixture(TRIALS),
  withoutRuntime: true,
  run: (subject) => runKnockbackTrials(subject, TRIALS),
};
