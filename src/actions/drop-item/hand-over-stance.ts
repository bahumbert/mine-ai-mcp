// Where the giver of a hand-over stands: a toss rests on the floor the giver tosses from, and a player picks an item up
// only within a box around their body, so a toss from below a ledge rests under it, out of the recipient's reach
// (live s3o 2026-11-03; measured in Mine Labs, scenarios `drop/toss-to-ledge-*`, facts/relations.md "Hand-over stance").
import { inEntityStance, type EntityStance } from "../../navigation/index.js";

/** How close, in the plane, the giver gets before handing items over. Within this, a toss lands at their feet. */
export const HANDOVER_RANGE = 2;

/** The most the recipient's feet may be above the giver's for the toss to be taken: a slab (0.5) was, a full block (1) was not. */
export const RECIPIENT_HIGHER_MAX = 0.5;

/** The most the giver's feet may be above the recipient's: a toss down 2 blocks was taken (deeper is not measured). */
export const GIVER_HIGHER_MAX = 2;

interface Feet {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** The stance as a navigation goal sees it: any cell within reach in the plane whose floor a toss rests on the recipient's from. */
export const handOverStance: EntityStance = {
  reach: HANDOVER_RANGE,
  targetAbove: RECIPIENT_HIGHER_MAX,
  targetBelow: GIVER_HIGHER_MAX,
};

/** Whether a giver with these feet can hand over to a recipient with those: in reach in the plane, on a floor their toss rests on. */
export function inHandOverStance(giver: Feet, recipient: Feet): boolean {
  return inEntityStance(handOverStance, giver, recipient);
}

/** Whether the height alone puts the recipient out of reach: too far above for a toss to rest at their feet, or too far below. */
export function heightBlocksStance(giver: Feet, recipient: Feet): boolean {
  return inHandOverStance({ ...giver, x: recipient.x, z: recipient.z }, recipient) === false;
}

const blocks = (count: number) => `${count} block${count === 1 ? "" : "s"}`;

/** Where the recipient's feet are against the giver's, for a refusal the model reads. */
export function heightBetweenText(giver: Feet, recipient: Feet): string {
  const rise = Math.round(recipient.y - giver.y);
  if (rise === 0) return "on my level";
  return rise > 0 ? `${blocks(rise)} above me` : `${blocks(-rise)} below me`;
}
