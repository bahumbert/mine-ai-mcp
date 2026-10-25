/** The push of a hit with a sword on a mob with no AI, on the diagonal and with a wall behind it (what the client hears: `knockback-scene.ts`). */
import type { ContractCheck } from "../checks.ts";
import { DIAGONAL_TRIAL, WALL_CELLS, WALL_TRIAL, knockbackFixture, runKnockbackTrials } from "./knockback-scene.ts";

const TRIALS = [DIAGONAL_TRIAL, WALL_TRIAL];

export const attackMobKnockback: ContractCheck = {
  name: "attack-mob-knockback",
  fixture: knockbackFixture(TRIALS, WALL_CELLS),
  withoutRuntime: true,
  run: (subject) => runKnockbackTrials(subject, TRIALS),
};
