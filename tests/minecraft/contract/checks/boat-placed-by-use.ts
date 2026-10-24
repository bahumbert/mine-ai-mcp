/**
 * A boat held and used (`use_item`, `inventory.js:127`) is put where the look meets water or ground within the reach of
 * 4.5 blocks (Mine Labs 1.21.4, 2026-10-23): the boat entity appears at that point, facing the way she looks, and the
 * stack loses its one boat; on water it sinks to rest 0.37 below the surface within 1.5 s. Nothing is put (stack kept)
 * for a look at the sky, at ground past the reach (put at 4.4, not at 4.7), at a wall (the boat would stand in it), or
 * on a spot another boat holds. A boat stacks to 1, so the next one is the next hotbar slot.
 * The boat faces the look as one byte of the entity's yaw (256 steps a turn), the look's yaw floored to it: an aim at east
 * itself (exactly -64 steps) gave -65 once, the float error of the aim deciding, so the check looks 0.3 of a step off
 * east on each side and asks for the byte floor gives (-64 and -65; rounding gives -64 for both).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, type LocalPoint, holdsWithin } from "../subject.ts";
import { WATER_POOL_CELLS, WATER_SURFACE_Y, getOffAndStand } from "./boat-seat.ts";

const BOATS_CARRIED = 3;
/** The boat appears within a tick or two of the use on a server on time; a bound with room for one behind. */
const PLACE_WALL_MS = 2_000;
/** An absence is shown over this long (the answer to a use is within one tick). */
const ABSENCE_MS = 1_500;
/** The forced look reaches the server with the use packet (`rotation`); a short wait lets the physics tick send it too. */
const LOOK_SETTLE_MS = 300;
const USE_HOLD_MS = 100;
/** The reach lies between 4.40 (put) and 4.70 (not put): vanilla's block reach of 4.5. */
const IN_REACH_AIM: LocalPoint = [0.5, -60, -3.59];
const OUT_OF_REACH_AIM: LocalPoint = [0.5, -60, -3.91];
const WATER_AIM: LocalPoint = [3.5, WATER_SURFACE_Y, 0.5];
/** The east face of the wall block at (-3, -60, 0). */
const WALL_AIM: LocalPoint = [-2, -59.5, 0.5];
const SKY_AIM: LocalPoint = [0.5, 20, 0.5];
/** A boat's rest level on water, below the surface (-60.477 from -60.111 on the server). */
const REST_BELOW_SURFACE = 0.366;
const REST_TOLERANCE = 0.05;
const REST_WAIT_MS = 3_000;
const POINT_TOLERANCE = 0.02;
const SEAT_WALL_MS = 3_000;
/** An entity's yaw travels as one byte, 256 steps a turn; a look east is Notchian yaw -90 degrees, exactly -64 steps. */
const STEPS_PER_TURN = 256;
const EAST_STEP = -64;
/** A look this far (of a step) off east: the float error of an aim at the boundary itself (a byte of -65 for an aim at east, 2026-10-24) is far below it. */
const OFF_BOUNDARY_STEPS = 0.3;

/**
 * `aim` turned about the vertical axis through the bot until the look at it is `steps` byte steps past east (a look east is
 * Notchian yaw -90; one more step turns toward south, +z): the same distance and height, so the boat is put at the point itself.
 */
function aimPastEast(from: Vec3, aim: Vec3, steps: number): Vec3 {
  const turn = (steps * 2 * Math.PI) / STEPS_PER_TURN;
  const distance = Math.hypot(aim.x - from.x, aim.z - from.z);
  return new Vec3(from.x + distance * Math.cos(turn), aim.y, from.z + distance * Math.sin(turn));
}

/** The byte a boat's entity yaw was decoded from (`fromNotchianYawByte`, Mineflayer's radians 0 to 2 pi), -128 to 127. */
function yawByteOf(boat: Entity): number {
  const steps = Math.round(((Math.PI - boat.yaw) * STEPS_PER_TURN) / (2 * Math.PI));
  return ((((steps + STEPS_PER_TURN / 2) % STEPS_PER_TURN) + STEPS_PER_TURN) % STEPS_PER_TURN) - STEPS_PER_TURN / 2;
}

/** The boat stands where the look met the water: `point` in x and z, the water's surface in y. */
function assertOnWaterAt(boat: Entity, point: Vec3): void {
  assert.ok(Math.hypot(boat.position.x - point.x, boat.position.z - point.z) < POINT_TOLERANCE, `put at ${boat.position}, not at the aimed point ${point}`);
  assert.ok(Math.abs(boat.position.y - WATER_SURFACE_Y) < POINT_TOLERANCE, `put at y ${boat.position.y}, not at the water surface ${WATER_SURFACE_Y}`);
}

