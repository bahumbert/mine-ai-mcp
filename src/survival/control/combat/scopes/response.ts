import type { Bot } from "mineflayer";
import { familyIndexOf, type ItemFamily } from "../../../../world/item-families.js";
import type { SurvivalPolicy } from "../../../policy/contract.js";
import { recoveryHealth } from "../../../policy/combat/health.js";
import { responsePermissions } from "../../../policy/combat/permissions.js";
import type { AnsweredScope, Facts } from "../../../state/answered.js";
import type { SurvivalResources } from "../../../state/resources.js";
import { recoveryScope } from "./recovery.js";

export type CombatResponse = "fight" | "hide" | "evade" | "deflect";

/** The families a fight's answered-response record lists: what the bot can hit, shoot or guard with. */
const FIGHT_TRACE_FAMILIES: readonly ItemFamily[] = ["bow", "crossbow", "arrow", "sword", "axe", "shield"];

export function responseScope(
  bot: Bot,
  policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>,
  kind: CombatResponse,
  targetId?: number,
): AnsweredScope {
  const origin = bot.entity.position.floored();
  return {
    capability: `combat.${kind}`,
    response: kind,
    scope: kind === "fight" || kind === "deflect" ? `target:${targetId}` : `cell:${origin}`,
    permissions: () => ({
      ...responsePermissions(policy().combat, kind),
      ...((kind === "fight" || kind === "hide") && { rawFood: { ...policy().food.raw } }),
    }),
    facts: (): Facts => {
      const items = bot.inventory.items();
      if (kind === "deflect") return {};
      if (kind === "fight") {
        const index = familyIndexOf(bot);
        return {
          weapons: items
            .filter((item) => index.itemFamilies(item.name).some((family) => FIGHT_TRACE_FAMILIES.includes(family)))
            .map((item) => ({ name: item.name, available: item.count > 0 }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      }
      const cells: (number | null)[] = [];
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++)
          for (let y = -3; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
      return {
        cells,
        target: targetId === undefined ? null : (bot.entities[targetId]?.position.floored().toString() ?? null),
        weapons: [],
        material:
          kind === "hide"
            ? items
                .filter((item) => bot.registry.blocksByName[item.name])
                .map((item) => ({ name: item.name, count: item.count }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [],
      };
    },
  };
}

export function answeredResponses(
  bot: Bot,
  policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>,
  survival: SurvivalResources,
): Set<string> {
  const blocked = new Set<string>();
  for (const kind of ["hide", "evade"] as const) {
    const scope = responseScope(bot, policy, kind);
    if (survival.answered.find(scope.capability, scope.scope)) blocked.add(kind);
  }
  const recovery = recoveryScope(bot, policy, recoveryHealth(policy().combat));
  if (survival.answered.find(recovery.capability, recovery.scope)) blocked.add("recovery");
  return blocked;
}
