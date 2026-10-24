/**
 * The contract checks: each states one answer of Mineflayer and a 1.21.4 server, runs on the shared fake
 * (`bot-contract.test.ts`) and on the real server (`drivers/bot-contract.ts`), so the fake can only say what the game says.
 */
import type { FakeCell, Weather } from "../../../src/test-support/fake-bot/index.ts";
import type { ContractSubject } from "./subject.ts";
import { attackCooldownDamage } from "./checks/attack-cooldown-damage.ts";
import { attackHurtsAndKills } from "./checks/attack-hurts-and-kills.ts";
import { attackOutOfReach } from "./checks/attack-out-of-reach.ts";
import { attackMobKnockback } from "./checks/attack-mob-knockback.ts";
import { attackMobKnockbackDecay } from "./checks/attack-mob-knockback-decay.ts";
import { attackMobKnockbackSprint } from "./checks/attack-mob-knockback-sprint.ts";
import { weaponDamageAxes } from "./checks/weapon-damage-axes.ts";
import { weaponDamagePickaxes } from "./checks/weapon-damage-pickaxes.ts";
import { weaponDamageShovelsHoes } from "./checks/weapon-damage-shovels-hoes.ts";
import { weaponDamageSwords } from "./checks/weapon-damage-swords.ts";
import { projectileHitBot } from "./checks/projectile-hit-bot.ts";
import { deflectFireball } from "./checks/deflect-fireball.ts";
import { bowDrawAndRelease } from "./checks/bow-draw-and-release.ts";
import { consumeFood } from "./checks/consume-food.ts";
import { damageEventToBot } from "./checks/damage-event-to-bot.ts";
import { explosionKnockback } from "./checks/explosion-knockback.ts";
import { shieldRaised } from "./checks/shield-raised.ts";
import { unequipHand } from "./checks/unequip-hand.ts";
import { airSupplyUnderWater } from "./checks/air-supply-under-water.ts";
import { bedRefusedMonsterNear } from "./checks/bed-refused-monster-near.ts";
import { bedSleepAndWake } from "./checks/bed-sleep-and-wake.ts";
import { boatDismountIgnored } from "./checks/boat-dismount-ignored.ts";
import { boatFollowsVehicleMove } from "./checks/boat-follows-vehicle-move.ts";
import { boatGetOffByShift } from "./checks/boat-get-off-by-shift.ts";
import { bucketPourAndFill } from "./checks/bucket-pour-and-fill.ts";
import { chestOpenTakeClose } from "./checks/chest-open-take-close.ts";
import { clickWindowHotbarSwap } from "./checks/click-window-hotbar-swap.ts";
import { clickWindowShiftMove } from "./checks/click-window-shift-move.ts";
import { clickWindowOntoVariant } from "./checks/click-window-onto-variant.ts";
import { clickWindowVariantSplit } from "./checks/click-window-variant-split.ts";
import { variantTransferClicks } from "./checks/variant-transfer-clicks.ts";
import { boatBrokenByAttack } from "./checks/boat-broken-by-attack.ts";
import { boatMountRefused } from "./checks/boat-mount-refused.ts";
import { boatPlacedByUse } from "./checks/boat-placed-by-use.ts";
import { boatShiftWithinOneTick } from "./checks/boat-shift-within-one-tick.ts";
import { columnsHoldCells } from "./checks/columns-hold-cells.ts";
import { digTimeAndUpdate } from "./checks/dig-time-and-update.ts";
import { equipHandAndOffHand } from "./checks/equip-hand-and-off-hand.ts";
import { findBlocksMatching } from "./checks/find-blocks-matching.ts";
import { lavaOverHole } from "./checks/lava-over-hole.ts";
import { lavaOverPassable } from "./checks/lava-over-passable.ts";
import { itemPickupAfterDelay } from "./checks/item-pickup-after-delay.ts";
import { tossedItemKeptBeforeDelay } from "./checks/tossed-item-kept-before-delay.ts";
import { itemsMatchSlots } from "./checks/items-match-slots.ts";
import { itemVariantComponents } from "./checks/item-variant-components.ts";
import { placeBlockWithOptions } from "./checks/place-block-with-options.ts";
import { placementBlockUpdate } from "./checks/placement-block-update.ts";
import { rainAndThunderState } from "./checks/rain-and-thunder-state.ts";
import { stateIdAgrees } from "./checks/state-id-agrees.ts";
import { stopDiggingBothWindows } from "./checks/stop-digging-both-windows.ts";
import { thinBlockShapes } from "./checks/thin-block-shapes.ts";
import { tossCountAndEntity } from "./checks/toss-count-and-entity.ts";
import { waitForTicksAndAge } from "./checks/wait-for-ticks-and-age.ts";
import { worldAgePerSecond } from "./checks/world-age-per-second.ts";

