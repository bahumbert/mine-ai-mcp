// How navigation learns about hostiles: the price of their reach and sight in each search, and the veto over a route that
// would break the cover a resumed request owes. The one place that holds the navigation runtime, combat's view of who is a
// threat and the hostile reflex's obligations, so it is the one place that can join them.
import type { Bot } from "mineflayer";
import type { NavigationRuntime, StepFieldProvider } from "../../navigation/index.js";
import type { CombatController } from "../control/combat/contract.js";
import { createHostileStepFieldProvider } from "../positioning/combat/hostile-field.js";
import type { HostileReflex } from "./hostile.js";

/**
 * Every route the bot takes from here is priced to prefer going around a hostile (and, for a request that owes cover, out of
 * its shooter's sight), and a request that owes cover is refused a route that leaves it. Combat's own routes, which walk
 * toward a hostile on purpose, pass `stepField: null` and are never refused (`combat.activeEngagement()`).
 */
export function routeAroundHostiles(
  bot: Bot,
  navigation: NavigationRuntime,
  hostiles: HostileReflex,
  combat: CombatController,
  stepFieldProvider?: StepFieldProvider,
): void {
  navigation.setStepFieldProvider(
    stepFieldProvider ?? createHostileStepFieldProvider(
      bot, hostiles.threats, hostiles.activeResponse, () => combat.policy.effective.navigation, () => hostiles.coverObligations(),
    ),
  );
  navigation.setRouteAdmissionProvider(() => hostiles.coverAdmission(() => combat.activeEngagement() !== null));
}
