// One claim check on arrival at a remembered house, rearmed only by a departure.
import type { MaterialCount } from "../building/blueprint.ts";
import { HOUSE_SIZES, type HouseSize } from "../building/house.ts";
import { planHouse, styleOrDefault, type HousePlan } from "../building/plan.ts";
import { sameDimension } from "../bot-data-sql.ts";
import type { KnownPlace } from "../mind.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import type { SkillContext, UnfinishedHouse } from "../skills.ts";
import { RESUME_RANGE } from "../skills/build-house.ts";
import { ensureClaimSign, type ClaimResult } from "../skills/claim-sign.ts";
import { distanceBetween } from "../skills/positions.ts";

export interface VisitHouse {
  readonly door: Position;
  readonly dimension: string;
  readonly owner: string;
  readonly what: string;
  readonly claim: ClaimResult["claim"];
  readonly plan: () => HousePlan;
  readonly remember: (claim: NonNullable<ClaimResult["claim"]>) => void;
}

/** Resume the same blueprint as build, without surveying the world between visits. */
function unfinishedPlan(context: SkillContext, house: UnfinishedHouse): HousePlan {
  const size = house.kind.split(" ")[0] as HouseSize;
  if (!(size in HOUSE_SIZES)) throw new Error(`Unknown unfinished house size: ${size}`);
  return planHouse(styleOrDefault(context.style), size, house.site, house.materials ?? {}, house.shapes ?? {});
}

/** Keep only the newest house notes; legacy ownership is safe only for an explicitly own house. */
export function visitHouses(context: SkillContext, places: readonly KnownPlace[]): VisitHouse[] {
  const houses: VisitHouse[] = [];
  for (const place of new Map(places.map((place) => [place.name, place])).values()) {
    const house = place.house;
    const owner = house?.owner ?? (place.own === true ? context.self : undefined);
    if (house === undefined || owner === undefined || house.dimension === undefined) continue;
    houses.push({
      door: house.door, dimension: house.dimension, owner, what: place.name, claim: house.claim ?? null,
      plan: () => planHouse(styleOrDefault(house.style), house.size, house, house.materials, house.shapes ?? {}),
      remember: (claim) => context.remember?.({ ...place, house: { ...house, owner, claim } }),
    });
  }
  const unfinished = context.building?.unfinished;
  if (unfinished?.owner !== undefined && unfinished.dimension !== undefined) houses.push({
    door: unfinished.site.door, dimension: unfinished.dimension, owner: unfinished.owner, what: unfinished.kind,
    claim: unfinished.claim ?? null, plan: () => unfinishedPlan(context, unfinished),
    remember: (claim) => { context.building!.unfinished = { ...unfinished, claim }; },
  });
  return houses;
}

/** Build rechecks every batch on resume, so all its material kinds remain reserved (P4-21 T12 review). */
function reservedForHouse(context: SkillContext): readonly MaterialCount[] {
  const house = context.building?.unfinished;
  if (house === undefined || house === null) return [];
  return unfinishedPlan(context, house).bill;
}

export class ClaimVisits {
  private readonly wasFar = new Map<string, boolean>();

  /** Consume the arrival before awaiting anything, including failed reads and aborted model calls. */
  async check(context: SkillContext, houses: readonly VisitHouse[], after: BotSnapshot): Promise<string | null> {
    let arriving: VisitHouse | undefined;
    for (const house of houses) {
      const { x, y, z } = house.door;
      const key = `${house.dimension.replace(/^minecraft:/u, "")}|${x},${y},${z}`;
      const distance = sameDimension(house.dimension, after.dimension) ? distanceBetween(house.door, after.position) : Infinity;
      if (distance > 2 * RESUME_RANGE) this.wasFar.set(key, true);
      else if (arriving === undefined && distance <= RESUME_RANGE && this.wasFar.get(key) !== false) {
        this.wasFar.set(key, false);
        arriving = house;
      }
    }
    if (arriving === undefined || context.signal.aborted) return null;
    const spot = arriving.plan().sign;
    if (spot === null) return null;
    const result = await ensureClaimSign(context, { spot, door: arriving.door, owner: arriving.owner, dimension: arriving.dimension, what: arriving.what }, {
      craft: true, reserved: reservedForHouse(context), at: after, knownClaim: arriving.claim,
    });
    if (result.claim !== null && JSON.stringify(result.claim) !== JSON.stringify(arriving.claim)) arriving.remember(result.claim);
    return `claim visit: ${result.status}; ${result.detail}`;
  }
}
