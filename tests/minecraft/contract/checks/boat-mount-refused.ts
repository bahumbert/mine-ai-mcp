/**
 * A mount the server refuses is answered with nothing at all (Mine Labs 1.21.4, 2026-10-23): no `mount`, no passenger
 * list, the bot is free and her physics run. A boat 7 blocks off (6.4 from her eye to its box) is refused, one 6 blocks
 * off (5.4) is taken; a boat with its two seats taken is refused, one with a single passenger takes her as the second
 * (the list names both).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { getOffAndStand } from "./boat-seat.ts";

/** Longer than any answer of a server on time: a refusal is shown by this much silence. */
const SILENCE_MS = 1_500;
const SEAT_WALL_MS = 3_000;
const BOAT_SPAWN_WALL_MS = 5_000;

/** Whether she was seated, and the passenger lists of `boat` she heard, after trying to mount it. */
async function tryMount(subject: ContractSubject, boat: Entity): Promise<{ mounted: boolean; lists: number[][] }> {
  const { bot } = subject;
  const lists: number[][] = [];
  let mounts = 0;
  const onList = (packet: { entityId: number; passengers: number[] }) => void (packet.entityId === boat.id && lists.push(packet.passengers));
  const onMount = () => void (mounts += 1);
  bot._client.on("set_passengers", onList);
  bot.on("mount", onMount);
  try {
    bot.mount(boat);
    const seated = await holdsWithin(subject, () => bot.vehicle?.id === boat.id, SEAT_WALL_MS);
    if (!seated) await holdsWithin(subject, () => false, SILENCE_MS);
    return { mounted: seated && mounts === 1, lists };
  } finally {
    bot._client.off("set_passengers", onList);
    bot.off("mount", onMount);
  }
}

/** The fixture's boat standing at `x` `z`. */
async function boatAt(subject: ContractSubject, x: number, z: number): Promise<Entity> {
  const at = subject.world([x, -60, z]);
  const find = () => Object.values(subject.bot.entities).find((entity) => entity.name === "oak_boat" && Math.abs(entity.position.x - at.x) < 0.2 && Math.abs(entity.position.z - at.z) < 0.2);
  assert.ok(await holdsWithin(subject, () => find() !== undefined, BOAT_SPAWN_WALL_MS), `no oak_boat entity at ${at.x} ${at.z}`);
  return find()!;
}

/** A refused mount: nothing heard, the server has no rider of hers, and her physics run. */
async function assertRefused(subject: ContractSubject, boat: Entity, why: string): Promise<void> {
  const { bot } = subject;
  const answer = await tryMount(subject, boat);
  assert.equal(answer.mounted, false, `the server seated her in ${why}`);
  assert.deepEqual(answer.lists, [], `the server answered a refused mount (${why}) with a passenger list`);
  assert.equal(await subject.seatedOnServer(boat), false, `the server has her seated in ${why}`);
  assert.equal(bot.vehicle ?? null, null, `her client has a vehicle after a refused mount (${why})`);
  let ticks = 0;
  const onTick = () => void (ticks += 1);
  bot.on("physicsTick", onTick);
  try {
    assert.ok(await holdsWithin(subject, () => ticks >= 5, 1_000), `no physics tick after a refused mount (${why}): the bot is frozen`);
  } finally {
    bot.off("physicsTick", onTick);
  }
}

export const boatMountRefused: ContractCheck = {
  name: "boat-mount-refused",
  fixture: {
    cells: {},
    carried: {},
    position: [0.5, -60, 0.5],
    entities: [
      { name: "oak_boat", position: [0.5, -60, -6.5] },
      { name: "oak_boat", position: [6.5, -60, 0.5] },
      { name: "oak_boat", position: [6.5, -60, 3.5], passengers: ["armor_stand", "armor_stand"] },
      { name: "oak_boat", position: [6.5, -60, -2.5], passengers: ["armor_stand"] },
    ],
  },
  // Bare bot: our runtime would act on a boat it finds (`boat-crossing.ts`).
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    await assertRefused(subject, await boatAt(subject, 0.5, -6.5), "a boat 7 blocks off");
    // The boat at the edge of the reach is taken; she gets off beside it, where the two boats with passengers are near.
    const edge = await boatAt(subject, 6.5, 0.5);
    const taken = await tryMount(subject, edge);
    assert.equal(taken.mounted, true, "the server refused a boat 6 blocks off");
    assert.equal(await subject.seatedOnServer(edge), true, "the server does not have her seated in the boat 6 blocks off");
    await getOffAndStand(subject, edge);
    await assertRefused(subject, await boatAt(subject, 6.5, 3.5), "a boat with its two seats taken");
    const shared = await boatAt(subject, 6.5, -2.5);
    const second = await tryMount(subject, shared);
    assert.equal(second.mounted, true, "the server refused a boat with one passenger");
    const riders = second.lists.at(-1) ?? [];
    assert.ok(riders.includes(bot.entity.id) && riders.length === 2, `the list of a boat with one passenger is ${JSON.stringify(riders)}, not her and the passenger`);
    assert.equal(await subject.seatedOnServer(shared), true, "the server does not have her seated as the second rider");
    await getOffAndStand(subject, shared);
  },
};
