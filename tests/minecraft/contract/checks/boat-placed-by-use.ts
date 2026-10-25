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
import { afterClientTicks, answerArrives, serverQuiet } from "../server-answer.ts";
import type { ContractSubject, LocalPoint } from "../subject.ts";
import { WATER_POOL_CELLS, WATER_SURFACE_Y, getOffAndStand } from "./boat-seat.ts";

const BOATS_CARRIED = 3;
/**
 * Physics ticks after the forced look: `lookAt(aim, true)` sets the look to send at once (`physics.js:331-353`) and the next physics tick
 * sends it (`updatePosition`, `physics.js:184-193`); the second tick leaves room for the order of the tick's own steps.
 */
const LOOK_SENT_TICKS = 2;
/** The client holds the item this long around the use (its own action, a client clock: the use packet itself is sent at `activateItem`). */
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
const POINT_TOLERANCE = 0.02;
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

/** The boat stood where the look met the water when the client heard it: `point` in x and z, the water's surface in y. */
function assertOnWaterAt({ spawnedAt }: PutBoat, point: Vec3): void {
  assert.ok(Math.hypot(spawnedAt.x - point.x, spawnedAt.z - point.z) < POINT_TOLERANCE, `put at ${spawnedAt}, not at the aimed point ${point}`);
  assert.ok(Math.abs(spawnedAt.y - WATER_SURFACE_Y) < POINT_TOLERANCE, `put at y ${spawnedAt.y}, not at the water surface ${WATER_SURFACE_Y}`);
}

/** A boat the server put: the entity, and where it was when the client heard it spawn (a boat on water sinks to its rest within 1.5 s, so a later read of the entity is lower). */
interface PutBoat {
  readonly boat: Entity;
  readonly spawnedAt: Vec3;
}

/** What a use of the held boat brought: the boat that spawned, if any, and the end of the listening to spawns. */
interface BoatUse {
  put(): PutBoat | undefined;
  stop(): void;
}

/** Select hotbar slot `slot`, look at `aim`, use the held item once; what finds the boat that spawned (none when nothing was put). */
async function useBoatAt(subject: ContractSubject, slot: number, aim: Vec3): Promise<BoatUse> {
  const { bot } = subject;
  let put: PutBoat | undefined;
  const onSpawn = (entity: Entity) => {
    if (entity.name === "oak_boat" && put === undefined) put = { boat: entity, spawnedAt: entity.position.clone() };
  };
  bot.setQuickBarSlot(slot);
  // Kept from the old check: the hotbar packet goes before the use on one connection, so the server does not need this hold; whether the client does is unmeasured.
  await subject.wait(USE_HOLD_MS);
  await bot.lookAt(aim, true);
  await afterClientTicks(subject, LOOK_SENT_TICKS, "the look before the use");
  bot.on("entitySpawn", onSpawn);
  try {
    bot.activateItem();
    await subject.wait(USE_HOLD_MS);
    bot.deactivateItem();
  } catch (error) {
    bot.off("entitySpawn", onSpawn);
    throw error;
  }
  return { put: () => put, stop: () => void bot.off("entitySpawn", onSpawn) };
}

/** The boat the server put when the held boat is used at `aim`: waited for, failing with `what` when none comes. */
async function boatPutAt(subject: ContractSubject, slot: number, aim: Vec3, what: string): Promise<PutBoat> {
  const use = await useBoatAt(subject, slot, aim);
  try {
    await answerArrives(subject, () => use.put() !== undefined, what);
    return use.put()!;
  } finally {
    use.stop();
  }
}

/** The server puts nothing when the held boat is used at `aim`: the ticks of an absence pass, then no boat spawned. */
async function assertNoBoatPutAt(subject: ContractSubject, slot: number, aim: Vec3, why: string): Promise<void> {
  const use = await useBoatAt(subject, slot, aim);
  try {
    await serverQuiet(subject, `after a use at ${why}`);
    assert.equal(use.put(), undefined, `a boat was put when used at ${why}`);
  } finally {
    use.stop();
  }
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
      await assertNoBoatPutAt(subject, 0, subject.world(aim), label);
      assert.equal(carried(), BOATS_CARRIED, `the stack changed after a use at ${label}`);
    }
    // The yaw is the look's floored to a byte: a look 0.3 of a step past east (-63.7) gives -64, 0.3 before it (-64.3) gives -65
    // (rounding gives -64 for both). Two boats on one spot, so the first is taken away (two on a 3-wide pool push each other).
    const pastEastAim = aimPastEast(bot.entity.position, subject.world(WATER_AIM), OFF_BOUNDARY_STEPS);
    const beforeEastAim = aimPastEast(bot.entity.position, subject.world(WATER_AIM), -OFF_BOUNDARY_STEPS);
    const inReachAim = subject.world(IN_REACH_AIM);
    const pastEast = await boatPutAt(subject, 0, pastEastAim, "no boat entity after a use at water 3 blocks away");
    assertOnWaterAt(pastEast, pastEastAim);
    assert.equal(yawByteOf(pastEast.boat), EAST_STEP + Math.floor(OFF_BOUNDARY_STEPS), `facing a look ${OFF_BOUNDARY_STEPS} of a step past east: floor(${EAST_STEP + OFF_BOUNDARY_STEPS})`);
    await answerArrives(subject, () => carried() === BOATS_CARRIED - 1, "the stack did not lose its boat");
    assert.equal(bot.inventory.slots[36], null, "the used stack is not gone from the hand slot");
    await assertNoBoatPutAt(subject, 1, pastEastAim, "a spot the first boat holds");
    assert.equal(carried(), BOATS_CARRIED - 1, "the stack changed after a use on a held spot");
    await subject.removeMob(pastEast.boat);
    const onWater = await boatPutAt(subject, 1, beforeEastAim, "no boat entity after a use at the water spot the first boat left");
    assertOnWaterAt(onWater, beforeEastAim);
    assert.equal(yawByteOf(onWater.boat), EAST_STEP + Math.floor(-OFF_BOUNDARY_STEPS), `facing a look ${OFF_BOUNDARY_STEPS} of a step before east: floor(${EAST_STEP - OFF_BOUNDARY_STEPS}), not the rounded ${EAST_STEP}`);
    await answerArrives(subject, () => carried() === BOATS_CARRIED - 2, "the second boat was not taken from its stack");
    const onGround = await boatPutAt(subject, 2, inReachAim, "no boat after a use at ground 4.4 blocks away");
    assert.ok(onGround.spawnedAt.distanceTo(inReachAim) < POINT_TOLERANCE, `put at ${onGround.spawnedAt}, not at ${inReachAim}`);
    await answerArrives(subject, () => carried() === BOATS_CARRIED - 3, "the third boat was not taken from its stack");
    // The boat on water sinks to its rest level and stays (it bobs for about 1.5 s first).
    const rest = WATER_SURFACE_Y - REST_BELOW_SURFACE;
    await answerArrives(subject, () => Math.abs(onWater.boat.position.y - rest) < REST_TOLERANCE, `the boat on water did not come to its rest level ${rest}`);
    // Next action from here: the boat she put beside her takes her, and she gets off to stand.
    bot.mount(onWater.boat);
    await answerArrives(subject, () => bot.vehicle?.id === onWater.boat.id, "the boat she put was not mounted");
    assert.equal(await subject.seatedOnServer(onWater.boat), true, "the server does not have her seated in the boat she put");
    await getOffAndStand(subject, onWater.boat);
  },
};
