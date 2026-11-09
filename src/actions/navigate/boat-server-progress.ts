// Server-paced boat movement and monotonic progress bounds shared by rowing legs.
import type { Bot } from "mineflayer";
import { waitForWorldAge } from "../../world/world-age.js";

export const BOAT_PROGRESS_WALL_MS = 10_000;
/** Time packets cover twenty server ticks: never send more than that many steps without another age. */
const STEPS_PER_TIME_PACKET = 20;

export interface BoatStepCredit {
  age: number | undefined;
  steps: number;
}

/** Keep at most one time packet's worth of moves ahead of the server, including when its ticks stop. */
export async function waitForBoatStep(bot: Bot, credit: BoatStepCredit, stopped: () => boolean): Promise<boolean> {
  const age = bot.time?.age;
  if (age !== credit.age) {
    credit.age = age;
    credit.steps = 0;
  }
  if (credit.steps >= STEPS_PER_TIME_PACKET) {
    const answer = await waitForWorldAge(bot, 1, { wallMs: BOAT_PROGRESS_WALL_MS, until: stopped });
    if (answer !== "moved") return false;
    credit.age = bot.time?.age;
    credit.steps = 0;
  }
  credit.steps += 1;
  return !stopped();
}

/** A leg must gain new ground within its window; oscillating corrections do not renew it. */
export class BoatLegProgress {
  #best = 0;
  #gainedAt = performance.now();

  stalled(distance: number): boolean {
    if (distance > this.#best + 0.01) {
      this.#best = distance;
      this.#gainedAt = performance.now();
    }
    return performance.now() - this.#gainedAt >= BOAT_PROGRESS_WALL_MS;
  }
}
