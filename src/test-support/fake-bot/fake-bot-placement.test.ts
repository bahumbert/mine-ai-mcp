/**
 * The fake bot's placement with options: `_placeBlockWithOptions` as `place_block.js` and `generic_place.js` run it (the
 * look, the swing, the click with its cursor inside the face, the wait for the block update), and the server's answer as the
 * 1.21.4 server gave it (contract check `place-block-with-options`, Mine Labs 2026-10-23): a slab or stair on a side face
 * takes the half the click was in, the off hand's block is placed from the off hand, the server sends the clicked block, the
 * placed block twice, the slot, then the acknowledgement; a taken destination is only acknowledged.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { blockUpdateEventOf } from "./fake-world.js";

const WEST = new Vec3(-1, 0, 0);
const UP = new Vec3(0, 1, 0);
/** The stone the clicks land on, east of the cell that receives the block. */
const REFERENCE = new Vec3(2, -60, 0);
const DESTINATION = new Vec3(1, -60, 0);
const OFF_HAND_SLOT = 45;

function placer(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({ position: new Vec3(0.5, -60, 0.5), cells: { "2,-60,0": "stone" }, carried: { oak_slab: 4, oak_stairs: 1, cobblestone: 1 }, ...options });
}

type PlacementOptions = { half?: "top" | "bottom"; delta?: Vec3; forceLook?: boolean | "ignore"; offhand?: boolean; swingArm?: "right" | "left" };

/** Place against the west face of the stone with `options` and let the server answer; the promise's outcome and what the client heard. */
async function place({ bot, clock }: FakeHarness, options: PlacementOptions, face = WEST, reference = REFERENCE) {
  const heard: string[] = [];
  const at = (cell: { x: number; y: number; z: number }) => (cell.x === reference.x && cell.y === reference.y && cell.z === reference.z ? "ref" : "dest");
  bot._client.on("block_change", (packet: { location: { x: number; y: number; z: number } }) => void heard.push(`block_change ${at(packet.location)}`));
  bot._client.on("acknowledge_player_digging", () => void heard.push("ack"));
  bot.inventory.on("updateSlot", (slot: number) => void heard.push(`set_slot ${slot}`));
  const placing = bot._placeBlockWithOptions(bot.blockAt(reference)!, face, options).then(
    () => ({ error: null as Error | null }),
    (error: Error) => ({ error }),
  );
  await clock.advance(1_000);
  return { heard, outcome: placing };
}

const typeOf = ({ bot }: FakeHarness, cell = DESTINATION) => bot.blockAt(cell)!.getProperties();

test("a slab put with half 'top' on a side face takes the top half; 'bottom' the bottom half; a delta at 0.9 the top", async () => {
  const top = placer();
  await place(top, { half: "top", swingArm: "right" });
  assert.deepEqual([top.bot.blockAt(DESTINATION)!.name, typeOf(top).type, typeOf(top).waterlogged], ["oak_slab", "top", false], "a slab put in air is not waterlogged: states left out are the block's defaults");
  const bottom = placer();
  await place(bottom, { half: "bottom", swingArm: "right" });
  assert.equal(typeOf(bottom).type, "bottom");
  const delta = placer();
  await place(delta, { delta: new Vec3(0, 0.9, 0.5), forceLook: "ignore", swingArm: "right" });
  assert.equal(typeOf(delta).type, "top");
});

test("a slab put on the top face of a block is the bottom half whatever the click height, and on the bottom face the top half", async () => {
  const onTop = placer();
  await place(onTop, { swingArm: "right" }, UP);
  assert.equal(onTop.bot.blockAt(REFERENCE.plus(UP))!.getProperties().type, "bottom");
  const onBottom = placer({ cells: { "2,-59,0": "stone" } });
  await place(onBottom, { swingArm: "right" }, new Vec3(0, -1, 0), new Vec3(2, -59, 0));
  assert.equal(onBottom.bot.blockAt(new Vec3(2, -60, 0))!.getProperties().type, "top");
});

