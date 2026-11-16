// What the steps of the hostile reflex share: the bot, the controllers around it, and the one response in flight.
import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import type { CombatController } from "../control/combat/contract.js";
import type { ReflexDriver } from "../control/driver.js";
import type { CombatPerception } from "../perception/combat/observations.js";
import type { HostileResponse } from "../policy/combat/response.js";
import { isShield, OFF_HAND_SLOT } from "../weapons/equipment.js";
import type { ThreatChains } from "../state/threat-chains.js";

export interface HostileScene {
  readonly bot: Bot;
  readonly driver: ReflexDriver;
  readonly navigation: NavigationRuntime;
  readonly controller: CombatController;
  readonly perception: CombatPerception;
  readonly policy: CombatController["policy"];
  readonly context: ResponseContext;
  /** Hostiles seen since the encounter began and not yet resolved or out of the evade range. */
  readonly encounterThreats: Set<number>;
  readonly chains: ThreatChains;
  /** Hand a policy change to the policy state; a failure constrains the policy instead of throwing. */
  readonly transition: (pending: Promise<void>) => void;
  /** The response being executed now, null between responses. */
  activeResponse: HostileResponse["kind"] | null;
}

export function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What the off-hand holds, by item name; null when it is empty. */
export function offHandItem(bot: Bot): string | null {
  return bot.inventory.slots[OFF_HAND_SLOT]?.name ?? null;
}

/** Every shield (family `shield`) in the inventory. */
export function carriedShields(bot: Bot) {
  return bot.inventory.items().filter((item) => isShield(bot, item));
}
