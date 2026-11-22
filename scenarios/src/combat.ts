import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../src/navigation/index.ts";
import type { ResponseContext } from "../../src/survival/control/combat/context.ts";
import { createCombatController } from "../../src/survival/control/combat/controller.ts";
import { CombatPerception } from "../../src/survival/perception/combat/observations.ts";
import { type HideOptions, type HideResult, hideInPlace } from "../../src/survival/responses/hide.ts";
import { FootingRecovery } from "../../src/survival/responses/footing.ts";
import { survivalResources } from "../../src/survival/state/resources.ts";
import { executeHostileResponse, type HostileResponseRequest } from "../../src/survival/control/combat/respond.ts";
/** A primitive scenario explicitly owns the services normally owned by the production runtime. */
export class ScenarioCombat implements Disposable {
  readonly bot: Bot;
  readonly perception: CombatPerception;
  readonly footing: FootingRecovery;
  readonly controller: ReturnType<typeof createCombatController>;
  readonly survival = survivalResources();
  readonly context: ResponseContext;
  readonly navigation: NavigationRuntime;
  constructor(bot: Bot, navigation: NavigationRuntime) {
    this.bot = bot;
    this.navigation = navigation;
    this.perception = new CombatPerception(bot);
    this.footing = new FootingRecovery(bot, navigation.world);
    this.controller = createCombatController(bot, navigation, this.perception, this.footing, this.survival);
    const controller = this.controller;
    this.context = {
      perception: this.perception,
      survival: this.survival,
      resolvedIds: this.perception.resolvedIds,
      attackerIds: this.perception.attackerIds,
      get policy() {
        return controller.policy.combat;
      },
      get food() {
        return controller.policy.food;
      },
    };
  }
  /** Run the runtime's selected response, including its single occupied-shelter reconsideration. */
  respond(directive: HostileResponseRequest, signal: AbortSignal) {
    return executeHostileResponse(this.bot, this.navigation, this.controller, directive, this.context, this.bot.health, signal);
  }
  /** The production hide with this scenario's navigation and an empty threat memory (every scenario caller needs both). */
  hide(bot: Bot, options: Omit<HideOptions, "threatContext" | "navigation">): Promise<HideResult> {
    return hideInPlace(bot, {
      ...options,
      navigation: this.navigation,
      threatContext: { ...this.context, resolvedIds: new Set(), attackerIds: new Set() },
    });
  }
  [Symbol.dispose]() {
    this.footing[Symbol.dispose]();
    this.perception[Symbol.dispose]();
  }
}