test("stairs put with half 'top' on a side face are the top half", async () => {
  const harness = placer();
  harness.bot.setQuickBarSlot(1);
  await place(harness, { half: "top", swingArm: "right" });
  assert.deepEqual([harness.bot.blockAt(DESTINATION)!.name, typeOf(harness).half], ["oak_stairs", "top"]);
});

test("the click sent carries the cursor inside the face, the hand and a sequence the server acknowledges", async () => {
  const harness = placer();
  await place(harness, { half: "top", swingArm: "right" });
  const click = harness.server.packets.find(({ name }) => name === "block_place")!.data as Record<string, unknown>;
  assert.deepEqual(
    { ...click, location: undefined, sequence: typeof click.sequence },
    { location: undefined, direction: 4, hand: 0, cursorX: 0, cursorY: 0.75, cursorZ: 0.5, insideBlock: false, sequence: "number", worldBorderHit: false },
  );
  assert.deepEqual((click.location as Vec3).toArray(), [2, -60, 0]);
});

test("the swing is written as an arm_animation for the hand named: right is 0, left is 1; placeBlock swings the right arm", async () => {
  const swings = async (swingArm: "right" | "left") => {
    const harness = placer();
    await place(harness, { swingArm });
    return harness.server.packets.filter(({ name }) => name === "arm_animation").map(({ data }) => data);
  };
  assert.deepEqual(await swings("right"), [{ hand: 0 }]);
  assert.deepEqual(await swings("left"), [{ hand: 1 }]);
  const { bot, clock, server } = placer();
  const placing = bot.placeBlock(bot.blockAt(REFERENCE)!, WEST);
  await clock.advance(1_000);
  await placing;
  assert.deepEqual(server.packets.filter(({ name }) => name === "arm_animation").map(({ data }) => data), [{ hand: 0 }]);
  assert.equal(bot.blockAt(DESTINATION)!.name, "oak_slab");
});

test("with offhand the off hand's block is placed and taken from the off hand, the main hand's stack untouched", async () => {
  const harness = placer({ slots: { [OFF_HAND_SLOT]: { name: "cobblestone", count: 2 } } });
  await place(harness, { offhand: true, swingArm: "left" });
  assert.equal(harness.bot.blockAt(DESTINATION)!.name, "cobblestone");
  assert.equal(harness.bot.inventory.slots[OFF_HAND_SLOT]!.count, 1);
  assert.equal(harness.bot.heldItem!.count, 4, "the slabs in the main hand are untouched");
  assert.equal((harness.server.packets.find(({ name }) => name === "block_place")!.data as { hand: number }).hand, 1);
});

test("an empty hand throws Mineflayer's own error, in the main hand and in the off hand, before any packet", async () => {
  const main = placer({ carried: {} });
  await assert.rejects(main.bot._placeBlockWithOptions(main.bot.blockAt(REFERENCE)!, WEST, {}), /must be holding an item to place/u);
  const off = placer();
  await assert.rejects(off.bot._placeBlockWithOptions(off.bot.blockAt(REFERENCE)!, WEST, { offhand: true }), /must be holding an item in the off-hand to place/u);
  assert.deepEqual([main, off].flatMap(({ server }) => server.packets.filter(({ name }) => name === "block_place")), []);
});

test("forceLook 'ignore' leaves the look where it was; the default turns the head toward the face", async () => {
  const ignored = placer();
  await ignored.bot.look(2, 0.3, true);
  await place(ignored, { forceLook: "ignore" });
  assert.deepEqual([ignored.bot.entity.yaw, ignored.bot.entity.pitch], [2, 0.3]);
  const looked = placer();
  await looked.bot.look(2, 0.3, true);
  await place(looked, {});
  assert.notEqual(looked.bot.entity.yaw, 2);
});

