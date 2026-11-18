// Finite segment intersections with axis-aligned boxes.
import type { Vec3 } from "vec3";

/** Clip the segment to each inflated slab; parallel axes need no division. */
export function segmentHitsBox(from: Vec3, to: Vec3, box: { min: Vec3; max: Vec3 }, inflate: number): boolean {
  let enter = 0;
  let leave = 1;
  for (const axis of ["x", "y", "z"] as const) {
    const low = box.min[axis] - inflate;
    const high = box.max[axis] + inflate;
    const delta = to[axis] - from[axis];
    if (delta === 0) {
      if (from[axis] < low || from[axis] > high) return false;
      continue;
    }
    const first = (low - from[axis]) / delta;
    const last = (high - from[axis]) / delta;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter > leave) return false;
  }
  return true;
}
