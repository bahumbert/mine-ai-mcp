/**
 * The fake bot's bucket use, as the 1.21.4 server answered contract check `bucket-pour-and-fill` (Mine Labs, 2026-10-23):
 * a water bucket pours a source into the cell above the floor face the look meets (in front of a side face) and becomes an
 * empty bucket; an empty bucket facing a water source takes it, and the filled bucket goes to the first free hotbar slot
 * when the stack holds more than one; the sky and ground out of reach change nothing. The server answers every use with an
 * acknowledgement of its sequence, and a pour sends the slot before the block change.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";

const FLOOR_AIM = new Vec3(2.5, -60, 0.5);
const POURED_CELL = new Vec3(2, -60, 0);
const WALL_AIM = new Vec3(-2, -59.5, 0.5);
const WALL_POURED_CELL = new Vec3(-2, -60, 0);
const DRY_FLOOR_AIM = new Vec3(3.5, -60, 2.5);
const SKY_AIM = new Vec3(0.5, 20, 0.5);
const OUT_OF_REACH_AIM = new Vec3(5.5, -60, 0.5);
const WATER_BUCKET_SLOT = 36;
const BUCKET_STACK_SLOT = 37;

function bucketBot(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({ position: new Vec3(0.5, -60, 0.5), cells: { "-3,-60,0": "stone" }, carried: { water_bucket: 1, bucket: 2 }, ...options });
}

const stackIn = ({ bot }: FakeHarness, slot: number) => {
  const item = bot.inventory.slots[slot];
  return item ? `${item.name} x${item.count}` : null;
};

/** The cell as a client reads it: `water level 0`, `air`. */
function cellOf({ bot }: FakeHarness, cell: Vec3): string {
  const block = bot.blockAt(cell)!;
  return block.name === "water" ? `water level ${String(block.getProperties().level)}` : block.name;
}

/** Select `slot`, look at `aim`, use the held item for 100 ms and let the server answer; what the client heard of `watching` and the slots, in order. */
async function useAt(harness: FakeHarness, slot: number, aim: Vec3, watching: Vec3 = POURED_CELL): Promise<string[]> {
  const { bot, clock } = harness;
  const heard: string[] = [];
  bot.setQuickBarSlot(slot - WATER_BUCKET_SLOT);
  await bot.lookAt(aim, true);
  bot.on(`blockUpdate:${watching}` as "blockUpdate:(x, y, z)", () => void heard.push("cell"));
  bot.inventory.on("updateSlot", (changed, before, after) => {
    if (before?.name !== after?.name || before?.count !== after?.count) heard.push(`slot:${changed}`);
  });
  bot._client.on("acknowledge_player_digging", () => void heard.push("ack"));
  bot.activateItem();
  await clock.advance(100);
  bot.deactivateItem();
  await clock.advance(1_000);
  return heard;
}

test("a water bucket used at the floor pours a source into the cell above it: the slot first, then the cell, then the acknowledgement", async () => {
  const harness = bucketBot();
  assert.deepEqual(await useAt(harness, WATER_BUCKET_SLOT, FLOOR_AIM), [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"]);
  assert.equal(cellOf(harness, POURED_CELL), "water level 0");
  assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "bucket x1");
});

test("a pour at a wall's face lands in the cell in front of it", async () => {
  const harness = bucketBot();
  await useAt(harness, WATER_BUCKET_SLOT, WALL_AIM, WALL_POURED_CELL);
  assert.equal(cellOf(harness, WALL_POURED_CELL), "water level 0");
  assert.equal(cellOf(harness, new Vec3(-3, -60, 0)), "stone");
});

test("the sky and ground past the reach change nothing: only the acknowledgement comes, and the stack is kept", async () => {
  for (const aim of [SKY_AIM, OUT_OF_REACH_AIM]) {
    const harness = bucketBot();
    assert.deepEqual(await useAt(harness, WATER_BUCKET_SLOT, aim), ["ack"], `${aim}`);
    assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "water_bucket x1");
    assert.equal(cellOf(harness, POURED_CELL), "air");
  }
});

test("an empty bucket used on dry floor changes nothing but is acknowledged", async () => {
  const harness = bucketBot();
  assert.deepEqual(await useAt(harness, BUCKET_STACK_SLOT, DRY_FLOOR_AIM), ["ack"]);
  assert.equal(stackIn(harness, BUCKET_STACK_SLOT), "bucket x2");
});

test("an empty bucket facing a source takes it: the cell is air and the bucket a water bucket in its own slot", async () => {
  const harness = bucketBot({ carried: { bucket: 1 }, cells: { "2,-60,0": { name: "water", properties: { level: 0 } } } });
  assert.deepEqual(await useAt(harness, WATER_BUCKET_SLOT, FLOOR_AIM), [`slot:${WATER_BUCKET_SLOT}`, "cell", "ack"]);
  assert.equal(cellOf(harness, POURED_CELL), "air");
  assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "water_bucket x1");
});

test("a stack of two empty buckets: one is used and the water bucket is in the first free hotbar slot", async () => {
  const harness = bucketBot({ carried: { bucket: 2 }, cells: { "2,-60,0": { name: "water", properties: { level: 0 } } } });
  await useAt(harness, WATER_BUCKET_SLOT, FLOOR_AIM);
  assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "bucket x1");
  assert.equal(stackIn(harness, BUCKET_STACK_SLOT), "water_bucket x1");
  assert.equal(cellOf(harness, POURED_CELL), "air");
});

test("an empty bucket does not take flowing water (vanilla's source-only look, not measured)", async () => {
  const harness = bucketBot({ carried: { bucket: 1 }, cells: { "2,-60,0": { name: "water", properties: { level: 3 } } } });
  assert.deepEqual(await useAt(harness, WATER_BUCKET_SLOT, FLOOR_AIM), ["ack"]);
  assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "bucket x1");
  assert.equal(cellOf(harness, POURED_CELL), "water level 3");
});

test("a creative bot keeps its water bucket (vanilla's rule, not measured)", async () => {
  const harness = bucketBot({ gameMode: "creative" });
  await useAt(harness, WATER_BUCKET_SLOT, FLOOR_AIM);
  assert.equal(cellOf(harness, POURED_CELL), "water level 0");
  assert.equal(stackIn(harness, WATER_BUCKET_SLOT), "water_bucket x1");
});

test("a water bucket held in the off hand is used from there", async () => {
  const harness = bucketBot({ carried: {}, slots: { 45: { name: "water_bucket" } } });
  const { bot, clock } = harness;
  await bot.lookAt(FLOOR_AIM, true);
  bot.activateItem(true);
  await clock.advance(1_100);
  assert.equal(cellOf(harness, POURED_CELL), "water level 0");
  assert.equal(stackIn(harness, 45), "bucket x1");
});