test("the server sends the clicked block, the placed block twice, the slot, then the acknowledgement; a placed block is announced", async () => {
  const harness = placer();
  const placed: string[] = [];
  harness.bot.on("blockPlaced" as never, ((before: { name: string }, after: { name: string }) => void placed.push(`${before.name} -> ${after.name}`)) as never);
  const { heard, outcome } = await place(harness, { half: "top", swingArm: "right" });
  assert.deepEqual(heard, ["block_change ref", "block_change dest", "block_change dest", "set_slot 36", "ack"]);
  assert.deepEqual(await outcome, { error: null });
  assert.deepEqual(placed, ["air -> oak_slab"]);
  assert.equal(harness.bot.heldItem!.count, 3);
});

test("every block_change the placer hears is a blockUpdate, as blocks.js emits one per packet (contract check placement-block-update: two to the cell, both to the placed block)", async () => {
  const harness = placer({ carried: { cobblestone: 2 } });
  harness.bot.setQuickBarSlot(0);
  const heard: string[] = [];
  harness.bot.on("blockUpdate", (before, after) => void heard.push(`${before?.position} ${before?.name} -> ${after?.name}`));
  await place(harness, { swingArm: "right" });
  assert.deepEqual(heard, ["(2, -60, 0) stone -> stone", "(1, -60, 0) air -> cobblestone", "(1, -60, 0) cobblestone -> cobblestone"]);
});

test("a creative bot keeps its stack", async () => {
  const harness = placer({ gameMode: "creative" });
  await place(harness, { half: "top", swingArm: "right" });
  assert.equal(harness.bot.blockAt(DESTINATION)!.name, "oak_slab");
  assert.equal(harness.bot.heldItem!.count, 4);
});

test("a taken destination is only acknowledged, and Mineflayer's own 5000 ms wait runs out", async () => {
  const harness = placer({ cells: { "2,-60,0": "stone", "1,-60,0": "stone" } });
  const { bot, clock } = harness;
  const { heard, outcome } = await place(harness, { half: "bottom", swingArm: "right" });
  assert.deepEqual(heard, ["ack"]);
  assert.equal(bot.heldItem!.count, 4, "nothing taken from the stack");
  await clock.advance(5_500);
  assert.match(String((await outcome).error), /Event blockUpdate:\(1, -60, 0\) did not fire within timeout of 5000ms/u);
});

test("a server that stops answering rejects at 5000 ms from the packet, and answers a lag later when it lags", async () => {
  const stopped = placer();
  stopped.server.stop();
  const { outcome } = await place(stopped, {});
  assert.equal(stopped.bot.blockAt(DESTINATION)!.name, "air");
  await stopped.clock.advance(5_500);
  assert.match(String((await outcome).error), /did not fire within timeout of 5000ms/u);
  const lagging = placer({ lagMs: 400 });
  const placing = lagging.bot.placeBlock(lagging.bot.blockAt(REFERENCE)!, WEST);
  await lagging.clock.advance(300);
  assert.equal(lagging.bot.blockAt(DESTINATION)!.name, "air");
  await lagging.clock.advance(1_000);
  await placing;
  assert.equal(lagging.bot.blockAt(DESTINATION)!.name, "oak_slab");
});

test("the server's correction of an unchanged cell then its acknowledgement make Mineflayer say the server processed the placement", async () => {
  const harness = placer({ cells: { "2,-60,0": "stone", "1,-60,0": "stone" } });
  const { bot, clock, server } = harness;
  const placing = bot.placeBlock(bot.blockAt(REFERENCE)!, WEST).then(() => null, (error: Error) => error);
  await clock.advance(1_000);
  const { sequence } = server.packets.find(({ name }) => name === "block_place")!.data as { sequence: number };
  bot._client.emit("block_change", { location: { x: 1, y: -60, z: 0 }, type: bot.blockAt(DESTINATION)!.stateId });
  bot._client.emit("acknowledge_player_digging", { sequenceId: sequence });
  assert.match(String(await placing), /Server processed placement, but block at \(1, -60, 0\) is still stone/u);
});

