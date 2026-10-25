// The movement policy, early-commit limits and overshooting bot the navigation-run test files share.
import type { PlannedStep } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import { FakeNavigationBot } from "../../test-support/navigation.js";

export const walking = () => createMovementPolicy({ allowSprinting: false });

/** Commit as soon as there is a segment worth walking, so a run is made of continuations rather than one route. */
export const EARLY_COMMIT = { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 } as const;

export class OvershootingBot extends FakeNavigationBot {
  first = true;
  constructor(readonly overshoot = 1) {
    super();
  }
  override async prepareMovement(step: PlannedStep) {
    const arrival = this.first ? { ...step.to, x: step.to.x + this.overshoot } : step.to;
    this.first = false;
    this.arrive(arrival);
    return { kind: "completed", arrival } as const;
  }
}
