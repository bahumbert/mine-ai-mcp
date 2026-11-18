// The cover a request owes after an evade, as the hostile reflex holds it: who creates it, who reads it, and when the
// route admission applies (plan 2026-11-18-evade-resume-bound T7, spec D4). The obligation itself is `state/cover-obligation.ts`.
import type { RouteAdmission } from "../../navigation/index.js";
import { positionThreat } from "../perception/combat/observations.js";
import type { HostileSettlement } from "../control/combat/response-result.js";
import { coverAdmission, type CoverObligation } from "../state/cover-obligation.js";
import type { RequestSnapshot } from "../../session/request.js";
import type { HostileScene } from "./hostile-scene.js";

/** What a response captured when it began: the request it interrupted, the life it began in, and the range the evade held. */
export interface CoverCapture {
  readonly request: RequestSnapshot | null;
  readonly generation: number;
  /** The directive's safe range when it is an evade; null for any other response. */
  readonly safeRange: number | null;
}

/** What the request now running owes: another request, none, or an old life owes nothing. */
export function currentCovers(scene: HostileScene): readonly CoverObligation[] {
  return scene.covers.current(scene.driver.runner.request()?.id ?? null, scene.chains.generation, scene.bot, scene.perception.resolvedIds);
}

/**
 * An evade that separated behind cover from a shooter leaves the request it interrupted owing that cover. Late work of an
 * old life, of another request, a threat that is not a direct shooter, or one that is no longer loaded creates nothing.
 */
export function recordCoverObligations(scene: HostileScene, capture: CoverCapture, settlement: HostileSettlement): void {
  const { request, generation, safeRange } = capture;
  if (settlement.kind !== "completed" || settlement.physical.response !== "evade" || settlement.physical.result.kind !== "separated") return;
  if (!request || safeRange === null || generation !== scene.chains.generation) return;
  if (scene.driver.runner.request()?.id !== request.id) return;
  for (const end of settlement.physical.ends) {
    const entity = scene.bot.entities[end.id];
    if (end.basis !== "cover" || !entity?.isValid) continue;
    const threat = positionThreat(scene.bot, entity);
    if (threat.attack !== "projectile") continue;
    scene.covers.add({ requestId: request.id, generation, threatId: end.id, name: end.name,
      body: { position: threat.position, width: threat.width, height: threat.height }, safeRange });
  }
}

/**
 * The veto for the routes of the request that owes cover: none while a response holds the body (the evade's own route, a
 * hide), while a requested engagement holds it (its approach walks toward a mob on purpose), or when the request running is
 * not the one that owes (a new request has no obligation).
 */
export function coverRouteAdmission(scene: HostileScene, engaged: () => boolean): RouteAdmission | null {
  if (scene.driver.runner.request()?.state.kind !== "running" || scene.activeResponse !== null || engaged()) return null;
  const owed = currentCovers(scene);
  return owed.length === 0 ? null : coverAdmission(scene.bot, owed);
}
