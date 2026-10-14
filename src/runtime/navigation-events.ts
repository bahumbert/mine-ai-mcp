import { recordEvent, type SqlBotData } from "../bot-data/index.js";
import type { NavigationRuntime } from "../navigation/index.js";

/**
 * Records the navigation facts a person watching the bot needs: a search that found no route from inside a region the
 * bot owns opens its own regions for the next one (live 2026-10-11: the escape was invisible, only a log line said it).
 */
export function observeNavigationEvents(navigation: Pick<NavigationRuntime, "onEvent">, botId: string, data: SqlBotData): () => void {
  return navigation.onEvent((event) => {
    if (event.kind !== "own_regions_opened") return;
    const { x, y, z } = event.start;
    recordEvent(data, botId, {
      type: "navigation_own_regions_opened",
      observedAt: new Date().toISOString(),
      summary: `No route from inside one of its own protected regions at ${x} ${y} ${z}: its own regions are open to the next search.`,
      payload: { runId: event.runId, start: { x, y, z } },
    });
  });
}
