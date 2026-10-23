/**
 * The domain builders (a crafting bot, a furnace, a structure, water, a farm, the frozen pockets) stand on the shared
 * fake bot (`fake-bot/`): their scenes are the harness's world and inventory, which they return as `harness`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { carriedCountField } from "./carried-counts.js";
import { craftingBot } from "./crafting.js";
import { createFakeBot, createFakeClock } from "./fake-bot/index.js";
import { FakeFarm } from "./fake-farm.js";
import { DIRK_START, SANA_START, dirkPocket, dirkPocketHarness, sanaPocket, sanaPocketHarness } from "./frozen-pockets.js";
import { observedFurnace } from "./furnace.js";
import { structureWorld } from "./structure-world.js";
import { waterFixture } from "./water.js";

const idOf = (bot: { registry: { itemsByName: Record<string, { id: number } | undefined> } }, name: string) => bot.registry.itemsByName[name]!.id;

test("craftingBot carries its items in the harness window, split at each item's stack size", () => {
  const { bot, harness } = craftingBot({ cobblestone: 130, oak_log: 2 });
  assert.equal(harness.bot, bot);
  const cobblestone = harness.inventory.slots.filter((item) => item?.name === "cobblestone").map((item) => item!.count);
  assert.deepEqual(cobblestone, [64, 64, 2]);
  assert.equal(bot.inventory.count(idOf(bot, "oak_log"), null), 2);
});

test("craftingBot's counts write through to the inventory and announce the slot", () => {
  const { bot, counts } = craftingBot({ oak_log: 2 });
  const updated: number[] = [];
  bot.inventory.on("updateSlot", (slot: number) => updated.push(slot));
  counts.set(idOf(bot, "oak_log"), 0);
  assert.equal(bot.inventory.count(idOf(bot, "oak_log"), null), 0);
  counts.set(idOf(bot, "stick"), 5);
  assert.equal(counts.get(idOf(bot, "stick")), 5);
  assert.deepEqual(updated, [36, 36], "each change is a slot update, as the server's set_slot: the log's hotbar slot emptied, then the sticks in it");
});

test("craftingBot's craft takes the ingredients from the window and puts the result in it", async () => {
  const { bot, craftCalls } = craftingBot({ oak_log: 2 });
  const [planks] = bot.recipesAll(idOf(bot, "oak_planks"), null, null);
  await bot.craft(planks!, 2, undefined);
  assert.deepEqual(craftCalls, ["oak_planks"]);
  assert.equal(bot.inventory.count(idOf(bot, "oak_log"), null), 0);
  assert.equal(bot.inventory.count(idOf(bot, "oak_planks"), null), 8);
});

test("craftingBot's world age is the harness server's, plus what a test moves it by (the bridge kept for startServerClock)", async () => {
  const { bot, harness } = craftingBot({});
  const start = bot.time.age;
  bot.time.age += 20;
  assert.equal(bot.time.age, start + 20, "a test-written age (startServerClock) is kept");
  await harness.clock.advance(1_000);
  assert.equal(bot.time.age, start + 40, "the server's own time packet moves it too");
  assert.equal(harness.server.age, start + 20, "the server's age is its own, without the written ticks");
  assert.equal(bot.time.timeOfDay, harness.server.timeOfDay, "the other fields are the harness's");
});

test("craftingBot with a table finds a crafting table in the harness world", () => {
  const { bot, harness } = craftingBot({}, true);
  const table = bot.findBlock({ matching: idOf(bot, "crafting_table") });
  assert.equal(table?.name, "crafting_table");
  assert.equal(harness.world.blockAt(table!.position)?.name, "crafting_table");
  assert.equal(craftingBot({}, false).bot.findBlock({ matching: 0 }), null);
});

test("observedFurnace on the harness stands a furnace in the harness world and carries the ore and fuel in its window", () => {
  const { bot, harness } = observedFurnace({ cookMs: 100, raw: 3, coal: 2, onHarness: true });
  assert.ok(harness);
  assert.equal(harness.bot, bot);
  assert.equal(harness.world.blockAt(new Vec3(2, 64, 0))?.name, "furnace");
  assert.equal(bot.inventory.count(idOf(bot, "raw_iron"), null), 3);
  assert.equal(bot.inventory.count(idOf(bot, "coal"), null), 2);
});

test("observedFurnace without onHarness stays on the old fixture, whose items() is the carried array", () => {
  const { bot, harness } = observedFurnace({ cookMs: 100 });
  assert.equal(harness, undefined);
  const items = bot.inventory.items() as { name: string; count: number }[];
  items.push({ name: "furnace", count: 1 });
  assert.ok(bot.inventory.items().some((item) => item.name === "furnace"), "a stack pushed onto items() is carried");
});

test("observedFurnace's input loaded and output taken move the harness window", async () => {
  const { bot, dependencies } = observedFurnace({ cookMs: 100, raw: 3, coal: 1, onHarness: true });
  const furnace = await dependencies.openFurnace(bot, bot.blockAt(new Vec3(2, 64, 0))!);
  await furnace.putInput(idOf(bot, "raw_iron"), null, 2);
  assert.equal(bot.inventory.count(idOf(bot, "raw_iron"), null), 1);
  await furnace.takeInput();
  assert.equal(bot.inventory.count(idOf(bot, "raw_iron"), null), 3);
});

test("structureWorld builds on the harness world: a stone floor at y 63 inside the area, air beyond it", () => {
  const { bot, harness } = structureWorld({ onHarness: true });
  assert.ok(harness);
  assert.equal(harness.bot, bot);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "stone");
  assert.equal(bot.blockAt(new Vec3(0, 63, 7))?.name, "air");
  assert.equal(bot.blockAt(new Vec3(0, 64, 0))?.boundingBox, "empty");
});

test("structureWorld's put and placements change the harness world's cells with the block's own states", async () => {
  const { bot, put, blocks, physics, harness } = structureWorld({ carried: { oak_log: 2 }, onHarness: true });
  assert.ok(harness);
  put(new Vec3(1, 64, 0), "dirt");
  assert.equal(blocks.get("1,64,0")?.name, "dirt");
  assert.equal(harness.world.blockAt(new Vec3(1, 64, 0))?.name, "dirt");
  const log = bot.inventory.items().find((item) => item.name === "oak_log")!;
  await physics.place({
    expectedCells: [new Vec3(2, 64, 0)],
    item: log,
    face: new Vec3(1, 0, 0),
    lookDirection: new Vec3(1, 0, 0),
  } as never);
  const placed = bot.blockAt(new Vec3(2, 64, 0))!;
  assert.equal(placed.name, "oak_log");
  assert.deepEqual(placed.getProperties(), { axis: "x" }, "a log has no facing: only the states the block has");
  assert.equal(bot.inventory.count(idOf(bot, "oak_log"), null), 1);
});

test("structureWorld's loaded radius reads farther cells as unloaded", () => {
  const { bot } = structureWorld({ loadedRadius: 4, onHarness: true });
  assert.equal(bot.blockAt(new Vec3(10, 63, 0)), null);
  assert.equal(bot.blockAt(new Vec3(1, 63, 0))?.name, "stone");
});

test("waterFixture on the harness reads its air from the version's air_supply metadata", (t) => {
  const fixture = waterFixture(t, {}, {}, { onHarness: true });
  assert.equal(fixture.harness?.bot, fixture.bot);
  assert.equal(fixture.entity, fixture.bot.entity);
  fixture.harness?.breath.setAirSupply(7 * 15);
  const airIndex = (fixture.bot.registry.entitiesByName.player as { metadataKeys: string[] }).metadataKeys.indexOf("air_supply");
  assert.equal(fixture.bot.entity.metadata[airIndex], 7 * 15);
  assert.equal(fixture.bot.oxygenLevel, 7, "the server's air is what the client reads as its level");
  fixture.bot.setControlState("sneak", true);
  assert.deepEqual(fixture.controls, [["sneak", true]]);
  assert.equal(fixture.bot.controlState.sneak, true);
  assert.ok(fixture.harness?.server.packets.some((packet) => packet.name === "player_input" || packet.name === "entity_action"), "the fake's own setter still sends the sneak (1.21.4: player_input)");
});

test("waterFixture without onHarness keeps the bare bot whose air_supply is metadata 0", (t) => {
  const fixture = waterFixture(t);
  assert.equal(fixture.harness, undefined);
  fixture.bot.oxygenLevel = 7;
  assert.equal(fixture.bot.entity.metadata[0], 7 * 15);
});

test("FakeFarm keeps its plot in a fake world of real blocks; a cell never set reads as unloaded", () => {
  const farm = new FakeFarm();
  farm.set(0, 0, "farmland", "wheat", 7);
  assert.equal(farm.harness.world.blockAt(new Vec3(0, 64, 0))?.name, "wheat");
  assert.deepEqual(farm.read(0, 64, 0), { name: "wheat", properties: { age: "7" }, liquid: false, empty: true, breakable: true });
  assert.equal(farm.read(0, 63, 0)?.properties.moisture, "7");
  assert.equal(farm.read(5, 63, 5), null);
});

test("the pocket harnesses hold the same cells as the pocket worlds, the bot at the start with what it carried", () => {
  for (const [harnessOf, worldOf, start] of [[dirkPocketHarness, dirkPocket, DIRK_START], [sanaPocketHarness, sanaPocket, SANA_START]] as const) {
    const harness = harnessOf();
    const world = worldOf(harness.bot);
    for (const cell of [start, { x: start.x, y: start.y - 1, z: start.z }, { x: start.x + 1, y: start.y + 2, z: start.z - 1 }, { x: start.x + 1, y: start.y + 3, z: start.z + 2 }]) {
      const at = new Vec3(cell.x, cell.y, cell.z);
      const loaded = world.blockAt(at.x, at.y, at.z);
      assert.equal(harness.world.getBlockStateId(at), loaded.kind === "loaded" ? loaded.stateId : 0, `${at}`);
    }
    assert.deepEqual(harness.bot.entity.position.floored(), new Vec3(start.x, start.y, start.z));
    assert.ok(harness.bot.inventory.items().some((item) => item.name === "stone_pickaxe"));
  }
});

test("craftingBot given a clock builds its harness on it, and its world age is the server's own", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const { bot, harness } = craftingBot({ oak_log: 1 }, false, [], { clock });
  assert.equal(harness.clock, clock);
  const start = bot.time.age;
  await clock.advance(1_000);
  assert.equal(bot.time.age, start + 20);
  assert.equal(bot.time.age, harness.server.age, "no written ticks: a test given the clock moves the age with it");
});

test("observedFurnace given a mocked clock moves the world age only with that clock, one time packet a second", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, harness } = observedFurnace({ cookMs: 100, onHarness: true, clock });
  assert.equal(harness?.clock, clock);
  const start = bot.time.age;
  await clock.advance(1_000);
  assert.equal(bot.time.age, start + 20, "no wall-clock timer of its own moves it (startServerClock would add 20 per 10 ms)");
  assert.equal(bot.time.age, harness?.server.age);
});

test("structureWorld given a clock stands on the harness built on that clock", () => {
  const clock = createFakeClock({ mode: "manual" });
  const { harness } = structureWorld({ clock });
  assert.equal(harness?.clock, clock);
});

test("carriedCountField reads the sum of every stack of its item and rewrites the window when set", () => {
  const harness = createFakeBot({ carried: { cobblestone: 130 } });
  const cobblestone = carriedCountField(harness, "cobblestone");
  assert.equal(cobblestone.name, "cobblestone");
  assert.equal(cobblestone.count, 130, "the three stacks 64 + 64 + 2 summed");
  cobblestone.count = 10;
  const stacks = harness.inventory.slots.filter((item) => item?.name === "cobblestone").map((item) => item!.count);
  assert.deepEqual(stacks, [10], "the last stacks taken first, the window holds what was set");
  assert.equal(cobblestone.count, 10);
});
