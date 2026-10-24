/** The push of a hand's hit on a mob with no AI, and its velocity decaying by 0.98 a tick to zero, 12 s after the hit (what the client hears: `knockback-scene.ts`). */
import type { ContractCheck } from "../checks.ts";
import { DECAY_TRIAL, knockbackFixture, runKnockbackTrials } from "./knockback-scene.ts";

const TRIALS = [DECAY_TRIAL];

export const attackMobKnockbackDecay: ContractCheck = {
  name: "attack-mob-knockback-decay",
  fixture: knockbackFixture(TRIALS),
  withoutRuntime: true,
  run: (subject) => runKnockbackTrials(subject, TRIALS),
};
