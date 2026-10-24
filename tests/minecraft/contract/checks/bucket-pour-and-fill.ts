/**
 * A bucket used (`use_item`, `inventory.js:127`) acts on what the look meets within the block reach of 4.5 blocks (Mine
 * Labs 1.21.4, 2026-10-23). A water bucket pours a source into the cell above the face it meets (the cell in front of a
 * side face) and becomes an empty bucket; an empty bucket facing a water source takes it, leaving air, and becomes a
 * water bucket (in its own slot, or in the first free hotbar slot when the stack holds more than one bucket). A look at
 * the sky or at ground out of reach changes nothing, and the stack is kept.
 *
 * Water flows around a source and recedes over seconds once the source is taken (Mine Labs, 2026-10-24, 50 trials on 4
 * lanes, 7 reds, raw packets logged in the last 30): the client hears the receding steps of the cell it watches, and the
 * server sends a cell's state once per tick, so a taken source whose refill falls in the same tick is heard as the
 * refill alone.
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
/** Water flows 7 steps from a source at most. */
const FLOW_REACH = 7;
/** The flow around a taken source dries within this wall time (the water ticks every 5 server ticks, a level a step). */
const DRY_WALL_MS = 5_000;
/** The dry cells stay dry over this many observed ticks: 40 prove at least 21 server ticks (`ContractSubject.serverTicks`). */
const STAYS_DRY_TICKS = 40;
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
  /** The watched cell as the client held it right before the use, and every update it heard with the client's world age and the wall time since the use. */
  readonly trace: string[];
}

type CellBlock = { readonly name: string; getProperties(): Record<string, unknown> } | null;

/** A cell as a client reads it: `water level 0`, `air`. */
function cellName(block: CellBlock): string {
  return block === null ? "null" : block.name === "water" ? `water level ${String(block.getProperties().level)}` : block.name;
}

