// Protected areas as the skills read them: which ones a box overlaps, whose they are, and what they are called to the
// model (her own unfinished or finished house, someone else's area). Pure functions over `ProtectedArea`.
import type { KnownPlace } from "./mind.ts";
import type { Position, ProtectedArea } from "./runtime-client.ts";
import type { UnfinishedHouse } from "./skills.ts";

/** The label of the region a leveling job sets aside while it works (left behind only if the job was killed). */
export const LEVELING_LABEL = "leveling ";

type Box = { readonly min: Position; readonly max: Position };

/** Who is asking: her own areas are those owned by `self`. */
interface Owner {
  readonly self?: string;
}

export function overlapsBox(area: ProtectedArea, { min, max }: Box): boolean {
  return area.min.x <= max.x && area.max.x >= min.x && area.min.y <= max.y && area.max.y >= min.y && area.min.z <= max.z && area.max.z >= min.z;
}

/** Protected areas a box overlaps, her leveling margins and `except` (the region of the work itself) left out. */
export function overlapsOf(areas: readonly ProtectedArea[], box: Box, except: readonly number[] = []): ProtectedArea[] {
  return areas.filter((area) => !except.includes(area.regionId) && !area.label.startsWith(LEVELING_LABEL) && overlapsBox(area, box));
}

/** "#4 'small medieval house' (yours: leveling would dig it up)": what an area is, whose, for the model to weigh. */
function describeArea(owner: Owner, area: ProtectedArea): string {
  const whose = area.owner === owner.self ? "yours: leveling would dig it up" : `owned by ${area.owner}`;
  return `#${area.regionId} '${area.label}' (${whose})`;
}

/**
 * "overlaps protected area #4 'small medieval house' (yours: leveling would dig it up)": what each area is, so the
 * model weighs it (live 2026-10-02: told only "release it first", she released Tom's area and then her own house to
 * level around Tom, and began digging the house).
 */
export function describeOverlaps(owner: Owner, overlapping: readonly ProtectedArea[]): string {
  return `overlaps protected area${overlapping.length === 1 ? "" : "s"} ${overlapping.map((area) => describeArea(owner, area)).join(", ")}`;
}

/** The kind of a house, as notes and protected-area labels call it ("small medieval house"). */
export function houseKind(size: string, style: string): string {
  return `${size} ${style} house`;
}

/**
 * Her own earlier protections of this same house: a region of hers, with its label, around its door (live 2026-10-04:
 * resuming her unfinished house, its site was refused for overlapping #12, the same house protected before with a
 * slightly different box). Read from the runtime, not from what this session learnt: after a restart the old box is
 * still there, and it is hers all the same.
 */
export function earlierProtections(owner: Owner, label: string, door: Position, current: number, areas: readonly ProtectedArea[]): number[] {
  return areas.filter((area) =>
    area.regionId !== current && area.owner === owner.self && area.label === label &&
    door.x >= area.min.x - 1 && door.x <= area.max.x + 1 && door.z >= area.min.z - 1 && door.z <= area.max.z + 1,
  ).map((area) => area.regionId);
}

const coords = ({ x, y, z }: Position) => `${x} ${y} ${z}`;

/** What {@link describeSiteBlocker} knows besides the area: her houses, as the agent remembers them. */
interface SiteHouses extends Owner {
  readonly unfinished: UnfinishedHouse | null | undefined;
  readonly places: readonly KnownPlace[];
  /** How near its door a `build` must be to go on with the unfinished house. */
  readonly resumeRange: number;
}

/**
 * What an area in the way of a new house site is. Her own area around the door of her unfinished house, or of a house
 * she finished, is that house (run 17b: a restart left her half-built house as "protected area #1 (yours: leveling
 * would dig it up)" and she was refused her own site); any other area as {@link describeOverlaps} says it.
 */
export function describeSiteBlocker(houses: SiteHouses, area: ProtectedArea): string {
  const holds = (label: string, door: Position) => earlierProtections(houses, label, door, -1, [area]).length > 0;
  const { unfinished } = houses;
  if (unfinished !== null && unfinished !== undefined && holds(unfinished.kind, unfinished.site.door)) {
    return `an area of yours, that is your unfinished ${unfinished.kind} (area #${area.regionId}, door at ${coords(unfinished.site.door)}): build a ${unfinished.kind} again within ${houses.resumeRange} blocks of that door to go on with it, or {"skill":"abandon_house"} to give it up`;
  }
  for (const { house } of houses.places) {
    if (house !== undefined && holds(houseKind(house.size, house.style), house.door)) {
      return `an area of yours, your ${houseKind(house.size, house.style)}, door at ${coords(house.door)} (area #${area.regionId}): build somewhere else`;
    }
  }
  return `protected area ${describeArea(houses, area)}`;
}
