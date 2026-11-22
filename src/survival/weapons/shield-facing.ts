import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { observedEyeHeight, STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import { clearCombatRay } from "../../world/entity-geometry.js";
import { hasExposedBody } from "../../world/entity-visibility.js";
import { arrowImpact, assessIncomingShieldProjectiles, compareImpactTimes } from "../perception/combat/shield-projectiles.js";
import { isWindingUpAtBot } from "../perception/combat/observations.js";
import { canBeBystander, isHostile } from "../perception/combat/threats.js";
import { combatReadout, MELEE_RANGE } from "./equipment.js";
import { arrowFlight, isArrowEntity } from "../perception/combat/arrow-flight.js";
import { bowReleaseInTicks, earliestBowRelease } from "../perception/combat/bow-timing.js";
import { meleeDistance } from "./melee.js";
import { serverTickPace, type TickMark } from "../../world/server-tick-pace.js";
import { MS_PER_ON_TIME_TICK, serverPacedWallMs } from "../../world/world-age.js";

type Entity = Parameters<Bot["attack"]>[0];
const GUARD_COSINE = Math.cos((70 * Math.PI) / 180);
// Allow a movement-packet send and the server's separate head update before contact.
export const HEAD_TURN_LEAD_TICKS = 3;
const IMPACT_GRACE_TICKS = 2;
type HeldImpact = { entity: Entity; heading: Vec3; mark: TickMark; impactTicks: number; totalTicks: number };
type ProjectileForecast = ReturnType<typeof assessIncomingShieldProjectiles>[number];
const heldImpacts = new WeakMap<Bot, HeldImpact>();

/** Keep possible past contacts unsafe until a packet corrects their anchor or clears the projectile. */
function earliestArrowContact(bot: Bot, entity: Entity, allowance: number, now: number) {
  const flight = arrowFlight(bot, entity, now);
  if (!flight.positionMark || flight.ownLaunch || entity.velocity.norm() === 0) return null;
  if (flight.anchorLaunch && combatReadout(bot).arrows < flight.anchorLaunch.arrows) return null;
  const anchored: Entity = Object.create(entity);
  Object.defineProperties(anchored, { position: { value: flight.anchorPosition }, velocity: { value: flight.anchorVelocity } });
  const contact = arrowImpact(bot, anchored, allowance);
  if (!contact) return null;
  const ticks = contact.ticks - Math.max(0, now - flight.positionMark.ms) / MS_PER_ON_TIME_TICK;
  const pace = serverTickPace(bot), elapsed = Math.max(0, now - flight.positionMark.ms);
  return { ...contact, ticks: Math.max(0, ticks), uncertain: ticks <= 0 || flight.positionMark.age === null ||
    pace.creditedSince(flight.positionMark, now) + 1e-6 < elapsed / pace.msPerTick() };
}

/** A confirmed block ends the estimated contact grace, but does not identify an arrow. */
export function confirmShieldBlock(bot: Bot): void {
  heldImpacts.delete(bot);
}

/** Face a cone covering nearby attackers, rather than exposing one side each time the nearest cube changes. */
export function shieldFacing(bot: Bot, target: Entity, dead: ReadonlySet<number>): Vec3 {
  const projectileFacing = projectileShieldFacing(bot);
  if (projectileFacing) return projectileFacing;
  const threats = Object.values(bot.entities)
    .filter(
      (entity) =>
        entity.id === target.id ||
        (!dead.has(entity.id) &&
          isHostile(entity) &&
          !canBeBystander(bot, entity) &&
          meleeDistance(bot, entity) <= MELEE_RANGE + 1 &&
          hasExposedBody(bot, entity)),
    )
    .sort((a, b) => meleeDistance(bot, a) - meleeDistance(bot, b));
  const { heading } = shieldCoverage(
    bot.entity.position,
    threats.map((entity) => entity.position),
  );
  return bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0).plus(heading);
}

/** One shield can cover several incoming shots; keep the most urgent one inside its arc. */
export function projectileShieldFacing(bot: Bot, movementAllowance = 0): Vec3 | null {
  return observeProjectileDefence(bot, movementAllowance)?.facing ?? null;
}

