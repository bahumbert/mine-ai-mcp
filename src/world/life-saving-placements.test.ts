// Cleanup of emergency placements uses the shared world's dig and navigation answers.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createNavigationRuntime } from "../navigation/index.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { confirmFakeDigs } from "../test-support/life-saving-placements.js";
import * as placements from "./life-saving-placements.js";
import { regionChangeRefusal, setProtectedRegionsProvider, type ProtectedRegion } from "./protected-regions.js";
import { isBurning, isInFire, isInLava } from "../survival/perception/body.js";
import { burnLeft, recordFireContact } from "../survival/perception/burn.js";

const CELL = new Vec3(2, 64, 0);
const REGION: ProtectedRegion = {
  regionId: 7, owner: "Tom", label: "garden", dimension: "overworld",
  min: { x: -20, y: 63, z: -20 }, max: { x: 20, y: 70, z: 20 },
};

function scene(simulatePhysics = false, confirmsDigs = true) {
  const fixture = createFakeBot({
    username: "Ayla", position: { x: 0.5, y: 64, z: 0.5 },
    gameMode: "creative", cells: { "2,64,0": "cobblestone" }, clock: createFakeClock({ mode: "mocked" }), simulatePhysics,
  });
  setProtectedRegionsProvider(fixture.bot, () => [REGION]);
  if (confirmsDigs) confirmFakeDigs(fixture);
  return fixture;
}

function remove(bot: ReturnType<typeof scene>["bot"], signal = new AbortController().signal) {
  return placements.removeLifeSavingPlacements(bot, signal);
}

test("a recorded block is removed in reach, and only that cell is admitted by the dig guard", async () => {
  const { bot, world, clock } = scene();
  using _timers = clock.install();
  placements.recordLifeSavingPlacement(bot, CELL, "block");
  assert.equal(regionChangeRefusal(bot, CELL, "dig"), null);
  assert.match(regionChangeRefusal(bot, CELL.offset(1, 0, 0), "dig")!, /owner Tom/u);
  assert.match(regionChangeRefusal(bot, CELL, "placement")!, /owner Tom/u);
  const result = await clock.settle(remove(bot), 1_000);
  assert.deepEqual(result, { removed: [CELL], left: [] });
  assert.equal(world.blockAt(CELL)?.name, "air");
  assert.deepEqual(placements.pendingLifeSavingPlacements(bot), []);
  assert.match(regionChangeRefusal(bot, CELL, "dig")!, /owner Tom/u);
  // A second cleanup is the next action from the now-empty ledger.
  assert.deepEqual(await remove(bot), { removed: [], left: [] });
});

test("a short real navigation reaches the recorded block without editing the protected ground", async () => {
  const { bot, world, clock } = scene(true);
  using data = temporaryBotData();
  using _timers = clock.install();
  await using navigation = createNavigationRuntime(bot);
  placements.setLifeSavingRemovalContext(bot, { data, navigate: navigation.navigate });
  world.setCell(CELL, "air");
  const cell = new Vec3(7, 64, 0);
  world.setCell(cell, "cobblestone");
  placements.recordLifeSavingPlacement(bot, cell, "block");
  const result = await clock.settle(remove(bot), 10_000);
  assert.deepEqual(result, { removed: [cell], left: [] });
  assert.ok(bot.entity.position.distanceTo(new Vec3(0.5, 64, 0.5)) <= 8);
  assert.equal(world.blockAt(new Vec3(3, 63, 0))?.name, "stone");
});