test("the connection ending during a placement rejects it", async () => {
  const harness = placer({ lagMs: 5_000 });
  const placing = harness.bot.placeBlock(harness.bot.blockAt(REFERENCE)!, WEST).then(() => null, (error: Error) => error);
  await harness.clock.advance(500);
  harness.bot.quit("closed");
  assert.match(String(await placing), /Connection ended while placing block/u);
});

const BED_FLOOR = new Vec3(4, -61, 2);
const BED_FOOT = new Vec3(4, -60, 2);
/** Mineflayer's yaw for each side she can face: 0 is north, a quarter turn to the left is west. */
const YAW_OF = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 } as const;
const HEAD_OF = { north: new Vec3(0, 0, -1), west: new Vec3(-1, 0, 0), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0) } as const;

const bedsCarried = ({ bot }: FakeHarness) => bot.inventory.count(bot.registry.itemsByName.red_bed!.id, null);

function bedder(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({ position: new Vec3(0.5, -60, 0.5), carried: { red_bed: 2 }, ...options });
}

test("a bed put on the floor is whole: its foot where the click lands, its head one block on the way she looks (contract check place-block-with-options)", async () => {
  for (const facing of ["north", "south", "west", "east"] as const) {
    const harness = bedder();
    await harness.bot.look(YAW_OF[facing], 0, true);
    const { heard } = await place(harness, { forceLook: "ignore", swingArm: "right" }, UP, BED_FLOOR);
    const head = BED_FOOT.plus(HEAD_OF[facing]);
    assert.deepEqual([harness.bot.blockAt(BED_FOOT)!.name, harness.bot.blockAt(BED_FOOT)!.getProperties().part, harness.bot.blockAt(BED_FOOT)!.getProperties().facing, harness.bot.blockAt(BED_FOOT)!.getProperties().occupied], ["red_bed", "foot", facing, false]);
    assert.deepEqual([harness.bot.blockAt(head)!.name, harness.bot.blockAt(head)!.getProperties().part, harness.bot.blockAt(head)!.getProperties().facing], ["red_bed", "head", facing]);
    // The destination is resent once: the chunk's change carries both halves.
    assert.deepEqual(heard, ["block_change ref", "block_change dest", "set_slot 36", "ack"], facing);
    assert.equal(bedsCarried(harness), 1, "one bed taken (a bed stacks to 1: its slot is empty)");
  }
});

test("a bed's foot hears two blockUpdates and its head one: the halves come in one multi_block_change, then the destination's block_change repeats the foot", async () => {
  const harness = bedder();
  await harness.bot.look(YAW_OF.east, 0, true);
  const heard: Record<"foot" | "head", string[]> = { foot: [], head: [] };
  harness.bot.on(blockUpdateEventOf(BED_FOOT), (_before, after) => void heard.foot.push(`${after?.name}`));
  harness.bot.on(blockUpdateEventOf(BED_FOOT.plus(HEAD_OF.east)), (_before, after) => void heard.head.push(`${after?.name}`));
  await place(harness, { forceLook: "ignore", swingArm: "right" }, UP, BED_FLOOR);
  assert.deepEqual(heard, { foot: ["red_bed", "red_bed"], head: ["red_bed"] });
});

test("a bed whose head cell is taken is only acknowledged and nothing is taken (vanilla's rule, not measured)", async () => {
  const harness = bedder({ cells: { "5,-60,2": "stone" } });
  await harness.bot.look(YAW_OF.east, 0, true);
  const { heard } = await place(harness, { forceLook: "ignore", swingArm: "right" }, UP, BED_FLOOR);
  assert.deepEqual(heard, ["ack"]);
  assert.equal(harness.bot.blockAt(BED_FOOT)!.name, "air");
  assert.equal(bedsCarried(harness), 2);
});