type Cell = readonly [number, number, number];

/**
 * The world a check starts in, in arena-local coordinates (a check reaches the world position through `subject.world`), the same on both sides: a stone floor at y -61 (the fake's ground, `setupCommands` on
 * the server), open air above it, these cells, the carried stacks, the bot's feet and the entities summoned.
 */
export interface ContractFixture {
  /** `"x,y,z"` to the block there, inside the arena (`setup-commands.ts` `ARENA`). */
  readonly cells: Readonly<Record<string, FakeCell>>;
  /** Item name to the number given, in this order (hotbar first, as `give` fills it). */
  readonly carried: Readonly<Record<string, number>>;
  /** The stacks in the container block at a cell of `cells`, from slot 0 in this order (`item replace block ... container.<i>`); a name of `ITEM_VARIANTS` stands for that variant (its command text on the server). */
  readonly containers?: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** The bot's feet, on the floor. */
  readonly position: Cell;
  /** The day time set before the check (`time set`); the template's world stands at noon. */
  readonly timeOfDay?: number;
  /** The difficulty set before the check; a fixture with a hostile mob is on easy, the template's world is not set. */
  readonly difficulty?: "easy" | "normal" | "hard";
  /** Whether the day cycle runs: the template stops it, and a night is skipped only by a world whose time runs. */
  readonly daylightCycle?: boolean;
  /** The weather set before the check; the template's world is clear. */
  readonly weather?: Weather;
  /**
   * `nbt` is the raw SNBT the server summons the entity with (Mine Labs `entities[].nbt`); the fake does not read it.
   * `passengers` are entities (by name) that ride it from the start, on both sides: the server gets them as `Passengers` nbt.
   */
  readonly entities?: readonly { readonly name: string; readonly position: Cell; readonly nbt?: string; readonly passengers?: readonly string[] }[];
}

export interface ContractCheck {
  readonly name: string;
  readonly fixture: ContractFixture;
  /** Throws (`node:assert`) with the disagreement; resolves when the subject answered as the game does. */
  run(subject: ContractSubject): Promise<void>;
  /** Run on the bare bot, with no runtime of ours to act on it (`client-host.ts --without-runtime`). */
  readonly withoutRuntime?: boolean;
  /**
   * Set when the subject changes something the whole server has (a game rule, the weather) while the check runs: the YAML is tagged
   * `exclusive` so the scenario gets a server of its own and never a lane of a shared one, where every other lane would see the change. The value is the reason.
   */
  readonly exclusive?: string;
  /**
   * Set while the shared fake cannot yet answer what the check measures (it grows only from measurements): `bot-contract.test.ts`
   * skips the check on the fake with this reason, and the real server runs it. Removed once the fake answers.
   */
  readonly waitsForFake?: string;
}

export const CONTRACT_CHECKS: readonly ContractCheck[] = [
  worldAgePerSecond,
  waitForTicksAndAge,
  thinBlockShapes,
  stateIdAgrees,
  itemsMatchSlots,
  equipHandAndOffHand,
  tossCountAndEntity,
  placementBlockUpdate,
  digTimeAndUpdate,
  stopDiggingBothWindows,
  boatGetOffByShift,
  boatDismountIgnored,
  boatPlacedByUse,
  boatFollowsVehicleMove,
  boatBrokenByAttack,
  boatShiftWithinOneTick,
  boatMountRefused,
  columnsHoldCells,
  findBlocksMatching,
  airSupplyUnderWater,
  bedSleepAndWake,
  bedRefusedMonsterNear,
  rainAndThunderState,
  clickWindowHotbarSwap,
  clickWindowShiftMove,
  clickWindowOntoVariant,
  clickWindowVariantSplit,
  variantTransferClicks,
  chestOpenTakeClose,
  itemVariantComponents,
  itemPickupAfterDelay,
  tossedItemKeptBeforeDelay,
  attackCooldownDamage,
  attackHurtsAndKills,
  attackOutOfReach,
  bowDrawAndRelease,
  consumeFood,
  damageEventToBot,
  explosionKnockback,
  shieldRaised,
  unequipHand,
  deflectFireball,
  projectileHitBot,
  weaponDamageSwords,
  weaponDamageAxes,
  weaponDamagePickaxes,
  weaponDamageShovelsHoes,
  attackMobKnockback,
  attackMobKnockbackDecay,
  attackMobKnockbackSprint,
  bucketPourAndFill,
  placeBlockWithOptions,
  lavaOverHole,
  lavaOverPassable,
];

/** The check of that name; throws listing the known names. */
export function contractCheckNamed(name: string): ContractCheck {
  const check = CONTRACT_CHECKS.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no contract check '${name}': ${CONTRACT_CHECKS.map(({ name }) => name).join(", ")}`);
  return check;
}
