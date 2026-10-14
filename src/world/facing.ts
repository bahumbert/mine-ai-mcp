/** The four horizontal directions Minecraft gives an oriented block (`facing` of doors, stairs, furnaces...). */
export const HORIZONTAL_FACINGS = ["north", "south", "east", "west"] as const;
export type HorizontalFacing = (typeof HORIZONTAL_FACINGS)[number];

/** One block along a horizontal facing: north is -z, east is +x. */
export function facingVector(facing: HorizontalFacing): { readonly x: number; readonly y: 0; readonly z: number } {
  switch (facing) {
    case "north":
      return { x: 0, y: 0, z: -1 };
    case "south":
      return { x: 0, y: 0, z: 1 };
    case "east":
      return { x: 1, y: 0, z: 0 };
    case "west":
      return { x: -1, y: 0, z: 0 };
  }
}
