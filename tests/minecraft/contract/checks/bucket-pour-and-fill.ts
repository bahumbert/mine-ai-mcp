/**
 * A bucket used (`use_item`, `inventory.js:127`) acts on what the look meets within the block reach of 4.5 blocks (Mine
 * Labs 1.21.4, 2026-10-23). A water bucket pours a source into the cell above the face it meets (the cell in front of a
 * side face) and becomes an empty bucket; an empty bucket facing a water source takes it, leaving air, and becomes a
 * water bucket (in its own slot, or in the first free hotbar slot when the stack holds more than one bucket). A look at
 * the sky or at ground out of reach changes nothing, and the stack is kept.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { type ContractSubject, holdsWithin } from "../subject.ts";
import { stackOf } from "../window-packets.ts";

/** The use is answered within a tick or two on a server on time; a bound with room for one behind. */
const ANSWER_WALL_MS = 2_000;
/** An absence is shown over this long. */
const ABSENCE_MS = 1_500;
/** The forced look reaches the server with the use packet (`rotation`); a short wait lets the physics tick send it too. */
const LOOK_SETTLE_MS = 300;
const USE_HOLD_MS = 100;
/** The top face of the floor block at (2, -61, 0): the pour lands in the cell above it. */
const FLOOR_AIM = new Vec3(2.5, -60, 0.5);
const POURED_CELL = new Vec3(2, -60, 0);
/** The east face of the wall block at (-3, -60, 0): the pour lands in the cell in front of it. */
const WALL_AIM = new Vec3(-2, -59.5, 0.5);
const WALL_POURED_CELL = new Vec3(-2, -60, 0);
const SKY_AIM = new Vec3(0.5, 20, 0.5);
/** Dry floor, 3.4 blocks from the eye. */
const DRY_FLOOR_AIM = new Vec3(3.5, -60, 2.5);
/** Ground 5.3 blocks from the eye, past the reach. */
const OUT_OF_REACH_AIM = new Vec3(5.5, -60, 0.5);
const WATER_BUCKET_SLOT = 36;
const BUCKET_STACK_SLOT = 37;
const FIRST_FREE_HOTBAR_SLOT = 38;

/** What the client heard of a cell and of the slots while a bucket was used. */
interface Heard {
  readonly cell: string[];
  readonly slots: Record<number, string | null>;
  /** The kinds of change in the order they arrived: `cell` and `slot:<n>`. */
  readonly order: string[];
}

/** Select hotbar slot `slot`, look at `aimLocal` (arena-local, like `watchingLocal`), use the held item once, and wait `waitMs` for what the server answers. */
async function useBucketAt(subject: ContractSubject, slot: number, aimLocal: Vec3, watchingLocal: Vec3, waitMs: number): Promise<Heard> {
  const { bot } = subject;
  const aim = subject.world([aimLocal.x, aimLocal.y, aimLocal.z]);
  const watching = subject.world([watchingLocal.x, watchingLocal.y, watchingLocal.z]);
  const heard: Heard = { cell: [], slots: {}, order: [] };
  const eventName = `blockUpdate:${watching}` as "blockUpdate:(x, y, z)";
  const onCell = (_before: unknown, after: { readonly name: string; getProperties(): Record<string, unknown> } | null) => {
    heard.cell.push(after === null ? "null" : after.name === "water" ? `water level ${String(after.getProperties().level)}` : after.name);
    heard.order.push("cell");
  };
  const onAck = () => void heard.order.push("ack");
  bot._client.on("acknowledge_player_digging", onAck);
  const onUpdateSlot = (slotNumber: number, oldItem: Parameters<typeof stackOf>[0], newItem: Parameters<typeof stackOf>[0]) => {
    if (stackOf(oldItem) === stackOf(newItem)) return;
    heard.slots[slotNumber] = stackOf(bot.inventory.slots[slotNumber]);
    heard.order.push(`slot:${slotNumber}`);
  };
  bot.setQuickBarSlot(slot - WATER_BUCKET_SLOT);
  await subject.wait(USE_HOLD_MS);
  await bot.lookAt(aim, true);
  await subject.wait(LOOK_SETTLE_MS);
  bot.on(eventName, onCell);
  bot.inventory.on("updateSlot", onUpdateSlot);
  try {
    bot.activateItem();
    await subject.wait(USE_HOLD_MS);
    bot.deactivateItem();
    await holdsWithin(subject, () => heard.cell.length > 0 && Object.keys(heard.slots).length > 0, waitMs);
    await subject.wait(USE_HOLD_MS);
  } finally {
    bot.off(eventName, onCell);
    bot.inventory.off("updateSlot", onUpdateSlot);
    bot._client.off("acknowledge_player_digging", onAck);
  }
  return heard;
}