/** Select hotbar slot `slot`, look at `aim`, use the held item once; the boat that appeared, or null after `ABSENCE_MS`. */
async function useBoatAt(subject: ContractSubject, slot: number, aim: Vec3): Promise<Entity | null> {
  const { bot } = subject;
  bot.setQuickBarSlot(slot);
  await subject.wait(USE_HOLD_MS);
  const known = new Set(Object.values(bot.entities).map((entity) => entity.id));
  const newBoat = () => Object.values(bot.entities).find((entity) => entity.name === "oak_boat" && !known.has(entity.id));
  await bot.lookAt(aim, true);
  await subject.wait(LOOK_SETTLE_MS);
  bot.activateItem();
  await subject.wait(USE_HOLD_MS);
  bot.deactivateItem();
  await holdsWithin(subject, () => newBoat() !== undefined, ABSENCE_MS);
  return newBoat() ?? null;
}

export const boatPlacedByUse: ContractCheck = {
  name: "boat-placed-by-use",
  fixture: { cells: { ...WATER_POOL_CELLS, "-3,-60,0": "stone" }, carried: { oak_boat: BOATS_CARRIED }, position: [0.5, -60, 0.5] },
  // Bare bot: our runtime would act on a boat it finds (`boat-crossing.ts`).
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boatItem = bot.registry.itemsByName.oak_boat!.id;
    const carried = () => bot.inventory.count(boatItem, null);
    assert.equal(carried(), BOATS_CARRIED, "the fixture's boats");
    for (const [label, aim] of [["the sky", SKY_AIM], ["ground past the reach (4.7)", OUT_OF_REACH_AIM], ["a wall's face", WALL_AIM]] as const) {
      assert.equal(await useBoatAt(subject, 0, subject.world(aim)), null, `a boat was put when used at ${label}`);
      assert.equal(carried(), BOATS_CARRIED, `the stack changed after a use at ${label}`);
    }
    // The yaw is the look's floored to a byte: a look 0.3 of a step past east (-63.7) gives -64, 0.3 before it (-64.3) gives -65
    // (rounding gives -64 for both). Two boats on one spot, so the first is taken away (two on a 3-wide pool push each other).
    const pastEastAim = aimPastEast(bot.entity.position, subject.world(WATER_AIM), OFF_BOUNDARY_STEPS);
    const beforeEastAim = aimPastEast(bot.entity.position, subject.world(WATER_AIM), -OFF_BOUNDARY_STEPS);
    const inReachAim = subject.world(IN_REACH_AIM);
    const pastEast = await useBoatAt(subject, 0, pastEastAim);
    assert.ok(pastEast !== null, "no boat entity after a use at water 3 blocks away");
    assertOnWaterAt(pastEast, pastEastAim);
    assert.equal(yawByteOf(pastEast), EAST_STEP + Math.floor(OFF_BOUNDARY_STEPS), `facing a look ${OFF_BOUNDARY_STEPS} of a step past east: floor(${EAST_STEP + OFF_BOUNDARY_STEPS})`);
    assert.ok(await holdsWithin(subject, () => carried() === BOATS_CARRIED - 1, PLACE_WALL_MS), "the stack did not lose its boat");
    assert.equal(bot.inventory.slots[36], null, "the used stack is not gone from the hand slot");
    assert.equal(await useBoatAt(subject, 1, pastEastAim), null, "a second boat was put on the spot the first holds");
    assert.equal(carried(), BOATS_CARRIED - 1, "the stack changed after a use on a held spot");
    await subject.removeMob(pastEast);
    const onWater = await useBoatAt(subject, 1, beforeEastAim);
    assert.ok(onWater !== null, "no boat entity after a use at the water spot the first boat left");
    assertOnWaterAt(onWater, beforeEastAim);
    assert.equal(yawByteOf(onWater), EAST_STEP + Math.floor(-OFF_BOUNDARY_STEPS), `facing a look ${OFF_BOUNDARY_STEPS} of a step before east: floor(${EAST_STEP - OFF_BOUNDARY_STEPS}), not the rounded ${EAST_STEP}`);
    assert.ok(await holdsWithin(subject, () => carried() === BOATS_CARRIED - 2, PLACE_WALL_MS), "the second boat was not taken from its stack");
    const onGround = await useBoatAt(subject, 2, inReachAim);
    assert.ok(onGround !== null, "no boat after a use at ground 4.4 blocks away");
    assert.ok(onGround.position.distanceTo(inReachAim) < POINT_TOLERANCE, `put at ${onGround.position}, not at ${inReachAim}`);
    assert.ok(await holdsWithin(subject, () => carried() === BOATS_CARRIED - 3, PLACE_WALL_MS), "the third boat was not taken from its stack");
    // The boat on water sinks to its rest level and stays (it bobs for about 1.5 s first).
    const rest = WATER_SURFACE_Y - REST_BELOW_SURFACE;
    assert.ok(await holdsWithin(subject, () => Math.abs(onWater.position.y - rest) < REST_TOLERANCE, REST_WAIT_MS), `the boat on water is at y ${onWater.position.y}, not near its rest level ${rest}`);
    // Next action from here: the boat she put beside her takes her, and she gets off to stand.
    bot.mount(onWater);
    assert.ok(await holdsWithin(subject, () => bot.vehicle?.id === onWater.id, SEAT_WALL_MS), "the boat she put was not mounted");
    assert.equal(await subject.seatedOnServer(onWater), true, "the server does not have her seated in the boat she put");
    await getOffAndStand(subject, onWater);
  },
};