/** Build paced geometry and conservative admission deadlines from the same observations. */
function forecastProjectileContacts(bot: Bot, movementAllowance: number, now: number) {
  // A crossing shot can warn movement to stop without threatening the settled
  // body. Such a near miss must never take aim priority over an actual hit.
  const hits = assessIncomingShieldProjectiles(bot);
  const projectiles = hits.length ? hits : assessIncomingShieldProjectiles(bot, movementAllowance);
  const earliest = new Map(Object.values(bot.entities).filter(entity => entity.isValid && isArrowEntity(bot, entity))
    .map(entity => [entity, earliestArrowContact(bot, entity, hits.length ? 0 : movementAllowance, now)] as const));
  const forecasts = projectiles.map(shot => ({ ...shot,
    earliestImpactInTicks: earliest.get(shot.entity)?.ticks ?? shot.impactInTicks }));
  for (const [entity, contact] of earliest) if (contact && !forecasts.some(shot => shot.entity === entity)) {
    forecasts.push({ entity, impactInTicks: null, earliestImpactInTicks: contact.ticks, contact: contact.position });
  }
  return { hits, forecasts: forecasts.sort(compareImpactTimes),
    timingUncertain: [...earliest.values()].some(contact => contact?.uncertain) };
}

/** Before release, only a measured bow draw can supply an impact forecast. */
function forecastWindups(bot: Bot, now: number) {
  return Object.values(bot.entities).filter((entity) =>
    isHostile(entity) && !canBeBystander(bot, entity) &&
    isWindingUpAtBot(bot, entity) && clearCombatRay(bot.world,
      entity.position.offset(0, observedEyeHeight(entity), 0),
      bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0)))
    .map((entity) => {
      const releaseInTicks = bowReleaseInTicks(bot, entity);
      // Vanilla skeleton launch speed is an estimate until the observed arrow replaces it.
      return { entity, releaseInTicks,
        earliestImpactInTicks: releaseInTicks === null ? null
          : earliestBowRelease(bot, entity, now).ticks + entity.position.distanceTo(bot.entity.position) / 1.6,
        impactInTicks: releaseInTicks === null ? null
        : releaseInTicks + entity.position.distanceTo(bot.entity.position) / 1.6 };
    }).sort(compareImpactTimes);
}

/** Unknown observed hits stay protective alongside the arrow's known turn horizon. */
function contactsDuringTurn(forecasts: ProjectileForecast[], committed: ProjectileForecast, ticks: number) {
  return [committed, ...forecasts.filter((shot) => shot !== committed &&
    (shot.impactInTicks === null || shot.impactInTicks <= ticks + HEAD_TURN_LEAD_TICKS))].map((shot) => shot.contact);
}

/** Retain only an arrow's bounded commitment; future wind-ups cannot steal its heading. */
function retainImpactHeading(bot: Bot, forecasts: ProjectileForecast[], hits: ProjectileForecast[], now: number) {
  const pace = serverTickPace(bot);
  let held = heldImpacts.get(bot);
  const spent = held ? pace.creditedSince(held.mark, now) : 0;
  if (held && (spent >= held.totalTicks || now - held.mark.ms >= serverPacedWallMs(held.totalTicks) || !held.entity.isValid)) {
    heldImpacts.delete(bot);
    held = undefined;
  }
  const urgent = forecasts[0];
  // An earlier observed collision can supersede a held later shot. A new bow
  // draw cannot steal the heading during an already committed impact window.
  if (held && urgent && urgent.entity !== held.entity &&
      (!hits.some(({ entity }) => entity === held!.entity) ||
        (urgent.impactInTicks !== null && urgent.impactInTicks < held.impactTicks - spent - 1))) {
    heldImpacts.delete(bot);
    held = undefined;
  }
  if (!held && urgent && isArrowEntity(bot, urgent.entity) &&
      urgent.impactInTicks !== null && hits.some(({ entity }) => entity === urgent.entity) &&
      urgent.impactInTicks <= HEAD_TURN_LEAD_TICKS) {
    // Cover imminent contacts without sacrificing their margin to a distant
    // shooter. Keep that heading while the server completes this impact.
    const { heading } = shieldCoverage(bot.entity.position, contactsDuringTurn(forecasts, urgent, urgent.impactInTicks));
    held = { entity: urgent.entity, heading, mark: { ...pace.mark(), ms: now }, impactTicks: urgent.impactInTicks,
      totalTicks: urgent.impactInTicks + IMPACT_GRACE_TICKS };
    heldImpacts.set(bot, held);
  }
  if (held) {
    // A second shot can enter the turn horizon after commitment. Use a shared
    // heading when both contacts fit, rather than waiting to turn after the first.
    const committed = forecasts.find((shot) => shot.entity === held.entity);
    if (committed && committed.impactInTicks !== null) {
      const contacts = contactsDuringTurn(forecasts, committed, committed.impactInTicks);
      const shared = shieldCoverage(bot.entity.position, contacts);
      if (shared.coversAll) held.heading = shared.heading;
    }
  }
  return held;
}

