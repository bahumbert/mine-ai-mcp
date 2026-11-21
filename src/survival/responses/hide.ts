import type { Bot } from "mineflayer";
import { monotonicNow } from "../../utils/index.js";
import { PHYSICS_TICK_WALL_MS, waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { fireContactCells } from "../perception/body.js";
import { extinguishFireAt } from "../positioning/fire-clearance.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { recoverUnderCover, type CoveredRecovery } from "./recover.js";
import {
  blockedCellsText,
  holdShelterGuard,
  type HideOptions,
  repelShelterIntruder,
  type ShelterBuild,
  shelterBlocks,
  shelterHazard,
  shelterLiquidFailure,
} from "./shelter-build.js";
import { enclosedInPlace, marginCells, shelterFeet, shelterIntruder } from "./shelter-cells.js";
import { constructShelterPass, type MarginPass, sealMarginCells } from "./shelter-construction.js";
import { describeShelterRefusal, type ShelterRefusal } from "./shelter-refusal.js";

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
  /** The bot was already in a closed cell, so nothing was dug or walled. */
  readonly enclosed: boolean;
  /** The projectile margin pass after the shell, D9b: its blocks are not in `walled`. */
  readonly margin: MarginPass;
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
  | { readonly kind: "held" | "failed"; readonly error: string; readonly refusal?: ShelterRefusal };
export type HideResult = HideEvidence & HideConclusion;

function startShelterBuild(bot: Bot, options: HideOptions): ShelterBuild {
  const build: ShelterBuild = {
    bot,
    options,
    itemUse: new CombatItemUse(bot, (ticks, wallEnd) => holdShelterGuard(build, ticks, undefined, wallEnd)),
    enclosed: enclosedInPlace(bot, options.blockNames),
    constructionDeadline: monotonicNow() + options.maximumMs,
    dug: 0,
    walled: 0,
    capped: false,
    ate: null,
    swings: 0,
    recovery: null,
    refusal: null,
    pass: 0,
    blockedCells: new Map(),
  };
  return build;
}

/** The margin pass of a hide that ended before the shell stood: nothing was sealed. */
const noMargin = (): MarginPass => ({ placed: 0, ticks: 0, skipped: [] });

function concludeHide(build: ShelterBuild, conclusion: HideConclusion, margin: MarginPass = noMargin()): HideResult {
  const { bot } = build;
  if ((bot.health <= 0 || build.options.signal.aborted) && "refusal" in conclusion) {
    const { refusal: _refusal, ...withoutRefusal } = conclusion;
    conclusion = withoutRefusal;
  }
  return {
    recovery: build.recovery,
    dug: build.dug,
    walled: build.walled,
    capped: build.capped,
    enclosed: build.enclosed,
    margin,
    ate: build.ate,
    swings: build.swings,
    healthAfter: bot.health,
    hungerAfter: bot.food,
    ...conclusion,
  };
}

/**
 * What a projectile refusal adds: the margin cells still open around the whole shell (the ones a shot can cross before the
 * wall) and the blocks left to fill them, so the caller sees a shelter missing blocks rather than a shell with a hole. Empty
 * for any other cause and when no margin cell is open.
 */
function openMarginText(build: ShelterBuild, cause: string): string {
  if (cause !== "projectile") return "";
  const open = marginCells(build.bot, shelterFeet(build.bot), null);
  return open.length === 0 ? "" : `; open margin cells: ${open.map(({ x, y, z }) => `${x},${y},${z}`).join("; ")} (${shelterBlocks(build)} blocks left)`;
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
    // The shelter is closed around the bot, so a fire in its cell is dug out here (the sealed-refuge rule of `fire.ts`).
    extinguish: (cell) => extinguishFireAt(bot, cell, options.signal, true),
    defendIntruder: async () => {
      const intruder = shelterIntruder(bot, threatContext);
      if (intruder) await repelShelterIntruder(build, intruder);
    },
    releaseItemUse: () => itemUse.lowerShield(),
    // Bounded in real time: physics that stopped ends the hold `unavailable` instead of waiting for ever (D33).
    wait: (ticks) => waitForPhysicsTicks(bot, ticks, options.signal, { wallMs: PHYSICS_TICK_WALL_MS * ticks }),
  });
  build.recovery = recovery;
  build.ate = recovery.ate;
  switch (recovery.kind) {
    case "exposed":
      return { kind: "failed", error: `The shelter became exposed or unsafe during recovery (${recovery.cause})${openMarginText(build, recovery.cause)}.`,
        refusal: describeShelterRefusal(build, "exposed", { hazard: shelterHazard(build) ?? recovery.cause }) };
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
 *
 * Built or found, the closed shell is then widened by the margin pass (`sealMarginCells`): the open cells the body box
 * expanded by the projectile hit margin overlaps, while a spare shell's worth of blocks stays carried, so the recovery's
 * projectile test does not refuse a shell whose gaps only a diagonal shot could use. Its receipt is the result's `margin`.
 */
export async function hideInPlace(bot: Bot, options: HideOptions): Promise<HideResult> {
  const build = startShelterBuild(bot, options);
  using _releaseGuard = { [Symbol.dispose]: () => build.itemUse.lowerShield() };
  bot.clearControlStates();
  bot.deactivateItem();
  const inLiquid = shelterLiquidFailure(bot);
  if (inLiquid) return concludeHide(build, { ...inLiquid, refusal: describeShelterRefusal(build, "liquid") });
  while (!build.enclosed) {
    const pass = await constructShelterPass(build);
    if (pass === "again") continue;
    if (pass === "built") break;
    return concludeHide(build, pass);
  }
  if (!enclosedInPlace(bot, options.blockNames)) {
    const open = blockedCellsText(build);
    return concludeHide(build, {
      kind: "failed",
      refusal: describeShelterRefusal(build, "open"),
      error: `The shelter is still open${build.refusal ? `: ${build.refusal}` : open ? `: ${open}` : ""}`,
    });
  }
  // A fire in the body's cells is cleared first (as the recovery's own opening does), so the placements do not run in it.
  for (const cell of fireContactCells(bot)) if ((await extinguishFireAt(bot, cell, options.signal, true)) === "blocked") break;
  const margin = await sealMarginCells(build);
  return concludeHide(build, await recoverInShelter(build), margin);
}
