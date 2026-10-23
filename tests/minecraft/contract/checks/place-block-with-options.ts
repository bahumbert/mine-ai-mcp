/**
 * `_placeBlockWithOptions` (`place_block.js`, `generic_place.js`) sends the click on a block's face with a cursor inside
 * the face, and the 1.21.4 server (Mine Labs, 2026-10-23) reads the cursor: a slab or a stair put on a side face takes
 * the half the click was in (`half: 'top'` clicks at 0.75 of the face, `'bottom'` at 0.25, a `delta` at its own height);
 * `offhand: true` places the block the off hand holds, one taken from that stack; `forceLook: 'ignore'` leaves the look
 * where it was. The server answers one placement with the cell's block change and one acknowledgement of its sequence.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin, settleWithin } from "../subject.ts";
import { stackOf } from "../window-packets.ts";

/** Mineflayer's own wait for the block update is 5 s; a server on time answers in a tick or two. */
const PLACEMENT_WALL_MS = 6_000;
const SLOT_WALL_MS = 2_000;
/** The rest of an answer arrives in the same server tick as its first packet; this long covers a server a tick behind. */
const AFTER_ANSWER_MS = 500;
/** The setup has just put her on the floor: the first click of a run was once lost (Mine Labs 2026-10-23, 1 run in 3). */
const START_SETTLE_MS = 1_000;
const WEST = new Vec3(-1, 0, 0);
const UP = new Vec3(0, 1, 0);
/** The stone blocks the placements click on, with the cell each puts its block in (west of it). */
const REFERENCES = { slabTop: 0, slabBottom: 2, slabDelta: -2, stairTop: 4, offHand: -4, refused: 6 } as const;
const referenceOf = (z: number) => new Vec3(2, -60, z);
/** The off hand's slot in a window (`inventory.js`). */
const OFF_HAND_SLOT = 45;
const LOOK_TOLERANCE = 0.05;
/** A bed put on the floor looking east: the foot above the floor block, the head one east of it. */
const BED_FLOOR = new Vec3(4, -61, 2);
const BED_FOOT = new Vec3(4, -60, 2);
const BED_HEAD = new Vec3(5, -60, 2);
/** Mineflayer's yaw of a look to the east (`placement.ts` turns to `atan2(-x, -z)`). */
const EAST_YAW = -Math.PI / 2;
const BED_HOTBAR_SLOT = 3;

type PlacementOptions = { half?: "top" | "bottom"; delta?: Vec3; forceLook?: boolean | "ignore"; offhand?: boolean; swingArm?: "right" | "left" };
type WithOptions = { _placeBlockWithOptions(reference: Block, face: Vec3, options: PlacementOptions): Promise<void> };

/** What the client heard while one placement ran. */
interface Heard {
  /** The destination cell's block as each `blockUpdate` showed it. */
  readonly changes: string[];
  /** The packets about the placement in arrival order: `block_change ref|dest`, `set_slot <n>`, `ack`. */
  readonly packets: string[];
}

/** Place with `options` against the west face of the stone at `z`, and report what the client heard. */
function placeAt(subject: ContractSubject, z: number, options: PlacementOptions, refusal?: RegExp): Promise<Heard> {
  return placeAgainst(subject, referenceOf(z), WEST, options, refusal);
}

/** Place with `options` against `face` of the block at `reference`, and report what the client heard. */
async function placeAgainst(subject: ContractSubject, reference: Vec3, face: Vec3, options: PlacementOptions, refusal?: RegExp): Promise<Heard> {
  const { bot } = subject;
  const heard: Heard = { changes: [], packets: [] };
  const destination = reference.plus(face);
  const eventName = `blockUpdate:${destination}` as "blockUpdate:(x, y, z)";
  const onCell = (_before: unknown, after: Block | null) => {
    const { type, half } = after?.getProperties() ?? {};
    heard.changes.push(after === null ? "null" : [after.name, type, half].filter((part) => part !== undefined).join(" "));
  };
  const at = (cell: Vec3, { x, y, z }: { x: number; y: number; z: number }) => cell.x === x && cell.y === y && cell.z === z;
  const onChange = (packet: { location: { x: number; y: number; z: number } }) => void heard.packets.push(`block_change ${at(reference, packet.location) ? "ref" : at(destination, packet.location) ? "dest" : "elsewhere"}`);
  const onSlot = (slot: number, before: Parameters<typeof stackOf>[0], after: Parameters<typeof stackOf>[0]) => {
    if (stackOf(before) !== stackOf(after)) heard.packets.push(`set_slot ${slot}`);
  };
  const onAck = () => void heard.packets.push("ack");
  bot.on(eventName, onCell);
  bot._client.on("block_change", onChange);
  bot.inventory.on("updateSlot", onSlot);
  bot._client.on("acknowledge_player_digging", onAck);
  try {
    const placing = (bot as unknown as WithOptions)._placeBlockWithOptions(bot.blockAt(reference)!, face, options);
    const settled = await settleWithin(subject, placing, PLACEMENT_WALL_MS);
    if (refusal === undefined) assert.ok(settled !== null && settled.error === undefined, `_placeBlockWithOptions at ${destination}: ${settled?.error?.message ?? "never ended"}`);
    else assert.match(settled?.error?.message ?? "never ended", refusal, `_placeBlockWithOptions at ${destination} was not refused as expected: ${settled?.error?.message ?? "never ended"} (${heard.packets.join(", ")})`);
    await subject.wait(AFTER_ANSWER_MS);
  } finally {
    bot.off(eventName, onCell);
    bot._client.off("block_change", onChange);
    bot.inventory.off("updateSlot", onSlot);
    bot._client.off("acknowledge_player_digging", onAck);
  }
  return heard;
}