/** Select hotbar slot `slot`, look at `aimLocal` (arena-local, like `watchingLocal`), use the held item once, and wait `waitMs` for what the server answers. */
async function useBucketAt(subject: ContractSubject, step: string, slot: number, aimLocal: Vec3, watchingLocal: Vec3, waitMs: number): Promise<Heard> {
  const { bot } = subject;
  const aim = subject.world([aimLocal.x, aimLocal.y, aimLocal.z]);
  const watching = subject.world([watchingLocal.x, watchingLocal.y, watchingLocal.z]);
  const heard: Heard = { cell: [], slots: {}, order: [], trace: [] };
  const eventName = `blockUpdate:${watching}` as "blockUpdate:(x, y, z)";
  let usedAt = 0;
  const onCell = (_before: unknown, after: CellBlock) => {
    heard.cell.push(cellName(after));
    heard.order.push("cell");
    heard.trace.push(`${cellName(after)} at age ${String(bot.time.age)}, +${Math.round(subject.now() - usedAt)} ms`);
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
  heard.trace.push(`${step}: before the use the cell is ${cellName(bot.blockAt(watching))} (age ${String(bot.time.age)})`);
  bot.on(eventName, onCell);
  bot.inventory.on("updateSlot", onUpdateSlot);
  try {
    usedAt = subject.now();
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

/** The water cells of the layer of `takenLocal` within the flow's reach of it, as the client holds them: `<dx>,<dz>=<state>` from the taken source. */
function wetCellsAround(subject: ContractSubject, takenLocal: Vec3): string[] {
  const taken = subject.world([takenLocal.x, takenLocal.y, takenLocal.z]);
  const wet: string[] = [];
  for (let dx = -FLOW_REACH; dx <= FLOW_REACH; dx++) {
    // Water spreads a step at a time by path: 7 steps reach |dx| + |dz| <= 7, not the corners of the square.
    for (let dz = -(FLOW_REACH - Math.abs(dx)); dz <= FLOW_REACH - Math.abs(dx); dz++) {
      const block = subject.bot.blockAt(new Vec3(taken.x + dx, taken.y, taken.z + dz));
      if (block?.name === "water") wet.push(`${dx},${dz}=${cellName(block)}`);
    }
  }
  return wet;
}

/**
 * Wait until the water flowing around the source taken at `takenLocal` has dried, then show it stays dry for 40 ticks.
 * The next step watches a cell the flow reaches: its receding steps (`water level 5`, then `6`, then `air`) are updates
 * of that cell too, and one landing between the listener and the pour is heard first (red, 2026-10-24: `air` before
 * `water level 0` in the wall pour, `water level 6` in the earlier red).
 */
export async function awaitFlowDried(subject: ContractSubject, takenLocal: Vec3): Promise<void> {
  const source = `the flow from the source taken at ${takenLocal}`;
  if (!(await holdsWithin(subject, () => wetCellsAround(subject, takenLocal).length === 0, DRY_WALL_MS))) {
    throw new Error(`${source} had not dried within ${DRY_WALL_MS / 1000} s: ${wetCellsAround(subject, takenLocal).join(" ")}`);
  }
  if (!(await subject.serverTicks(STAYS_DRY_TICKS, DRY_WALL_MS))) {
    throw new Error(`the world age moved less than ${STAYS_DRY_TICKS} ticks in ${DRY_WALL_MS / 1000} s after ${source} dried: the server is behind, dry is not shown`);
  }
  const back = wetCellsAround(subject, takenLocal);
  assert.equal(back.length, 0, `${source} flowed again within ${STAYS_DRY_TICKS} ticks: ${back.join(" ")}`);
}

/**
 * The first update of the cell of a taken source: `air`, or flowing water when the refill from the flow around it fell
 * in the same server tick (the server sends a cell's state once per tick: raw `multi_block_change` held `water level 2`
 * alone in all 4 fill reds of 30 trials, 2026-10-24). A source heard again, a solid block, a removal or nothing is no take.
 */
export function isTakenSourceUpdate(update: string | undefined): boolean {
  return update === "air" || /^water level [1-7]$/.test(update ?? "");
}

/** An empty bucket used at the source in the watched cell takes it: the cell is air or its refill, and the bucket is a water bucket. */
function assertTook(heard: Heard, what: string): void {
  assert.ok(isTakenSourceUpdate(heard.cell[0]), `${what}: the cell heard ${heard.cell.join(", ")} (${heard.trace.join(" | ")})`);
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
    const dry = await useBucketAt(subject, "dry floor", BUCKET_STACK_SLOT, DRY_FLOOR_AIM, POURED_CELL, ABSENCE_MS);
    assert.deepEqual(dry.order, ["ack"], `an empty bucket at dry floor is only acknowledged: ${dry.order.join(", ")}`);
    assert.equal(slotOf(BUCKET_STACK_SLOT), "bucket x2", "the empty buckets changed after a use on dry floor");
    for (const [label, aim] of [["the sky", SKY_AIM], ["ground past the reach", OUT_OF_REACH_AIM]] as const) {
      const heard = await useBucketAt(subject, label, WATER_BUCKET_SLOT, aim, POURED_CELL, ABSENCE_MS);
      assert.deepEqual(heard.order, ["ack"], `a pour at ${label} is only acknowledged: ${heard.order.join(", ")}`);
      assert.equal(slotOf(WATER_BUCKET_SLOT), "water_bucket x1", `the water bucket changed after a pour at ${label}`);
    }
    const poured = await useBucketAt(subject, "floor pour", WATER_BUCKET_SLOT, FLOOR_AIM, POURED_CELL, ANSWER_WALL_MS);
    assert.equal(poured.cell[0], "water level 0", `the pour on the floor: the cell above it heard ${poured.cell.join(", ")} (${poured.trace.join(" | ")})`);
    assert.equal(poured.slots[WATER_BUCKET_SLOT], "bucket x1", "the water bucket is an empty bucket after the pour");
    assert.deepEqual(poured.order, [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"], "the slot comes first, then the block change, then the acknowledgement");
    const filled = await useBucketAt(subject, "floor fill", WATER_BUCKET_SLOT, FLOOR_AIM, POURED_CELL, ANSWER_WALL_MS);
    assertTook(filled, "the empty bucket took the source");
    assert.equal(filled.slots[WATER_BUCKET_SLOT], "water_bucket x1", "the empty bucket is a water bucket after the fill");
    // The water around the taken source then flows into its cell, which the server also sends.
    assert.deepEqual(filled.order.slice(0, 3), [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"], "a fill answers in the order of a pour");
    // Only the step after a taken source starts from a dry state: the other uses follow none.
    await awaitFlowDried(subject, POURED_CELL);
    const side = await useBucketAt(subject, "wall pour", WATER_BUCKET_SLOT, WALL_AIM, WALL_POURED_CELL, ANSWER_WALL_MS);
    assert.equal(side.cell[0], "water level 0", `the pour at a wall's face: the cell in front of it heard ${side.cell.join(", ")} (${side.trace.join(" | ")})`);
    assert.equal(side.slots[WATER_BUCKET_SLOT], "bucket x1");
    // A stack of two buckets: one is used up and the water bucket goes to the first free hotbar slot.
    const fromStack = await useBucketAt(subject, "stack fill", BUCKET_STACK_SLOT, WALL_AIM, WALL_POURED_CELL, ANSWER_WALL_MS);
    assertTook(fromStack, "the stacked buckets took the source");
    assert.equal(fromStack.slots[BUCKET_STACK_SLOT], "bucket x1", "one bucket of the stack is used");
    assert.equal(fromStack.slots[FIRST_FREE_HOTBAR_SLOT], "water_bucket x1", "the water bucket is in the first free hotbar slot");
  },
};