export const bucketPourAndFill: ContractCheck = {
  name: "bucket-pour-and-fill",
  fixture: { cells: { "-3,-60,0": "stone" }, carried: { water_bucket: 1, bucket: 2 }, position: [0.5, -60, 0.5] },
  // Bare bot: our runtime would act on the bucket and the water it finds.
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const slotOf = (slot: number) => stackOf(bot.inventory.slots[slot]);
    assert.deepEqual([slotOf(WATER_BUCKET_SLOT), slotOf(BUCKET_STACK_SLOT)], ["water_bucket x1", "bucket x2"], "the fixture's buckets");
    const dry = await useBucketAt(subject, BUCKET_STACK_SLOT, DRY_FLOOR_AIM, POURED_CELL, ABSENCE_MS);
    assert.deepEqual(dry.order, ["ack"], `an empty bucket at dry floor is only acknowledged: ${dry.order.join(", ")}`);
    assert.equal(slotOf(BUCKET_STACK_SLOT), "bucket x2", "the empty buckets changed after a use on dry floor");
    for (const [label, aim] of [["the sky", SKY_AIM], ["ground past the reach", OUT_OF_REACH_AIM]] as const) {
      const heard = await useBucketAt(subject, WATER_BUCKET_SLOT, aim, POURED_CELL, ABSENCE_MS);
      assert.deepEqual(heard.order, ["ack"], `a pour at ${label} is only acknowledged: ${heard.order.join(", ")}`);
      assert.equal(slotOf(WATER_BUCKET_SLOT), "water_bucket x1", `the water bucket changed after a pour at ${label}`);
    }
    const poured = await useBucketAt(subject, WATER_BUCKET_SLOT, FLOOR_AIM, POURED_CELL, ANSWER_WALL_MS);
    assert.equal(poured.cell[0], "water level 0", `the pour on the floor: the cell above it heard ${poured.cell.join(", ")}`);
    assert.equal(poured.slots[WATER_BUCKET_SLOT], "bucket x1", "the water bucket is an empty bucket after the pour");
    assert.deepEqual(poured.order, [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"], "the slot comes first, then the block change, then the acknowledgement");
    const filled = await useBucketAt(subject, WATER_BUCKET_SLOT, FLOOR_AIM, POURED_CELL, ANSWER_WALL_MS);
    assert.equal(filled.cell[0], "air", `the empty bucket took the source: the cell heard ${filled.cell.join(", ")}`);
    assert.equal(filled.slots[WATER_BUCKET_SLOT], "water_bucket x1", "the empty bucket is a water bucket after the fill");
    // The water around the taken source then flows into its cell, which the server also sends.
    assert.deepEqual(filled.order.slice(0, 3), [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"], "a fill answers in the order of a pour");
    const side = await useBucketAt(subject, WATER_BUCKET_SLOT, WALL_AIM, WALL_POURED_CELL, ANSWER_WALL_MS);
    assert.equal(side.cell[0], "water level 0", `the pour at a wall's face: the cell in front of it heard ${side.cell.join(", ")}`);
    assert.equal(side.slots[WATER_BUCKET_SLOT], "bucket x1");
    // A stack of two buckets: one is used up and the water bucket goes to the first free hotbar slot.
    const fromStack = await useBucketAt(subject, BUCKET_STACK_SLOT, WALL_AIM, WALL_POURED_CELL, ANSWER_WALL_MS);
    assert.equal(fromStack.cell[0], "air", `the stacked buckets took the source: the cell heard ${fromStack.cell.join(", ")}`);
    assert.equal(fromStack.slots[BUCKET_STACK_SLOT], "bucket x1", "one bucket of the stack is used");
    assert.equal(fromStack.slots[FIRST_FREE_HOTBAR_SLOT], "water_bucket x1", "the water bucket is in the first free hotbar slot");
  },
};
