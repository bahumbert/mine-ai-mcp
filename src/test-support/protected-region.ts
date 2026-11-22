// A protected region as a test provider returns it: stored by the bot under test unless the test says otherwise.
import type { ProtectedRegion } from "../world/protected-regions.js";

export type ProtectedRegionFields = Omit<ProtectedRegion, "heldBy" | "peer"> & Partial<Pick<ProtectedRegion, "heldBy" | "peer">>;

/** The box, owner and label a test cares about; the holder bookkeeping defaults to an own region (`peer: false`). */
export function protectedRegion(fields: ProtectedRegionFields): ProtectedRegion {
  return { heldBy: "TestBot", peer: false, ...fields };
}
