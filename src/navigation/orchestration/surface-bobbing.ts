import type { NavigationObservation, WorldView } from "../world/world.js";

/** A body held in one water column that only moves up and down: a swimmer at the surface, or a hop off the floor of a flow. */
export function isSurfaceBobbing(start: NavigationObservation, current: NavigationObservation, world: WorldView): boolean {
  return isHeldHopInWater(start, current, world) || isStillSurfaceBobbing(start, current, world);
}

/** The most a body held in a water column rises or sinks between two readings: a jump and a fall back. */
const HOP_BLOCKS = 2;

/**
 * Held in the water cell it started in, over a floor, rising and sinking without leaving the column.
 *
 * A body on the floor of a shallow flow, or a held swimmer in a flow with air above, hops by
 * more than the still-water window below (live 2026-10-10 run 7: 5.0 to 6.5 for 30 minutes).
 * Every search longer than a hop saw the start change and began again, until the planning stall
 * ended the run. The horizontal bound still refuses a current that carries the body.
 */
function isHeldHopInWater(start: NavigationObservation, current: NavigationObservation, world: WorldView): boolean {
  if (start.stance === "airborne" || start.stance === "climbing" || current.stance === "climbing" ||
      start.dimension !== current.dimension) return false;
  const x = Math.floor(start.position.x);
  const z = Math.floor(start.position.z);
  if (Math.floor(current.position.x) !== x || Math.floor(current.position.z) !== z) return false;
  if (Math.hypot(current.position.x - start.position.x, current.position.z - start.position.z) > 0.1) return false;
  if (Math.abs(current.position.y - start.position.y) > HOP_BLOCKS) return false;
  // A floor under the water cell: deep or falling water carries the body, and is no hop.
  const y = Math.floor(start.position.y);
  const cell = world.blockAt(x, y, z);
  const floor = world.blockAt(x, y - 1, z);
  return cell.kind === "loaded" && cell.traits.liquid === "water" &&
    floor.kind === "loaded" && floor.traits.liquid === null && !floor.traits.empty;
}

/** Only a held swimmer's small vertical oscillation in one still-water surface column. */
function isStillSurfaceBobbing(start: NavigationObservation, current: NavigationObservation, world: WorldView): boolean {
  if (start.stance !== "swimming" ||
      (current.stance !== "swimming" && current.stance !== "airborne") ||
      start.dimension !== current.dimension) return false;
  // Water contact briefly reads false at the crest of a normal surface bob.
  // Only a search that began swimming can retain that transition.
  const x = Math.floor(start.position.x);
  const z = Math.floor(start.position.z);
  if (Math.floor(current.position.x) !== x || Math.floor(current.position.z) !== z) return false;
  if (Math.hypot(current.position.x - start.position.x, current.position.z - start.position.z) > 0.1) return false;
  // A floating standing body dips just over one block below the surface.
  // Do not extend this to deep swimming, flowing water, falls or shore landings.
  for (let y = Math.floor(start.position.y); y <= Math.floor(start.position.y) + 1; y++) {
    const water = world.blockAt(x, y, z);
    const above = world.blockAt(x, y + 1, z);
    if (water.kind !== "loaded" || water.traits.liquid !== "water" || !water.traits.liquidSource ||
        above.kind !== "loaded" || !above.traits.empty || above.traits.liquid !== null) continue;
    const surface = y + 1;
    if ([start.position.y, current.position.y].every((height) => height >= surface - 1.3 && height < surface)) return true;
  }
  return false;
}
