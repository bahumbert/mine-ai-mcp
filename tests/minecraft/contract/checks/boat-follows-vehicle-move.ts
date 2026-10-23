/**
 * The rider's `vehicle_move` (what `BoatRide` writes) moves the server's boat and the client sees it follow within a
 * tick or two; a move into a block is put back: the server sends its own `vehicle_move` with the last position it
 * accepted and the boat stays there; a `vehicle_move` from a bot the server does not have seated moves nothing and is not answered (Mine
 * Labs 1.21.4, 2026-10-23). The boat is 1.375 wide: a move to x 4.2986 (edge 4.986) was taken, to 4.4986 (edge 5.186,
 * inside the bank block at x 5) was not.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { WATER_POOL_CELLS, boatSummonedAt, getOffAndStand, mountBoat } from "./boat-seat.ts";

/** The boat in the pool's middle at its surface; it floats down to its rest level in a second or two. */
const BOAT_AT = [3.5, -60.111, 0.5] as const;
/** A step of the ride (`BOAT_STEP` in `boat-crossing.ts` is of this order), and the gap between steps. */
const STEP = 0.2;
const STEP_GAP_MS = 50;
/** The boat follows within the server's tick and the entity broadcast: well under a second on a server on time. */
const FOLLOW_WALL_MS = 2_000;
const QUIET_MS = 1_000;
const TOLERANCE = 0.01;
/** Steps from the pool's middle (x 3.5) that stay clear of the bank: the last is x 4.3. */
const FREE_STEPS = 4;
const REST_WAIT_MS = 2_500;
const NOT_SEATED_SHIFT = 0.3;

/** Whether the boat stays at `x` for `QUIET_MS`. */
async function staysAt(subject: ContractSubject, x: number): Promise<boolean> {
  const boat = boatSummonedAt(subject, BOAT_AT)!;
  return !(await holdsWithin(subject, () => Math.abs(boat.position.x - x) > TOLERANCE, QUIET_MS));
}

export const boatFollowsVehicleMove: ContractCheck = {
  name: "boat-follows-vehicle-move",
  fixture: { cells: { ...WATER_POOL_CELLS }, carried: {}, position: [0.5, -60, 0.5], entities: [{ name: "oak_boat", position: [...BOAT_AT] }] },
  // Bare bot: our runtime would take the body (`boat-crossing.ts`).
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boat = boatSummonedAt(subject, BOAT_AT);
    assert.ok(boat !== undefined, "no oak_boat entity in view");
    await subject.wait(REST_WAIT_MS);
    const { y, z } = boat.position;
    let { x } = boat.position;
    const startX = x;
    const corrections: { x: number; y: number; z: number }[] = [];
    const onCorrection = (packet: { x: number; y: number; z: number }) => void corrections.push(packet);
    bot._client.on("vehicle_move", onCorrection);
    bot._client.write("vehicle_move", { x: x + NOT_SEATED_SHIFT, y, z, yaw: -90, pitch: 0, onGround: false });
    assert.ok(await staysAt(subject, startX), "a vehicle_move from a bot not seated in the boat moved it");
    assert.equal(corrections.length, 0, "a vehicle_move from a bot not seated in the boat was answered");
    await mountBoat(subject, BOAT_AT);
    try {
      for (let step = 0; step < FREE_STEPS; step += 1) {
        x += STEP;
        bot._client.write("vehicle_move", { x, y, z, yaw: -90, pitch: 0, onGround: false });
        await subject.wait(STEP_GAP_MS);
      }
      assert.ok(await holdsWithin(subject, () => Math.abs(boat.position.x - x) < TOLERANCE, FOLLOW_WALL_MS), `the boat is at x ${boat.position.x}, not at the x ${x} the moves took it to`);
      assert.equal(corrections.length, 0, "a move inside the pool was put back");
      const lastFree = x;
      x += STEP;
      bot._client.write("vehicle_move", { x, y, z, yaw: -90, pitch: 0, onGround: false });
      assert.ok(await holdsWithin(subject, () => corrections.length > 0, FOLLOW_WALL_MS), "a move into the bank block was not put back");
      assert.ok(Math.abs(corrections[0]!.x - lastFree) < TOLERANCE, `put back to x ${corrections[0]!.x}, not to the last accepted ${lastFree}`);
      assert.ok(await staysAt(subject, lastFree), `the boat did not stay at x ${lastFree}`);
    } finally {
      bot._client.off("vehicle_move", onCorrection);
    }
    assert.equal(await subject.seatedOnServer(boat), true, "the server freed her after the boat's moves");
    await getOffAndStand(subject, boat);
  },
};
