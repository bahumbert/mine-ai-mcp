// The saved first-entry tower with its bot shut in its own dragon shelter: shared by the staircase route tests and the End's execute test.
import { Vec3 } from "vec3";
import { protectionShell } from "../survival/positioning/combat/planner.js";
import type { CrystalStaircase } from "../survival/positioning/combat/crystal-staircase.js";
import { enclosedInPlace, shelterFeet } from "../survival/responses/shelter-cells.js";
import { DIG_CLEAR_BLOCK } from "../world/dig-clear.js";
import type { FakeCell, FakeHarness } from "./fake-bot/index.js";

type SceneParts = Pick<FakeHarness, "bot" | "server" | "world"> & { readonly plan: CrystalStaircase };

/** Where the first ascent leaves the saved staircase (the cloud control and the planned block sit here). */
export const FIRST_ASCENT = new Vec3(-46, 79, -3);

/** The treads the saved tower lacks. */
export const MISSING_TREADS = [
  new Vec3(-43, 83, -5), new Vec3(-42, 84, -5), new Vec3(-41, 85, -5),
  new Vec3(-40, 86, -5), new Vec3(-40, 85, -5), new Vec3(-40, 86, -4),
];

// Open island ground inside the work box, clear of every planned cell and of the tower.
export const SHELTERED = new Vec3(-47.5, 62, -3.5);

/** Keep the saved world's state properties (a bar's connections, a stair's shape) when loading it into the shared fake. */
export function fixtureCell(state: string): FakeCell {
  const [name, properties] = state.split("[");
  if (properties === undefined) return name!;
  return { name: name!, properties: Object.fromEntries(properties.slice(0, -1).split(",").map(prop => prop.split("="))) };
}

/** Stand on the island inside the box and close the bot's own feet cell as its dragon shelter does: the sides and cap
 * `enclosedInPlace` reads, in end_stone. The treads are built and one planned clearance cell near the first ascent holds
 * a block the work must dig: a shut-in bot with a placement left would take the builder's own way out (`onlyEnclosing`,
 * whose goal lies outside the work box), so only a dig target keeps the work route in the box, as in the saved stalls. */
export function closeShelter({ bot, server, world, plan }: SceneParts): { readonly shell: Vec3[]; readonly wrong: Vec3 } {
  server.sendPosition(SHELTERED);
  bot.entity.onGround = true; // stopgap: the island floor is under the cell, and no physics tick has run since the teleport
  const feet = shelterFeet(bot);
  const shell = protectionShell(feet, [feet]);
  for (const cell of shell) world.setCell(cell, "end_stone");
  if (!enclosedInPlace(bot)) throw new Error("the shelter shell does not close the bot in");
  for (const tread of MISSING_TREADS) world.setCell(tread, "end_stone");
  const wrong = plan.cells.filter(({ blockName }) => blockName === DIG_CLEAR_BLOCK)
    .map(({ position }) => new Vec3(position.x, position.y, position.z))
    .reduce((nearest, cell) => cell.distanceTo(FIRST_ASCENT) < nearest.distanceTo(FIRST_ASCENT) ? cell : nearest);
  world.setCell(wrong, "end_stone");
  return { shell, wrong };
}
