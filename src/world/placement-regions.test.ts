import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, type FakeServer } from "../test-support/fake-bot/index.js";
import { placementAt } from "../test-support/placement-request.js";
import { pendingLifeSavingPlacements } from "./life-saving-placements.js";
import { placeBlock, placeSolidBlockInto, type InventoryItem } from "./placement.js";
import { regionRefusalText, setProtectedRegionsProvider, type ProtectedRegion } from "./protected-regions.js";

/** Protected regions at placements (plan 2026-11-07-p4-06a-threat T5a, ADR-012): others' regions refuse, the bot's own never. */
const STANDING = new Vec3(3.5, 64, 3.5);
const SERVER_ANSWER_MS = 50;
const CELL = new Vec3(0, 64, 0);
const regionOf = (owner: string, regionId = 7): ProtectedRegion => ({
  regionId, dimension: "overworld", min: { x: -1, y: 63, z: -1 }, max: { x: 1, y: 66, z: 1 }, owner, label: "Tom's place",
});

function placer(regions: () => readonly ProtectedRegion[]) {
  const harness = createFakeBot({
    username: "Ayla",
    gameMode: "creative",
    position: STANDING,
    carried: { cobblestone: 1 },
    clock: createFakeClock({ mode: "mocked" }),
  });
  setProtectedRegionsProvider(harness.bot, regions);
  const item: InventoryItem = harness.bot.inventory.items()[0]!;
  return { ...harness, item };
}

const placePackets = (server: FakeServer) => server.packets.filter((packet) => packet.name === "block_place").length;

test("a placement into another owner's region is refused with cause policy, naming the region, and sends no packet", async () => {
  const region = regionOf("Tom");
  const { bot, clock, server, world, item } = placer(() => [region]);
  using _timers = clock.install();
  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, CELL)), SERVER_ANSWER_MS);
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.cause, "policy");
    assert.ok(result.error.includes(regionRefusalText(region)), result.error);
    assert.match(result.error, /\(0, 64, 0\)/u, "names the cell");
  }
  assert.equal(placePackets(server), 0);
  assert.equal(world.blockAt(CELL)?.name, "air");
  assert.deepEqual(pendingLifeSavingPlacements(bot), []);
});

test("a placement in the bot's own region proceeds (its house build), whatever the owner name's case", async () => {
  const { bot, clock, server, item } = placer(() => [regionOf("ayla")]);
  using _timers = clock.install();
  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, CELL)), SERVER_ANSWER_MS);
  assert.equal(result.kind, "placed");
  assert.equal(placePackets(server), 1);
  assert.deepEqual(pendingLifeSavingPlacements(bot), [], "only a life-saving placement is recorded");
});

test("a region added after the action started refuses its next placement, and the next one outside it proceeds", async () => {
  let regions: readonly ProtectedRegion[] = [];
  const { bot, clock, server, item } = placer(() => regions);
  using _timers = clock.install();
  assert.equal((await clock.settle(placeBlock(bot, placementAt(bot, item, CELL)), SERVER_ANSWER_MS)).kind, "placed");
  regions = [regionOf("Tom")];
  const refused = await clock.settle(placeBlock(bot, placementAt(bot, item, new Vec3(1, 64, 0))), SERVER_ANSWER_MS);
  assert.equal(refused.kind, "failed");
  assert.equal(placePackets(server), 1);
  // The refusal leaves nothing held: the bot's next placement, outside the region, works.
  const outside = await clock.settle(placeBlock(bot, placementAt(bot, item, new Vec3(3, 64, 0))), SERVER_ANSWER_MS);
  assert.equal(outside.kind, "placed");
});

test("every expected cell is checked: a two-cell placement with one foreign cell is refused whole", async () => {
  const { bot, clock, server, item } = placer(() => [regionOf("Tom")]);
  using _timers = clock.install();
  const result = await clock.settle(
    placeBlock(bot, placementAt(bot, item, new Vec3(2, 64, 0), { expectedCells: [new Vec3(2, 64, 0), new Vec3(1, 64, 0)] })),
    SERVER_ANSWER_MS,
  );
  assert.equal(result.kind, "failed");
  assert.equal(placePackets(server), 0);
});

