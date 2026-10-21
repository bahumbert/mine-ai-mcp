/** The boat checks' shared steps: a seat the server confirms, what each side hears for 40 server ticks, and the get-off after. */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { getOff } from "../../../../src/actions/navigate/boat-get-off.ts";
import type { ContractFixture } from "../checks.ts";
import { type ContractSubject, holdsWithin, settleWithin } from "../subject.ts";

/**
 * A boat on the floor two blocks east of the feet, in reach to mount. On land: a pool (2x3 water sources, 2026-10-21)
 * answered the get-off the same way but drifted the boat out of reach and left a walk out of the water to chance.
 */
export const BOAT_FIXTURE: ContractFixture = {
  cells: {},
  carried: {},
  position: [0.5, -60, 0.5],
  entities: [{ name: "oak_boat", position: [2.5, -60, 0.5] }],
};
/** Server ticks a check listens for an answer: what `getOff` waits (`DISMOUNT_SERVER_TICKS`, two time packets). */
const LISTEN_TICKS = 40;
/** The wall bound on those ticks: 2 s on time, more on a server behind (`INVENTORY_SETTLE_WALL_MS` and the like). */
const LISTEN_WALL_MS = 5_000;
/** The summon comes with the trial's start; the seat is one round trip. */
const BOAT_SPAWN_WALL_MS = 5_000;
const SEAT_WALL_MS = 3_000;
const GET_OFF_WALL_MS = 20_000;

/** Find the summoned boat, mount it, and check both sides have her seated. */
export async function mountBoat(subject: ContractSubject): Promise<Entity> {
  const { bot } = subject;
  const boatOf = () => Object.values(bot.entities).find((entity) => entity.name === "oak_boat");
  assert.ok(await holdsWithin(subject, () => boatOf() !== undefined, BOAT_SPAWN_WALL_MS), "no oak_boat entity in view");
  const boat = boatOf()!;
  bot.mount(boat);
  assert.ok(await holdsWithin(subject, () => bot.vehicle?.id === boat.id, SEAT_WALL_MS), "the mount was not confirmed (no passenger list)");
  assert.equal(await subject.seatedOnServer(boat), true, "the server does not have her seated after the mount");
  return boat;
}

/** What the client heard while `LISTEN_TICKS` of world age passed. */
export interface HeardWhileSeated {
  readonly positions: number;
  /** Passenger lists of her boat that leave her out. */
  readonly listsWithoutHer: number;
  readonly physicsTicks: number;
}

/** Listen to positions, passenger lists and physics ticks while 40 server ticks pass. */
export async function listenWhileSeated(subject: ContractSubject, boat: Entity): Promise<HeardWhileSeated> {
  const { bot } = subject;
  const heard = { positions: 0, listsWithoutHer: 0, physicsTicks: 0 };
  const onPosition = () => void (heard.positions += 1);
  const onPassengers = (packet: { entityId: number; passengers: number[] }) => {
    if (packet.entityId === boat.id && !packet.passengers.includes(bot.entity.id)) heard.listsWithoutHer += 1;
  };
  const onTick = () => void (heard.physicsTicks += 1);
  bot.on("forcedMove", onPosition);
  bot._client.on("set_passengers", onPassengers);
  bot.on("physicsTick", onTick);
  const startAge = bot.time.age;
  try {
    const passed = await holdsWithin(subject, () => bot.time.age - startAge >= LISTEN_TICKS, LISTEN_WALL_MS);
    assert.ok(passed, `the world age moved ${bot.time.age - startAge} ticks in ${LISTEN_WALL_MS} ms: the server is stalled`);
  } finally {
    bot.off("forcedMove", onPosition);
    bot._client.off("set_passengers", onPassengers);
    bot.off("physicsTick", onTick);
  }
  return heard;
}

/** The runtime's get-off (`getOff`), then the bot is free on the server and stands with physics running. */
export async function getOffAndStand(subject: ContractSubject, boat: Entity): Promise<void> {
  const { bot } = subject;
  const settled = await settleWithin(subject, getOff(bot), GET_OFF_WALL_MS);
  assert.ok(settled !== null && settled.error === undefined, `getOff: ${settled?.error?.message ?? "never ended"}`);
  assert.equal(settled.value!.answered, true, `getOff ended on ${settled.value!.ended}`);
  assert.equal(await subject.seatedOnServer(boat), false, "the server still has her seated after getOff");
  assert.equal(bot.vehicle ?? null, null, "the client still has a vehicle after getOff");
  let ticks = 0;
  const onTick = () => void (ticks += 1);
  bot.on("physicsTick", onTick);
  try {
    assert.ok(await holdsWithin(subject, () => ticks >= 5, 1_000), "no physics tick after getOff: the bot is frozen");
  } finally {
    bot.off("physicsTick", onTick);
  }
}
