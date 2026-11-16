// Sets the runtime's open-sky report on from a bot's night (its dusk point) until the night is handled.
import type { BotRuntime, BotSnapshot } from "../runtime-client.ts";
import type { SituationWatch } from "./situations.ts";

/** Per watch: the night key a failure was last logged for, and whether a set is in flight (one at a time). */
const keepers = new WeakMap<object, { loggedNight: number | null; inFlight: boolean }>();

/**
 * Sends `navigation.report_open_sky` only when the snapshot's policy shows the setting and it differs from the night's
 * wish, with the revision the snapshot read. Only one set is in flight per watch, so a late answer never overtakes a
 * newer one. A throw or a refusal is logged once per night; the next observation sends again.
 */
export async function keepOpenSkyReport(
  snapshot: BotSnapshot,
  watch: Pick<SituationWatch, "nightActive" | "nightHandled" | "nightKey">,
  runtime: Pick<BotRuntime, "setReportOpenSky">,
  log: (line: string) => void,
): Promise<void> {
  const wanted = watch.nightActive() && !watch.nightHandled();
  const policy = snapshot.policy;
  if (!policy || policy.reportOpenSky === undefined || policy.reportOpenSky === wanted) return;
  const state = keepers.get(watch) ?? { loggedNight: null, inFlight: false };
  keepers.set(watch, state);
  if (state.inFlight) return;
  const night = watch.nightKey();
  const failed = (reason: string) => {
    if (state.loggedNight === night) return;
    state.loggedNight = night;
    log(`open-sky report ${wanted ? "on" : "off"} not set (${reason}); it is sent again at the next observation`);
  };
  state.inFlight = true;
  try {
    if (!(await runtime.setReportOpenSky(wanted, policy.revision))) failed(`the runtime refused revision ${policy.revision}`);
  } catch (error) {
    failed(`the runtime failed: ${String(error)}`);
  } finally {
    state.inFlight = false;
  }
}
