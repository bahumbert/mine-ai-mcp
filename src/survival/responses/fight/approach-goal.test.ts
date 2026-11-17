import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { obstaclesOf, worldViewRaycaster } from "../../../navigation/world/line-of-sight.js";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { bowApproachGoal } from "../../positioning/combat/bow-approach.js";
import { aimPoint } from "../../weapons/aim.js";
import { bowTrajectory, clearBowTrajectory } from "../../weapons/bow-trajectory.js";
import { TargetMotion } from "../../weapons/target-motion.js";
import { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import { FightWeapons } from "./weapons.js";

/** The stone block that screens a bot's actual eye at x 0.9 from a skeleton at (2.5, 63, 4.5), and not the centre of its cell (x 0.5). */
const SCREEN = { x: 1, y: 64, z: 0 } as const;
const SCREENED_SKELETON = new Vec3(2.5, 63, 4.5);

/**
 * A skeleton on flat ground (ground at y 62), outside sword reach. The shot is the bot's own: the shared fake's
 * raycast answers it from the fake world, where `screened` puts the stone; the planning ray reads the navigation world,
 * which carries the same stone.
 */
function fixture(options: { bow: boolean; feet?: Vec3; skeleton?: Vec3; screened?: boolean }) {
  const feet = options.feet ?? new Vec3(0.5, 63, 0.5);
  const { bot } = createFakeBot({
    position: feet,
    groundY: 62,
    cells: options.screened ? { "1,64,0": "stone" } : undefined,
    entities: { 7: { name: "skeleton", position: options.skeleton ?? new Vec3(4.5, 63, 4.5), metadata: [] } },
    carried: { diamond_sword: 1, bow: 1, arrow: 3 },
  });
  const target = bot.entities[7]!;
  target.setEquipment(0, itemOf(bot.registry, "bow"));
  const world = flatWorld();
  if (options.screened) world.load(SCREEN, { stateId: 1 });
  const rays = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z)));
  const scene = {
    bot,
    target,
    targetMotion: new TargetMotion(),
    signal: new AbortController().signal,
    perception: { read: () => [] },
    navigation: { world },
    policy: { combat: { bow: options.bow, melee: true, shield: true } },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const movement = new FightMovement(scene, weapons);
  const goal = movement.approachGoal(true).resolve({ ...observation(), position: bot.entity.position });
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("unreachable");
  const bowGoal = bowApproachGoal(bot, target.id, () => aimPoint(bot, target), () => weapons.hasClearShot()).resolve({
    ...observation(),
    position: bot.entity.position,
  });
  if (bowGoal.kind !== "active") throw new Error("the bow goal is not active");
  const node = (cell: Vec3) => ({ feet: { x: cell.x, y: cell.y, z: cell.z }, remainingScaffolds: 0, overlayId: "overlay:0" });
  return {
    bot,
    target,
    weapons,
    rays,
    satisfiedFrom: (cell: Vec3) => goal.isSatisfied(node(cell), world),
    bowSatisfiedFrom: (cell: Vec3) => bowGoal.isSatisfied(node(cell), world),
  };
}

test("a carried bow's firing line satisfies the approach only when the policy permits the bow", () => {
  assert.equal(fixture({ bow: true }).satisfiedFrom(new Vec3(0, 63, 0)), true, "a permitted bow may answer the skeleton from this firing line");
  // Arrow collection forbids the bow for the whole request. Arriving at once on
  // a firing line the turn may not use left the bot spinning between guard and
  // a zero-length approach six blocks from a skeleton it never reached.
  assert.equal(fixture({ bow: false }).satisfiedFrom(new Vec3(0, 63, 0)), false, "a forbidden bow's firing line is not an attack position");
});

test("the bow goal judges the cell the bot stands in by its own shot, other cells by the cell centre, and refuses a cell without ground", () => {
  // The bot's actual eye at x 0.9 is screened; the centre of its cell (x 0.5) has a clear planning line.
  const screened = fixture({ bow: true, feet: new Vec3(0.9, 63, 0.5), skeleton: SCREENED_SKELETON, screened: true });
  const centre = bowTrajectory(new Vec3(0.5, 63, 0.5).offset(0, STANDING_EYE_HEIGHT - 0.1, 0), aimPoint(screened.bot, screened.target));
  assert.ok(
    centre && clearBowTrajectory(centre, (from, direction, distance) => screened.rays.raycast(from, direction, distance)),
    "precondition: the centre line is clear by the planning ray",
  );
  assert.equal(screened.weapons.hasClearShot(), false, "precondition: the bot's actual eye has no shot");
  assert.equal(
    screened.bowSatisfiedFrom(new Vec3(0, 63, 0)),
    false,
    "the start cell the bot stands in is judged by its own blocked shot, not the centre line",
  );

  // Another cell keeps the cell-centre model: the bot's own shot is not consulted there.
  const elsewhere = fixture({ bow: true, feet: new Vec3(-0.5, 63, 0.5), skeleton: SCREENED_SKELETON, screened: true });
  assert.equal(elsewhere.bot.entity.position.floored().equals(new Vec3(0, 63, 0)), false, "precondition: the bot stands outside the start cell");
  assert.equal(elsewhere.bowSatisfiedFrom(new Vec3(0, 63, 0)), true, "a cell the bot is not in keeps the cell-centre firing line");

  // The start cell the bot stands in with a clear actual shot satisfies the goal.
  const clear = fixture({ bow: true, skeleton: SCREENED_SKELETON, screened: true });
  assert.equal(clear.weapons.hasClearShot(), true, "precondition: the bot's actual eye has a clear shot");
  assert.equal(clear.bowSatisfiedFrom(new Vec3(0, 63, 0)), true, "a start cell with a clear actual shot satisfies the goal");

  // No ground under the cell: refused before any shot is judged, though the bot stands there with a clear shot.
  const unsupported = fixture({ bow: true, feet: new Vec3(0.5, 64, 0.5) });
  assert.equal(unsupported.weapons.hasClearShot(), true, "precondition: the bot has a clear shot from the unsupported cell");
  assert.equal(unsupported.bowSatisfiedFrom(new Vec3(0, 64, 0)), false, "no ground under the cell: not a standing cell");
});
