import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { obstaclesOf, worldViewRaycaster } from "../../../navigation/world/line-of-sight.js";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { bowApproachGoal } from "../../positioning/combat/bow-approach.js";
import type { Goal } from "../../../navigation/index.js";
import { aimPoint } from "../../weapons/aim.js";
import { meleeApproachGoal } from "../../weapons/melee.js";
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
  const rays = worldViewRaycaster((x, y, z) => obstaclesOf(world.blockAt(x, y, z), x, z));
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

/** A blaze hovering at (1.5, 68, 0.5), 5 above the bot's feet at (0.5, 63, 0.5), over open cells observed up to y 72. */
function hoveringBlaze(options: { bow: boolean }) {
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 63, 0.5),
    groundY: 62,
    entities: { 7: { name: "blaze", position: new Vec3(1.5, 68, 0.5), width: 0.6, height: 1.8, metadata: [] } },
    carried: { diamond_sword: 1, bow: 1, arrow: 3 },
  });
  const world = flatWorld();
  for (let x = -5; x <= 5; x++) for (let z = -5; z <= 5; z++) for (let y = 66; y <= 72; y++) world.load({ x, y, z }, { stateId: 0 });
  const scene = {
    bot,
    target: bot.entities[7]!,
    targetMotion: new TargetMotion(),
    signal: new AbortController().signal,
    perception: { read: () => [] },
    navigation: { world },
    policy: { combat: { bow: options.bow, melee: true, shield: true } },
  } as unknown as FightScene;
  const movement = new FightMovement(scene, new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false }));
  const resolve = (goal: Goal) => {
    const resolved = goal.resolve({ ...observation(), position: bot.entity.position });
    if (resolved.kind !== "active") throw new Error("the goal is not active");
    return resolved;
  };
  const node = (x: number) => ({ feet: { x, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" });
  return {
    node,
    world,
    melee: (hovering: boolean) => resolve(meleeApproachGoal(bot, 7, world, undefined, { hovering })),
    // `beganOutsideContact` false returns the bare melee goal, so the answer is the `hovering` decision alone, not a firing line.
    fights: () => resolve(movement.approachGoal(false)),
  };
}

test("a hovering blaze's footprint is the melee goal only when asked to hover; a cell 6 blocks off never is", () => {
  const { melee, node, world } = hoveringBlaze({ bow: false });
  // The pair that flips: the same node and the same body, `hovering` the only difference.
  assert.equal(melee(true).isSatisfied(node(0), world), true, "flattened to the bot's height: the cell beside the footprint is in reach");
  assert.equal(melee(false).isSatisfied(node(0), world), false, "the body's real height is above reach from every standing cell");
  assert.equal(melee(true).isSatisfied(node(-5), world), false, "6 blocks off the footprint is out of reach even flattened");
});

test("the fight's approach goal hovers for a bot with no permitted bow, and not for one whose policy permits the bow", () => {
  const noBow = hoveringBlaze({ bow: false });
  assert.equal(noBow.fights().isSatisfied(noBow.node(0), noBow.world), true, "no permitted bow: wait under the footprint, never climb");
  // A bow answers a hovering shooter from the fighting level: flattening its melee goal would arrive at once under it and spin.
  const withBow = hoveringBlaze({ bow: true });
  assert.equal(withBow.fights().isSatisfied(withBow.node(0), withBow.world), false, "a permitted bow: the melee goal keeps the body's real height");
});