for (const failure of ["distance", "no route", "deadline", "dig rejected", "unloaded"] as const) {
  test(`removal ${failure} leaves the block, names its owner and saves one readable note`, async () => {
    const { bot, world, clock } = scene();
    using data = temporaryBotData();
    using _timers = clock.install();
    placements.setLifeSavingRemovalContext(bot, {
      data,
      navigate: async ({ signal }) => {
        if (failure === "deadline") await clock.sleep(31_000, signal);
        return { status: "stopped", reason: "No route", elapsedMs: 0 };
      },
    });
    placements.recordLifeSavingPlacement(bot, CELL, "block");
    const dig = bot.dig;
    if (failure === "distance") bot.entity.position.x = -9;
    if (failure === "no route" || failure === "deadline") bot.entity.position.x = -4;
    if (failure === "dig rejected") bot.dig = async () => { throw new Error("Dig refused by server"); };
    if (failure === "unloaded") world.setCell(CELL, "void");
    const result = await clock.settle(remove(bot), 32_000, 1_000);
    assert.deepEqual(result.removed, []);
    assert.equal(result.left.length, 1);
    for (const fragment of ["cobblestone", "2 64 0", "#7", "garden", "owner Tom"])
      assert.ok(result.left[0]!.why.includes(fragment), result.left[0]!.why);
    const notes = data.read("SELECT note, context FROM notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.note, result.left[0]!.why);
    assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1, "the failed obligation survives its note");
    bot.entity.position.set(0.5, 64, 0.5);
    bot.dig = dig;
    world.setCell(CELL, "cobblestone");
    placements.setLifeSavingRemovalContext(bot, { data });
    assert.deepEqual(await clock.settle(remove(bot), 1_000), { removed: [CELL], left: [] }, "the next safe moment retries the entry");
    assert.equal(data.read("SELECT * FROM notes").length, 1);
    assert.equal(world.blockAt(CELL)?.name, "air");
  });
}

test("a changed block or dimension is never dug, and one bot cannot consume another bot's ledger", async () => {
  const { bot, world, clock, server } = scene();
  using _timers = clock.install();
  placements.recordLifeSavingPlacement(bot, CELL, "block");
  world.setCell(CELL, "dirt");
  assert.match(regionChangeRefusal(bot, CELL, "dig")!, /owner Tom/u);
  assert.deepEqual(await remove(bot), { removed: [], left: [] });
  assert.equal(world.blockAt(CELL)?.name, "dirt");
  placements.recordLifeSavingPlacement(bot, CELL, "block");
  bot.game.dimension = "the_nether";
  assert.deepEqual(await remove(bot), { removed: [], left: [] });
  assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1, "the overworld entry survives a portal");
  assert.deepEqual(placements.pendingLifeSavingPlacements(scene().bot), []);
  assert.equal(server.packets.filter((packet) => packet.name === "block_dig").length, 0);
});

test("water cleanup calls its hook and reports no hook when it cannot refill", async () => {
  const { bot, world, clock } = scene();
  using data = temporaryBotData();
  using _timers = clock.install();
  placements.setLifeSavingRemovalContext(bot, { data });
  world.setCell(CELL, "water");
  placements.recordLifeSavingPlacement(bot, CELL, "water");
  const missing = await remove(bot);
  assert.match(missing.left[0]!.why, /no hook/iu);
  placements.recordLifeSavingPlacement(bot, CELL, "water");
  placements.setLifeSavingWaterHook(bot, async (cell, signal) => {
    assert.deepEqual(cell, CELL);
    signal.throwIfAborted();
    world.setCell(cell, "air");
    return true;
  });
  assert.deepEqual(await remove(bot), { removed: [CELL], left: [] });
});

test("an aborted dig stops immediately and its surviving record can be removed by the next call", async () => {
  const { bot, clock, world } = scene();
  using _timers = clock.install();
  bot.game.gameMode = "survival";
  placements.recordLifeSavingPlacement(bot, CELL, "block");
  const controller = new AbortController();
  const work = remove(bot, controller.signal);
  await clock.advance(100);
  controller.abort(new Error("New reflex"));
  await assert.rejects(work, /New reflex/u);
  assert.equal(bot.targetDigBlock, null);
  assert.equal(world.blockAt(CELL)?.name, "cobblestone");
  assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1);
  bot.game.gameMode = "creative";
  assert.deepEqual(await clock.settle(remove(bot), 1_000), { removed: [CELL], left: [] });
});

for (const interruption of ["replacement", "dimension", "death"] as const) {
  test(`a ${interruption} while aiming never digs the new world or credits a removal`, async () => {
    const { bot, world, clock, combat, server } = scene();
    using _timers = clock.install();
    placements.recordLifeSavingPlacement(bot, CELL, "block");
    bot.lookAt = async () => {
      if (interruption === "replacement") world.setCell(CELL, "dirt");
      if (interruption === "dimension") { bot.game.dimension = "the_nether"; bot.emit("game"); }
      if (interruption === "death") combat.setHealth(0);
    };
    if (interruption === "replacement") assert.deepEqual(await remove(bot), { removed: [], left: [] });
    else {
      await assert.rejects(clock.settle(remove(bot), 1_000), /died|dimension/iu);
      assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1);
    }
    assert.equal(server.packets.filter((packet) => packet.name === "block_dig").length, 0);
  });
}

