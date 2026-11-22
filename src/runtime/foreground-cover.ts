// Foreground ownership wiring for the passive navigation cover report.
import type { Bot } from "mineflayer";
import { createNavigationRuntime, type NavigationRuntime, type RouteOutcomes } from "../navigation/index.js";
import type { ActionRunner } from "../session/action-runner.js";

/** Clear once per admitted foreground request; a reflex's handback resumes the same request and retains its report. */
export function clearCoverOnNewForeground(runner: ActionRunner, navigation: Pick<NavigationRuntime, "clearCoverExit">): () => void {
  let previous: string | null = null;
  return runner.onOwnershipChange(() => {
    if (runner.status().owner !== "foreground") return;
    const id = runner.request()?.id;
    if (id === undefined || id === previous) return;
    previous = id;
    navigation.clearCoverExit();
  });
}

/** Report ordinary foreground travel only: a hunting request can lend the body to combat without changing the runner owner. */
export function createForegroundNavigation(bot: Bot, runner: ActionRunner, routes: RouteOutcomes, resources: AsyncDisposableStack, combatActive: () => boolean): NavigationRuntime {
  const navigation = resources.use(createNavigationRuntime(bot, { routes, foreground: () => runner.status().owner === "foreground" && !combatActive() }));
  resources.defer(clearCoverOnNewForeground(runner, navigation));
  return navigation;
}
