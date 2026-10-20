// What counts as progress for a reflex that holds the body: marks the claim's no-progress limit reads.
import type { Bot } from "mineflayer";
import { onBodyTick } from "../../runtime/body-ticks.js";
import { AnchorTravel } from "../../session/anchor-travel.js";
import { isInWater } from "../perception/body.js";

/** Counts what a claim's probes saw (a block travelled, health changed, a hazard left); the runner reads `marks`. */
export class ReflexProgress {
  #marks = 0;
  #lastReason: string | null = null;

  /** Bound, so a probe takes `progress.mark` as its callback. */
  readonly mark = (reason: string): void => {
    this.#marks++;
    this.#lastReason = reason;
  };

  get marks(): number {
    return this.#marks;
  }

  /** The latest probe's reason, for the outcome a limit reports; null while nothing made progress. */
  get lastReason(): string | null {
    return this.#lastReason;
  }
}

/**
 * The base probe of every claim: the body travelled (a block horizontally, or two vertically out of water, as
 * `AnchorTravel` counts it: the bob of a swimmer is not travel), its health changed (damage taken or healing: the
 * server answered), or it died. Returns the detach.
 */
export function observeBodyProgress(bot: Bot, mark: (reason: string) => void): () => void {
  const travel = new AnchorTravel();
  let health = bot.health;
  const sample = () => {
    // Between a respawn and the next position packet the bot has no entity: nothing to measure then.
    const position = (bot.entity as Bot["entity"] | undefined)?.position;
    if (position && travel.add(position, isInWater(bot)) > 0) mark("moved");
  };
  const onHealth = () => {
    if (bot.health === health) return;
    health = bot.health;
    mark("health_changed");
  };
  const onDeath = () => mark("died");
  sample();
  const stopTicks = onBodyTick(bot, sample);
  bot.on("health", onHealth);
  bot.on("death", onDeath);
  return () => {
    stopTicks();
    bot.off("health", onHealth);
    bot.off("death", onDeath);
  };
}

/**
 * A sampler that says true at the sample where `read` turned true, then false until it was false in between. The
 * first sample only takes the baseline: nothing is read when the sampler is made, so a probe cannot fail the claim.
 */
export function turnsTrue(read: () => boolean): () => boolean {
  let before: boolean | null = null;
  return () => {
    const now = read();
    const turned = now && before === false;
    before = now;
    return turned;
  };
}

/** A sampler that says true when `read` returns more than at the previous reading; no reading is no rise. */
export function risesOver(read: () => number | null): () => boolean {
  let before: number | null | undefined;
  return () => {
    const now = read();
    if (now === null) return false;
    const rose = typeof before === "number" && now > before;
    before = now;
    return rose;
  };
}

/** A sampler that says true when `read` returns less than at the previous reading (a count that was spent). */
export function fallsUnder(read: () => number | null): () => boolean {
  return risesOver(() => {
    const value = read();
    return value === null ? null : -value;
  });
}

/**
 * A sampler that says true once `read` has gone up `blocks` from the lowest value since the last true: a net climb
 * (a swimmer rising toward air), where the bob of a wave adds nothing because the anchor only ever moves down.
 */
export function climbsBy(read: () => number, blocks: number): () => boolean {
  let lowest: number | undefined;
  return () => {
    const now = read();
    lowest ??= now;
    if (now - lowest >= blocks) {
      lowest = now;
      return true;
    }
    lowest = Math.min(lowest, now);
    return false;
  };
}

/**
 * A reflex's own probes: each body tick every sampler runs, and `mark(name)` is called for the ones that say true.
 * A sampler that throws (a chunk unloaded under the read) counts as no progress and does not stop the others.
 */
export function watchBodyTicks(
  bot: Bot,
  mark: (reason: string) => void,
  samplers: Readonly<Record<string, () => boolean>>,
): () => void {
  return onBodyTick(bot, () => {
    for (const [reason, sampler] of Object.entries(samplers)) {
      try {
        if (sampler()) mark(reason);
      } catch {
        // An unreadable world is not progress.
      }
    }
  });
}
