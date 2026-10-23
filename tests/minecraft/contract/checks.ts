/**
 * The contract checks: each states one answer of Mineflayer and a 1.21.4 server, runs on the shared fake
 * (`bot-contract.test.ts`) and on the real server (`drivers/bot-contract.ts`), so the fake can only say what the game says.
 */
import type { FakeCell } from "../../../src/test-support/fake-bot/index.ts";
import type { ContractSubject } from "./subject.ts";
import { airSupplyUnderWater } from "./checks/air-supply-under-water.ts";
import { boatDismountIgnored } from "./checks/boat-dismount-ignored.ts";
import { boatGetOffByShift } from "./checks/boat-get-off-by-shift.ts";
import { columnsHoldCells } from "./checks/columns-hold-cells.ts";
import { digTimeAndUpdate } from "./checks/dig-time-and-update.ts";
import { equipHandAndOffHand } from "./checks/equip-hand-and-off-hand.ts";
import { findBlocksMatching } from "./checks/find-blocks-matching.ts";
import { itemsMatchSlots } from "./checks/items-match-slots.ts";
import { placementBlockUpdate } from "./checks/placement-block-update.ts";
import { stateIdAgrees } from "./checks/state-id-agrees.ts";
import { stopDiggingBothWindows } from "./checks/stop-digging-both-windows.ts";
import { thinBlockShapes } from "./checks/thin-block-shapes.ts";
import { tossCountAndEntity } from "./checks/toss-count-and-entity.ts";
import { waitForTicksAndAge } from "./checks/wait-for-ticks-and-age.ts";
import { worldAgePerSecond } from "./checks/world-age-per-second.ts";

type Cell = readonly [number, number, number];

/**
 * The world a check starts in, the same on both sides: a stone floor at y -61 (the fake's ground, `setupCommands` on
 * the server), open air above it, these cells, the carried stacks, the bot's feet and the entities summoned.
 */
export interface ContractFixture {
  /** `"x,y,z"` to the block there, inside the arena (`setup-commands.ts` `ARENA`). */
  readonly cells: Readonly<Record<string, FakeCell>>;
  /** Item name to the number given, in this order (hotbar first, as `give` fills it). */
  readonly carried: Readonly<Record<string, number>>;
  /** The bot's feet, on the floor. */
  readonly position: Cell;
  readonly entities?: readonly { readonly name: string; readonly position: Cell }[];
}

export interface ContractCheck {
  readonly name: string;
  readonly fixture: ContractFixture;
  /** Throws (`node:assert`) with the disagreement; resolves when the subject answered as the game does. */
  run(subject: ContractSubject): Promise<void>;
  /** Run on the bare bot, with no runtime of ours to act on it (`client-host.ts --without-runtime`). */
  readonly withoutRuntime?: boolean;
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
  columnsHoldCells,
  findBlocksMatching,
  airSupplyUnderWater,
];

/** The check of that name; throws listing the known names. */
export function contractCheckNamed(name: string): ContractCheck {
  const check = CONTRACT_CHECKS.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no contract check '${name}': ${CONTRACT_CHECKS.map(({ name }) => name).join(", ")}`);
  return check;
}