test("placeSolidBlockInto refuses a foreign cell with cause policy and sends no packet", async () => {
  const region = regionOf("Tom");
  const { bot, clock, server, item } = placer(() => [region]);
  using _timers = clock.install();
  const refused = await clock.settle(placeSolidBlockInto(bot, CELL, item), SERVER_ANSWER_MS);
  assert.equal(refused.kind, "failed");
  if (refused.kind === "failed") {
    assert.equal(refused.cause, "policy");
    assert.ok(refused.error.includes(regionRefusalText(region)), refused.error);
  }
  assert.equal(placePackets(server), 0);
});

test("a life-saving placement is refused without the option and placed with it in a foreign region, then recorded", async () => {
  const region = regionOf("Tom", 9);
  const { bot, clock, server, item } = placer(() => [region]);
  using _timers = clock.install();
  const refused = await clock.settle(placeBlock(bot, placementAt(bot, item, CELL)), SERVER_ANSWER_MS);
  assert.equal(refused.kind, "failed");
  assert.deepEqual(pendingLifeSavingPlacements(bot), []);

  const placed = await clock.settle(placeBlock(bot, placementAt(bot, item, CELL, { lifeSaving: true })), SERVER_ANSWER_MS);
  assert.equal(placed.kind, "placed");
  assert.equal(placePackets(server), 1);
  assert.deepEqual(
    pendingLifeSavingPlacements(bot).map(({ cell, block, regionId, kind }) => ({ cell: cell.toString(), block, regionId, kind })),
    [{ cell: CELL.toString(), block: "cobblestone", regionId: 9, kind: "block" }],
  );
});

test("a life-saving placement cut right after the packet left is recorded: the block may stand without the bot knowing", async () => {
  const { bot, clock, item } = placer(() => [regionOf("Tom", 3)]);
  using _timers = clock.install();
  const controller = new AbortController();
  const cut = clock.settle(
    placeBlock(bot, placementAt(bot, item, CELL, { lifeSaving: true, signal: controller.signal, onSent: () => controller.abort(new Error("died")) })),
    SERVER_ANSWER_MS,
  );
  await assert.rejects(cut, /died/u);
  assert.deepEqual(pendingLifeSavingPlacements(bot).map(({ cell, block, regionId }) => [cell.toString(), block, regionId]), [[CELL.toString(), "cobblestone", 3]]);
});

test("a life-saving placement that never left (cut before the send) is not recorded", async () => {
  const { bot, clock, item } = placer(() => [regionOf("Tom", 3)]);
  using _timers = clock.install();
  const controller = new AbortController();
  controller.abort(new Error("died"));
  await assert.rejects(clock.settle(placeBlock(bot, placementAt(bot, item, CELL, { lifeSaving: true, signal: controller.signal })), SERVER_ANSWER_MS), /died/u);
  assert.deepEqual(pendingLifeSavingPlacements(bot), []);
});

test("a life-saving placement in the bot's own region or in no region is not recorded", async () => {
  const { bot, clock, item } = placer(() => [regionOf("Ayla")]);
  using _timers = clock.install();
  assert.equal((await clock.settle(placeBlock(bot, placementAt(bot, item, CELL, { lifeSaving: true })), SERVER_ANSWER_MS)).kind, "placed");
  assert.equal(
    (await clock.settle(placeBlock(bot, placementAt(bot, item, new Vec3(3, 64, 0), { lifeSaving: true })), SERVER_ANSWER_MS)).kind,
    "placed",
  );
  assert.deepEqual(pendingLifeSavingPlacements(bot), []);
});

test("placeSolidBlockInto with lifeSaving places in a foreign region and records the cell", async () => {
  const { bot, clock, item } = placer(() => [regionOf("Tom", 4)]);
  using _timers = clock.install();
  const placed = await clock.settle(placeSolidBlockInto(bot, CELL, item, { lifeSaving: true }), SERVER_ANSWER_MS);
  assert.equal(placed.kind, "placed");
  assert.deepEqual(pendingLifeSavingPlacements(bot).map((entry) => entry.regionId), [4]);
});