/** One assessment for movement admission, shield aim and guard release. */
export function observeProjectileDefence(bot: Bot, movementAllowance = 0, now = performance.now()) {
  const pace = serverTickPace(bot);
  const { hits, forecasts, timingUncertain } = forecastProjectileContacts(bot, movementAllowance, now);
  const windupForecasts = forecastWindups(bot, now);
  const held = retainImpactHeading(bot, forecasts, hits, now);
  if (forecasts.length === 0 && windupForecasts.length === 0 && !held) return null;
  // Observed contacts precede future releases, even when their timing is unknown (a6 T10, t00365).
  const directions = [...forecasts.map(({ contact }) => contact),
    ...windupForecasts.map(({ entity }) => entity.position)];
  const heading = held?.heading ?? shieldCoverage(bot.entity.position, directions).heading;
  const look = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const unitDirections = directions.map((position) => {
    const direction = position.minus(bot.entity.position);
    direction.y = 0;
    return direction.norm() === 0 ? heading : direction.normalize();
  });
  if (held) unitDirections.unshift(held.heading);
  const covered = (aim: Vec3) => unitDirections.filter((direction) => aim.dot(direction) >= GUARD_COSINE).length;
  return {
    projectiles: forecasts,
    windingUp: windupForecasts.map(({ entity }) => entity),
    windupForecasts,
    heldProjectileId: held?.entity.id ?? null,
    holdRemainingTicks: held ? Math.max(0, held.totalTicks - pace.creditedSince(held.mark, now)) : 0,
    timingUncertain: timingUncertain || windupForecasts.some(({ entity }) => earliestBowRelease(bot, entity, now).uncertain),
    facing: bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0).plus(heading),
    coversAll: covered(heading) === unitDirections.length,
    // Opposing shooters cannot all fit. Once the urgent shot and the best
    // available coverage are faced, do not repeatedly stop the approach.
    aligned: look.dot(unitDirections[0]!) >= GUARD_COSINE && covered(look) >= covered(heading),
    imminent: hits.length > 0 || held !== undefined,
  };
}

/** The same guard cone drives facing and decides whether a shield can answer the exposed firing lines. */
export function shieldCoverage(origin: Vec3, positions: readonly Vec3[]): { heading: Vec3; coversAll: boolean } {
  const directions = positions.map((position) => {
    const toward = position.minus(origin);
    toward.y = 0;
    return toward.norm() === 0 ? new Vec3(0, 0, 1) : toward.normalize();
  });
  const priority = directions[0];
  if (!priority) return { heading: new Vec3(0, 0, 1), coversAll: true };
  // The caller orders threats by urgency. The first must stay covered. Among headings
  // that do so, choose the one also covering the most other observed threats.
  const candidates = [...directions];
  for (let a = 0; a < directions.length; a++)
    for (let b = a + 1; b < directions.length; b++) {
      const between = directions[a]!.plus(directions[b]!);
      if (between.norm() > 0.001) candidates.push(between.normalize());
    }
  const covered = (heading: Vec3) => directions.filter((toward) => heading.dot(toward) >= GUARD_COSINE).length;
  let heading = priority;
  for (const candidate of candidates)
    if (candidate.dot(priority) >= GUARD_COSINE && covered(candidate) > covered(heading)) heading = candidate;
  return { heading, coversAll: covered(heading) === directions.length };
}
