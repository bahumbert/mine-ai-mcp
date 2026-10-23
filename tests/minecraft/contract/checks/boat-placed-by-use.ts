/**
 * A boat held and used (`use_item`, `inventory.js:127`) is put where the look meets water or ground within the reach of
 * 4.5 blocks (Mine Labs 1.21.4, 2026-10-23): the boat entity appears at that point, facing the way she looks, and the
 * stack loses its one boat; on water it sinks to rest 0.37 below the surface within 1.5 s. Nothing is put (stack kept)
 * for a look at the sky, at ground past the reach (put at 4.4, not at 4.7), at a wall (the boat would stand in it), or
 * on a spot another boat holds. A boat stacks to 1, so the next one is the next hotbar slot.
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
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
const IN_REACH_AIM = new Vec3(0.5, -60, -3.59);
const OUT_OF_REACH_AIM = new Vec3(0.5, -60, -3.91);
const WATER_AIM = new Vec3(3.5, WATER_SURFACE_Y, 0.5);
/** The east face of the wall block at (-3, -60, 0). */
const WALL_AIM = new Vec3(-2, -59.5, 0.5);
const SKY_AIM = new Vec3(0.5, 20, 0.5);
/** A boat's rest level on water, below the surface (-60.477 from -60.111 on the server). */
const REST_BELOW_SURFACE = 0.366;
const REST_TOLERANCE = 0.05;
const REST_WAIT_MS = 3_000;
const POINT_TOLERANCE = 0.02;
const SEAT_WALL_MS = 3_000;
/** An entity yaw of a boat facing east (Mineflayer's radians, 0 to 2 pi). */
const EAST_ENTITY_YAW = (3 * Math.PI) / 2;

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
      assert.equal(await useBoatAt(subject, 0, aim), null, `a boat was put when used at ${label}`);
      assert.equal(carried(), BOATS_CARRIED, `the stack changed after a use at ${label}`);
    }
    const onWater = await useBoatAt(subject, 0, WATER_AIM);
    assert.ok(onWater !== null, "no boat entity after a use at water 3 blocks away");
    assert.ok(Math.hypot(onWater.position.x - WATER_AIM.x, onWater.position.z - WATER_AIM.z) < POINT_TOLERANCE, `put at ${onWater.position}, not at the aimed point ${WATER_AIM}`);
    assert.ok(Math.abs(onWater.position.y - WATER_SURFACE_Y) < POINT_TOLERANCE, `put at y ${onWater.position.y}, not at the water surface ${WATER_SURFACE_Y}`);
    assert.ok(Math.abs(onWater.yaw - EAST_ENTITY_YAW) < POINT_TOLERANCE, `facing ${onWater.yaw} rad: she looked east (${EAST_ENTITY_YAW})`);
    assert.ok(await holdsWithin(subject, () => carried() === BOATS_CARRIED - 1, PLACE_WALL_MS), "the stack did not lose its boat");
    assert.equal(bot.inventory.slots[36], null, "the used stack is not gone from the hand slot");
    assert.equal(await useBoatAt(subject, 1, WATER_AIM), null, "a second boat was put on the spot the first holds");
    assert.equal(carried(), BOATS_CARRIED - 1, "the stack changed after a use on a held spot");
    const onGround = await useBoatAt(subject, 1, IN_REACH_AIM);
    assert.ok(onGround !== null, "no boat after a use at ground 4.4 blocks away");
    assert.ok(onGround.position.distanceTo(IN_REACH_AIM) < POINT_TOLERANCE, `put at ${onGround.position}, not at ${IN_REACH_AIM}`);
    assert.ok(await holdsWithin(subject, () => carried() === BOATS_CARRIED - 2, PLACE_WALL_MS), "the second boat was not taken from its stack");
    // The first boat sinks to its rest level and stays (it bobs for about 1.5 s first).
    const rest = WATER_SURFACE_Y - REST_BELOW_SURFACE;
    assert.ok(await holdsWithin(subject, () => Math.abs(onWater.position.y - rest) < REST_TOLERANCE, REST_WAIT_MS), `the boat on water is at y ${onWater.position.y}, not near its rest level ${rest}`);
    // Next action from here: the boat she put beside her takes her, and she gets off to stand.
    bot.mount(onWater);
    assert.ok(await holdsWithin(subject, () => bot.vehicle?.id === onWater.id, SEAT_WALL_MS), "the boat she put was not mounted");
    assert.equal(await subject.seatedOnServer(onWater), true, "the server does not have her seated in the boat she put");
    await getOffAndStand(subject, onWater);
  },
};
