import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { recoverUnderCover, type CoveredRecovery } from "./recover.js";
import {
  holdShelterGuard,
  type HideOptions,
  repelShelterIntruder,
  type ShelterBuild,
  shelterHazard,
  shelterLiquidFailure,
} from "./shelter-build.js";
import { enclosedInPlace, shelterIntruder } from "./shelter-cells.js";
import { constructShelterPass } from "./shelter-construction.js";

export { enclosedInPlace } from "./shelter-cells.js";
export type { HideOptions } from "./shelter-build.js";
export { HIDE_DEPTH, WALL_IN_BLOCKS } from "./shelter-construction.js";

interface HideEvidence {
  readonly recovery: CoveredRecovery | null;
  /** `recovered` or `held` only inside a closed shelter; `failed` when the shelter could not be completed. */

  readonly dug: number;
  /** Blocks placed around the bot: cover toward the threats, and the ring when the ground could not be dug. */
  readonly walled: number;
  /** Whether this hide placed the block over the bot's head. */
  readonly capped: boolean;
  /** The bot was already in a closed cell, so nothing was dug or placed and nothing needed to be. */
  readonly enclosed: boolean;
  readonly ate: string | null;
  /** Swings at authorized threats occupying the body or shelter shell. */
  readonly swings: number;
  readonly healthAfter: number;
  readonly hungerAfter: number;
}

type HideConclusion =
  | {
      readonly kind: "recovered";
      readonly recovery: Extract<CoveredRecovery, { kind: "recovered" }>;
      readonly error?: never;
    }
  | { readonly kind: "held" | "failed"; readonly error: string };
export type HideResult = HideEvidence & HideConclusion;

function startShelterBuild(bot: Bot, options: HideOptions): ShelterBuild {
  const build: ShelterBuild = {
    bot,
    options,
    itemUse: new CombatItemUse(bot, (ticks) => holdShelterGuard(build, ticks)),
    enclosed: enclosedInPlace(bot, options.blockNames),
    constructionDeadline: Date.now() + options.maximumMs,
    dug: 0,
    walled: 0,
    capped: false,
    ate: null,
    swings: 0,
    recovery: null,
    refusal: null,
  };
  return build;
}

function concludeHide(build: ShelterBuild, conclusion: HideConclusion): HideResult {
  const { bot } = build;
  return {
    recovery: build.recovery,
    dug: build.dug,
    walled: build.walled,
    capped: build.capped,
    enclosed: build.enclosed,
    ate: build.ate,
    swings: build.swings,
    healthAfter: bot.health,
    hungerAfter: bot.food,
    ...conclusion,
  };
}

/** Heal inside the finished shelter, defending the shell, until health is back or the hold ends. */
async function recoverInShelter(build: ShelterBuild): Promise<HideConclusion> {
  const { bot, options, itemUse } = build;
  const { threatContext } = options;
  itemUse.lowerShield();
  const recovery = await recoverUnderCover(bot, {
    signal: options.signal,
    recoverTo: options.recoverTo,
    maximumMs: options.maximumMs,
    survival: threatContext.survival,
    policy: () => ({ combat: threatContext.policy, food: threatContext.food }),
    isProtected: () => enclosedInPlace(bot, options.blockNames) && shelterHazard(build) === null,
    holdWhile: options.holdWhile,
    defendIntruder: async () => {
      const intruder = shelterIntruder(bot, threatContext);
      if (intruder) await repelShelterIntruder(build, intruder);
    },
    releaseItemUse: () => itemUse.lowerShield(),
    wait: (ticks) => waitForPhysicsTicks(bot, ticks, options.signal),
  });
  build.recovery = recovery;
  build.ate = recovery.ate;
  switch (recovery.kind) {
    case "exposed":
      return { kind: "failed", error: "The shelter became exposed or unsafe during recovery." };
    case "held":
      return { kind: "held", error: recovery.reason };
    case "recovered":
      return { kind: "recovered", recovery };
  }
}

/**
 * Dig in, or wall in, then eat and wait for health.
 *
 * The first playthrough died six times the same way: the evade could not
 * reach safe separation from three or more mobs in open ground, and the pack
 * finished the bot in the seconds after. A hole is what a player does with
 * two hearts left. Head-height blocks go up toward the nearest threats first,
 * as cover for what follows; then the shaft, each dig checked for solid
 * ground under the next so it never opens into a cave, capped once it has
 * walls; and when the ground will not take a shaft, the ring is finished
 * where the bot stands, with an eave so the cap has something to hold. No
 * placement is allowed to abort the hide: a refused block is a block skipped.
 *
 * A bot already standing in a closed cell is hidden and goes straight to the
 * hold. Without that, every successful hide guaranteed a failing one thirty
 * seconds later: each side already solid, nothing to place, and the runtime
 * reporting its safety net broken from inside a working shelter.
 */
export async function hideInPlace(bot: Bot, options: HideOptions): Promise<HideResult> {
  const build = startShelterBuild(bot, options);
  using _releaseGuard = { [Symbol.dispose]: () => build.itemUse.lowerShield() };
  bot.clearControlStates();
  bot.deactivateItem();
  const inLiquid = shelterLiquidFailure(bot);
  if (inLiquid) return concludeHide(build, inLiquid);
  while (!build.enclosed) {
    const pass = await constructShelterPass(build);
    if (pass === "again") continue;
    if (pass === "built") break;
    return concludeHide(build, pass);
  }
  if (!enclosedInPlace(bot, options.blockNames)) {
    return concludeHide(build, {
      kind: "failed",
      error: `The shelter is still open${build.refusal ? `: ${build.refusal}` : ""}`,
    });
  }
  return concludeHide(build, await recoverInShelter(build));
}
