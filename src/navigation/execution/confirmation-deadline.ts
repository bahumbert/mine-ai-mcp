// Server-tick budgets for confirming route effects and freeing a body pinned beneath a block.
import { SERVER_ANSWER_TICKS } from "../../world/world-age.js";
import { nativeDigTicks } from "../mineflayer/native-dig-clock.js";
import { STANCE_LANDING_TICKS } from "../steering/hold-water-position.js";

const MINIMUM_CONFIRMATION_TICKS = 100;
const PIN_RELEASE_DEADLINE_TICKS = 300;

/** Give landing, digging and its server answer enough ticks, including every falling block. */
export function confirmationTicks(input: {
  readonly expectedTicks: number;
  readonly digMs: number;
  readonly broughtBlocks: number;
}): number {
  const digTicks = nativeDigTicks(input.digMs);
  return Math.max(MINIMUM_CONFIRMATION_TICKS, 2 * Math.max(input.expectedTicks, digTicks),
    STANCE_LANDING_TICKS + digTicks + SERVER_ANSWER_TICKS)
    + (2 * SERVER_ANSWER_TICKS + digTicks) * input.broughtBlocks;
}

/** A pinned body gets at least 300 server ticks to break its ceiling. */
export function pinReleaseTicks(expectedTicks: number): number {
  return Math.max(PIN_RELEASE_DEADLINE_TICKS, 2 * expectedTicks);
}