test("a dig's predicted air without a server answer is left and noted instead of credited", async () => {
  const { bot, clock } = scene(false, false);
  using data = temporaryBotData();
  using _timers = clock.install();
  placements.setLifeSavingRemovalContext(bot, { data });
  placements.recordLifeSavingPlacement(bot, CELL, "block");
  const result = await clock.settle(remove(bot), 3_000);
  assert.deepEqual(result.removed, []);
  assert.match(result.left[0]!.why, /server.*confirm/iu);
  assert.equal(data.read("SELECT * FROM notes").length, 1);
});

test("a later interruption still reports the earlier noted leftover once", async () => {
  const { bot, clock, world } = scene();
  using data = temporaryBotData();
  using _timers = clock.install();
  placements.setLifeSavingRemovalContext(bot, { data });
  const second = CELL.offset(1, 0, 0);
  world.setCell(second, "cobblestone");
  placements.recordLifeSavingPlacement(bot, CELL, "water");
  placements.recordLifeSavingPlacement(bot, second, "block");
  const controller = new AbortController();
  bot.lookAt = async () => { controller.abort(new Error("New reflex")); };
  const told: string[] = [];
  await assert.rejects(placements.removeLifeSavingPlacements(bot, controller.signal, (left) => told.push(left.why)), /New reflex/u);
  assert.equal(told.length, 1);
  assert.match(told[0]!, /no hook/iu);
  assert.equal(data.read("SELECT * FROM notes").length, 1);
  assert.equal(placements.pendingLifeSavingPlacements(bot).length, 2, "both the noted leftover and interrupted dig survive");
});

for (const swimming of [false, true]) {
  test(`an off-ground ${swimming ? "swimming" : "airborne"} body keeps its ledger for the next grounded moment`, async () => {
    const { bot, clock, world } = scene();
    using _timers = clock.install();
    placements.recordLifeSavingPlacement(bot, CELL, "block");
    Object.assign(bot.entity, { onGround: false, isInWater: swimming });
    assert.deepEqual(await remove(bot), { removed: [], left: [] });
    assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1);
    assert.equal(world.blockAt(CELL)?.name, "cobblestone");
    Object.assign(bot.entity, { onGround: true, isInWater: false });
    assert.deepEqual(await clock.settle(remove(bot), 1_000), { removed: [CELL], left: [] });
  });
}

for (const danger of ["lava", "fire", "lethal_burn"] as const) {
  test(`${danger} interrupts removal and the next safe moment finishes it`, async () => {
    const { bot, clock, world } = scene();
    using data = temporaryBotData();
    using _timers = clock.install();
    placements.setLifeSavingRemovalContext(bot, { data });
    placements.recordLifeSavingPlacement(bot, CELL, "block");
    bot.game.gameMode = "survival";
    const dangerous = () => isInLava(bot) || isInFire(bot) || (isBurning(bot) && bot.health <= burnLeft(bot).hp);
    const work = placements.removeLifeSavingPlacements(bot, new AbortController().signal, undefined, dangerous);
    await clock.advance(100);
    if (danger === "lava") Object.assign(bot.entity, { isInLava: true });
    if (danger === "fire") world.setCell(bot.entity.position.floored(), "fire");
    if (danger === "lethal_burn") {
      bot.health = 8;
      Reflect.set(bot.entity.metadata, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags"), 1);
      recordFireContact(bot, "lava", bot.time.age);
    }
    bot.emit("physicsTick");
    await clock.settle(work, 2_000);
    assert.equal(world.blockAt(CELL)?.name, "cobblestone");
    assert.equal(placements.pendingLifeSavingPlacements(bot).length, 1);
    assert.equal(bot.targetDigBlock, null);
    assert.equal(data.read("SELECT * FROM notes").length, 0, "a danger interruption is not a failed-removal note");
    Object.assign(bot.entity, { isInLava: false });
    world.setCell(bot.entity.position.floored(), "air");
    Reflect.set(bot.entity.metadata, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags"), 0);
    bot.game.gameMode = "creative";
    assert.deepEqual(await clock.settle(remove(bot), 1_000), { removed: [CELL], left: [] });
  });
}