export const placeBlockWithOptions: ContractCheck = {
  name: "place-block-with-options",
  fixture: {
    // The refused placement's destination holds stone already.
    cells: { ...Object.fromEntries(Object.values(REFERENCES).map((z) => [`2,-60,${z}`, "stone"])), "1,-60,6": "stone" },
    carried: { oak_slab: 4, oak_stairs: 1, cobblestone: 1, red_bed: 1 },
    position: [0.5, -60, 0.5],
  },
  // Bare bot: our runtime would act on the blocks she places.
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const slotOf = (slot: number) => stackOf(bot.inventory.slots[slot]);
    await subject.wait(START_SETTLE_MS);
    const top = await placeAt(subject, REFERENCES.slabTop, { half: "top", swingArm: "right" });
    // The server sends the clicked block, the placed block twice (the chunk's change and the click's own update; the client's `blockUpdate` follows each), the slot, then the acknowledgement.
    assert.equal(top.changes[0], "oak_slab top", `a slab put with half 'top': the cell heard ${top.changes.join(", ")}`);
    assert.deepEqual(top.packets, ["block_change ref", "block_change dest", "block_change dest", "set_slot 36", "ack"], "the packets");
    assert.equal(String(bot.blockAt(referenceOf(REFERENCES.slabTop).plus(WEST))!.getProperties().waterlogged), "false", "a slab put in air is not waterlogged");
    const bottom = await placeAt(subject, REFERENCES.slabBottom, { half: "bottom", swingArm: "right" });
    assert.equal(bottom.changes[0], "oak_slab bottom", `a slab put with half 'bottom': the cell heard ${bottom.changes.join(", ")}`);
    // A click whose destination is taken: the server only acknowledges (no correction of either cell), so Mineflayer's own wait runs out.
    const refused = await placeAt(subject, REFERENCES.refused, { half: "bottom", swingArm: "right" }, /Event blockUpdate:\(1, -60, 6\) did not fire within timeout of 5000ms/u);
    assert.deepEqual(refused.packets, ["ack"], "the packets of a refused placement");
    assert.equal(slotOf(36), "oak_slab x2", "a refused placement takes nothing from the stack");
    // `delta` is the click's place in the face, and `forceLook: 'ignore'` leaves the look where it was.
    await bot.look(2, 0.3, true);
    await subject.wait(300);
    const lookBefore = { yaw: bot.entity.yaw, pitch: bot.entity.pitch };
    const delta = await placeAt(subject, REFERENCES.slabDelta, { delta: new Vec3(0, 0.9, 0.5), forceLook: "ignore", swingArm: "right" });
    assert.equal(delta.changes[0], "oak_slab top", `a slab put with a delta at 0.9: the cell heard ${delta.changes.join(", ")}`);
    assert.ok(Math.abs(bot.entity.yaw - lookBefore.yaw) < LOOK_TOLERANCE && Math.abs(bot.entity.pitch - lookBefore.pitch) < LOOK_TOLERANCE, `forceLook 'ignore' moved the look from ${JSON.stringify(lookBefore)} to ${bot.entity.yaw}, ${bot.entity.pitch}`);
    assert.equal(slotOf(36), "oak_slab x1", "three slabs were taken from the main hand's stack");
    bot.setQuickBarSlot(1);
    await subject.wait(100);
    const stairs = await placeAt(subject, REFERENCES.stairTop, { half: "top", swingArm: "right" });
    assert.equal(stairs.changes[0], "oak_stairs top", `stairs put with half 'top': the cell heard ${stairs.changes.join(", ")}`);
    // A bed: put looking east, its foot is where the click lands and its head one block on, the way she looked.
    bot.setQuickBarSlot(BED_HOTBAR_SLOT);
    await subject.wait(100);
    await bot.look(EAST_YAW, 0, true);
    await subject.wait(300);
    const bed = await placeAgainst(subject, BED_FLOOR, UP, { forceLook: "ignore", swingArm: "right" });
    // One resend of the placed cell only: the chunk's own change carries both halves, as one `multi_block_change`.
    assert.deepEqual(bed.packets, ["block_change ref", "block_change dest", "set_slot 39", "ack"], "the packets of a bed");
    assert.ok(await holdsWithin(subject, () => bot.blockAt(BED_HEAD)?.name === "red_bed", SLOT_WALL_MS), "the bed's head half never came");
    const halves = [BED_FOOT, BED_HEAD].map((cell) => bot.blockAt(cell)!.getProperties());
    assert.deepEqual(halves.map(({ part, facing, occupied }) => [part, facing, String(occupied)]), [["foot", "east", "false"], ["head", "east", "false"]], `the bed: ${JSON.stringify(halves)}`);
    bot.setQuickBarSlot(1);
    await subject.wait(100);
    // The off hand: the block it holds is placed and taken from it, the main hand's stack is left alone.
    await bot.equip(bot.inventory.items().find((item) => item.name === "cobblestone")!, "off-hand");
    assert.equal(slotOf(OFF_HAND_SLOT), "cobblestone x1", "the cobblestone is in the off hand");
    const offHand = await placeAt(subject, REFERENCES.offHand, { offhand: true, swingArm: "left" });
    assert.equal(offHand.changes[0], "cobblestone", `a placement with the off hand: the cell heard ${offHand.changes.join(", ")}`);
    assert.equal(slotOf(36), "oak_slab x1", "the main hand's stack was left alone");
    assert.ok(await holdsWithin(subject, () => slotOf(OFF_HAND_SLOT) === null, SLOT_WALL_MS), `the off hand still holds ${slotOf(OFF_HAND_SLOT)}: the server did not take the placed block`);
  },
};
