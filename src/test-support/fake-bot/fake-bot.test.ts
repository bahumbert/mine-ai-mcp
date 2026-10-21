import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { writeShiftKey } from "../../navigation/mineflayer/sneak.js";
import { DEFAULT_MINECRAFT_VERSION } from "../../server/config.js";
import { createFakeBot } from "./fake-bot.js";
import { createFakeClock } from "./fake-clock.js";

/** Settle a promise's outcome into a value a test can read between clock steps. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; error: Error | null } = { done: false, error: null };
  promise.then(
    () => (state.done = true),
    (error: Error) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

const BOAT = { 7: { name: "oak_boat", position: new Vec3(0.5, 62.5, 0.5) } };

test("the bot's version and its registry's version agree, the project's default when none is given", () => {
  const { bot } = createFakeBot();
  assert.equal(bot.version, DEFAULT_MINECRAFT_VERSION);
  assert.equal(bot.registry.version.minecraftVersion, bot.version);
  const older = createFakeBot({ version: "1.20.4" }).bot;
  assert.equal(older.registry.version.minecraftVersion, "1.20.4");
});

test("waitForTicks(20) ends after 1000 ms of clock, not before", async () => {
  const { bot, clock } = createFakeBot();
  const waiting = track(bot.waitForTicks(20));
  await clock.advance(950);
  assert.equal(waiting.done, false);
  await clock.advance(50);
  assert.deepEqual(waiting, { done: true, error: null });
});

test("a mounted bot's waitForTicks(20) rejects with Mineflayer's timeout at 6000 ms, not before", async () => {
  const { bot, clock } = createFakeBot({ entities: BOAT });
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  assert.ok(bot.vehicle);
  const waiting = track(bot.waitForTicks(20));
  await clock.advance(5_950);
  assert.equal(waiting.done, false);
  await clock.advance(50);
  assert.match(String(waiting.error), /Timeout waiting for 20 ticks after 6000ms/);
});

test("no physics tick while the feet cell is unloaded", async () => {
  const { bot, clock } = createFakeBot({ cells: { "0,64,0": "void" } });
  let ticks = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  await clock.advance(1_000);
  assert.equal(ticks, 0);
});

test("simulatePhysics moves the body by the game's engine before physicsTick; without it nothing moves", async () => {
  for (const simulatePhysics of [true, false]) {
    const { bot, clock } = createFakeBot({ position: { x: 0.5, y: 66, z: 0.5 }, groundY: 63, simulatePhysics });
    bot.entity.onGround = false;
    const seen: number[] = [];
    bot.on("physicsTick", () => void seen.push(bot.entity.position.y));
    await clock.advance(1_000);
    if (!simulatePhysics) assert.deepEqual(new Set(seen), new Set([66]), "the body stays where the test put it");
    else {
      assert.ok(seen[1]! < 66, "falling by the second tick (the engine moves by the velocity of the tick before)");
      assert.equal(bot.entity.position.y, 64, "landed on the stone at 63");
      assert.equal(bot.entity.onGround, true);
    }
  }
});

test("no physics tick after a death until the server sends a position", async () => {
  const { bot, clock, server } = createFakeBot();
  let ticks = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  await clock.advance(100);
  assert.equal(ticks, 2);
  bot.emit("death");
  await clock.advance(2_000);
  assert.equal(ticks, 2);
  server.sendPosition(new Vec3(0.5, 64, 0.5));
  await clock.advance(100);
  assert.equal(ticks, 4);
});

test("physicsEnabled false stops physicsTick", async () => {
  const { bot, clock } = createFakeBot();
  let ticks = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  bot.physicsEnabled = false;
  await clock.advance(200);
  assert.equal(ticks, 0);
});

test("the bot's time is the server's world age, and a time event comes with each packet", async () => {
  const { bot, clock } = createFakeBot();
  let packets = 0;
  bot.on("time", () => void (packets += 1));
  await clock.advance(2_000);
  assert.equal(bot.time.age, 24_040);
  assert.equal(packets, 2);
});

test("two harnesses sharing a clock see one time", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const first = createFakeBot({ clock });
  const second = createFakeBot({ clock, username: "Second" });
  await first.clock.advance(1_000);
  assert.equal(second.clock.now(), 1_000);
  assert.equal(second.bot.time.age, first.bot.time.age);
});

/** Where the dig is timed: ground at y 63, the bot on it, one dirt block beside its feet. */
const DIRT = new Vec3(1, 64, 0);

test("a dig on dry ground ends at the block's digTime, then the cell is air", async () => {
  const { bot, clock, world } = createFakeBot({ cells: { "1,64,0": "dirt" } });
  const block = bot.blockAt(DIRT)!;
  const expected = block.digTime(null, false, false, false, [], bot.entity.effects);
  const digging = track(bot.dig(block, true));
  await clock.advance(expected - 50);
  assert.equal(digging.done, false);
  await clock.advance(50);
  assert.deepEqual(digging, { done: true, error: null });
  assert.equal(world.blockAt(DIRT)!.name, "air");
});

test("a dig with the eye in water, or airborne, takes 5 times as long", async () => {
  const dry = createFakeBot({ cells: { "1,64,0": "dirt" } });
  const onDry = dry.bot.digTime(dry.bot.blockAt(DIRT)!);
  const wet = createFakeBot({ cells: { "1,64,0": "dirt", "0,65,0": "water" } });
  assert.equal(wet.bot.digTime(wet.bot.blockAt(DIRT)!), onDry * 5);
  const airborne = createFakeBot({ cells: { "1,64,0": "dirt" } });
  airborne.bot.entity.onGround = false;
  const digging = track(airborne.bot.dig(airborne.bot.blockAt(DIRT)!, true));
  await airborne.clock.advance(onDry * 5 - 50);
  assert.equal(digging.done, false);
  await airborne.clock.advance(50);
  assert.equal(digging.done, true);
});

test("stopDigging while lookAt is pending leaves the dig running", async () => {
  const { bot, clock } = createFakeBot({ cells: { "1,64,0": "dirt" } });
  const block = bot.blockAt(DIRT)!;
  const digging = track(bot.dig(block));
  bot.stopDigging();
  await clock.advance(bot.digTime(block) + 50);
  assert.deepEqual(digging, { done: true, error: null });
});

test("stopDigging after the dig packet emits diggingAborted and rejects the dig with Digging aborted", async () => {
  const { bot, clock, server, world } = createFakeBot({ cells: { "1,64,0": "dirt" } });
  const digging = track(bot.dig(bot.blockAt(DIRT)!, true));
  await clock.advance(50);
  assert.ok(server.packets.some((packet) => packet.name === "block_dig"));
  let aborted = false;
  bot.on("diggingAborted", () => void (aborted = true));
  bot.stopDigging();
  await clock.advance(50);
  assert.equal(aborted, true);
  assert.match(String(digging.error), /Digging aborted/);
  assert.equal(world.blockAt(DIRT)!.name, "dirt");
});

test("a toss lowers the count at once and the item entity appears one answer later", async () => {
  const { bot, clock } = createFakeBot({ carried: { cobblestone: 10 } });
  const cobblestone = bot.registry.itemsByName.cobblestone!.id;
  const spawned: string[] = [];
  bot.on("entitySpawn", (entity) => void spawned.push(entity.name ?? ""));
  await bot.toss(cobblestone, null, 4);
  assert.equal(bot.inventory.count(cobblestone, null), 6);
  assert.deepEqual(spawned, []);
  await clock.advance(50);
  assert.deepEqual(spawned, ["item"]);
  const drop = Object.values(bot.entities).find((entity) => entity.name === "item")!;
  assert.equal(drop.getDroppedItem()!.count, 4);
});

test("a placement looks at the face, then sets the cell on the server's answer and lowers the held stack", async () => {
  const { bot, clock, world } = createFakeBot({ slots: { 36: { name: "cobblestone", count: 3 } } });
  const floor = bot.blockAt(new Vec3(1, 63, 0))!;
  const updates: string[] = [];
  bot.on("blockUpdate", (_before, after) => void updates.push(after?.name ?? ""));
  const placing = track(bot.placeBlock(floor, new Vec3(0, 1, 0)));
  await clock.advance(50);
  assert.equal(world.blockAt(new Vec3(1, 64, 0))!.name, "air", "the look takes a tick, the answer one more slice");
  await clock.advance(50);
  assert.deepEqual(placing, { done: true, error: null });
  assert.deepEqual(updates, ["cobblestone"]);
  assert.equal(bot.heldItem!.count, 2);
});

test("a placement the server never answers rejects with Mineflayer's 5000 ms timeout", async () => {
  const { bot, clock, server } = createFakeBot({ slots: { 36: { name: "cobblestone" } } });
  server.stop();
  const placing = track(bot.placeBlock(bot.blockAt(new Vec3(1, 63, 0))!, new Vec3(0, 1, 0)));
  await clock.advance(5_000);
  assert.equal(placing.done, false, "the 5000 ms count from the packet, sent after the look's tick");
  await clock.advance(50);
  assert.match(String(placing.error), /did not fire within timeout of 5000ms/);
});

test("mount: the mount event, the vehicle set on both sides, physics stopped", async () => {
  const { bot, clock, server } = createFakeBot({ entities: BOAT });
  let mounted = false;
  let ticks = 0;
  bot.on("mount", () => void (mounted = true));
  bot.on("physicsTick", () => void (ticks += 1));
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  assert.equal(mounted, true);
  assert.equal(bot.vehicle, bot.entities[7]);
  assert.equal(server.riderOf(7), bot.entity.id);
  const before = ticks;
  await clock.advance(500);
  assert.equal(ticks, before);
});

test("the shift packet while seated frees the rider on the server only: no position, vehicle kept, physics off", async () => {
  const { bot, clock, server } = createFakeBot({ entities: BOAT });
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  let ticks = 0;
  let forcedMoves = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  bot.on("forcedMove", () => void (forcedMoves += 1));
  writeShiftKey(bot, true);
  await clock.advance(2_000);
  assert.equal(server.riderOf(7), null);
  assert.deepEqual(server.serverPositionOf(bot.entity.id)?.y, 62.5 + bot.entities[7]!.height);
  assert.equal(bot.vehicle, bot.entities[7]);
  assert.equal(ticks, 0);
  assert.equal(forcedMoves, 0);
  assert.deepEqual(server.sentPositions, []);
});

test("dismount() in a boat sends the jump input, which the boat ignores: the server keeps the rider", async () => {
  const { bot, clock, server } = createFakeBot({ entities: BOAT });
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  bot.dismount();
  await clock.advance(1_000);
  assert.ok(server.packets.some((packet) => packet.name === "player_input"));
  assert.equal(server.riderOf(7), bot.entity.id);
  assert.equal(bot.vehicle, bot.entities[7]);
});

test("sendPosition restarts physics after a mount, as Mineflayer's position packet does", async () => {
  const { bot, clock, server } = createFakeBot({ entities: BOAT });
  bot.mount(bot.entities[7]!);
  await clock.advance(50);
  let ticks = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  server.sendPosition(new Vec3(0.5, 63, 0.5));
  await clock.advance(100);
  assert.equal(ticks, 2);
  assert.deepEqual(bot.entity.position, new Vec3(0.5, 63, 0.5));
});

test("equip into the hand sets heldItem and emits heldItemChanged on the bot", async () => {
  const { bot } = createFakeBot({ slots: { 20: { name: "stone_pickaxe" } } });
  let changed = 0;
  bot.on("heldItemChanged", () => void (changed += 1));
  await bot.equip(bot.inventory.slots[20]!, "hand");
  assert.equal(bot.heldItem!.name, "stone_pickaxe");
  assert.ok(changed > 0);
});

test("the shared options reach the bot, and an override replaces one method", async () => {
  const { bot } = createFakeBot({
    username: "Tester",
    position: new Vec3(3.5, 70, -2.5),
    dimension: "the_nether",
    gameMode: "creative",
    health: 7,
    food: 3,
    overrides: { tossStack: async () => Promise.reject(new Error("scripted")) },
  });
  assert.equal(bot.username, "Tester");
  assert.deepEqual(bot.entity.position, new Vec3(3.5, 70, -2.5));
  assert.equal(bot.game.dimension, "the_nether");
  assert.equal(bot.game.gameMode, "creative");
  assert.equal(bot.health, 7);
  assert.equal(bot.food, 3);
  assert.equal(bot.players.Tester!.entity, bot.entity);
  await assert.rejects(bot.tossStack(null as never), /scripted/);
});

test("the bot stands on ground under its feet by default, and in open air when groundY is null", () => {
  assert.equal(createFakeBot().bot.blockAt(new Vec3(0, 63, 0))!.name, "stone");
  assert.equal(createFakeBot({ groundY: null }).bot.blockAt(new Vec3(0, 63, 0))!.name, "air");
});

test("the placement packet names the reference block and the face number, as Mineflayer writes it", async () => {
  const { bot, clock, server } = createFakeBot({ slots: { 36: { name: "cobblestone" } } });
  void bot.placeBlock(bot.blockAt(new Vec3(1, 63, 0))!, new Vec3(0, 1, 0));
  await clock.advance(50);
  const sent = server.packets.find((packet) => packet.name === "block_place")!.data as { location: Vec3; direction: number };
  assert.deepEqual([sent.location, sent.direction], [new Vec3(1, 63, 0), 1]);
});

test("a use with the empty off hand on a cell places nothing", async () => {
  const { bot, clock, world } = createFakeBot({ slots: { 36: { name: "dirt" } } });
  bot._client.write("block_place", { location: new Vec3(1, 63, 0), direction: 1, hand: 1 });
  await clock.advance(100);
  assert.equal(world.blockAt(new Vec3(1, 64, 0))!.name, "air");
});

test("toss with no count throws one item, and more than carried throws Mineflayer's error", async () => {
  const { bot } = createFakeBot({ carried: { dirt: 3 } });
  const dirt = bot.registry.itemsByName.dirt!.id;
  await bot.toss(dirt, null, null);
  assert.equal(bot.inventory.count(dirt, null), 2);
  await assert.rejects(bot.toss(dirt, null, 5), /Can't find dirt in slots/);
  assert.equal(bot.inventory.count(dirt, null), 2);
});

test("a slot change announces a new item, never the old one changed in place", async () => {
  const { bot } = createFakeBot({ carried: { dirt: 3 } });
  const pairs: boolean[] = [];
  bot.inventory.on("updateSlot", (_slot: number, before: unknown, after: unknown) => void pairs.push(before === after));
  await bot.toss(bot.registry.itemsByName.dirt!.id, null, 2);
  assert.deepEqual(pairs, [false]);
});

test("a position packet clears onGround and is confirmed, and right after a death physics restarts 1500 ms later", async () => {
  const { bot, clock, server } = createFakeBot();
  let ticks = 0;
  bot.on("physicsTick", () => void (ticks += 1));
  bot.emit("death");
  server.sendPosition(new Vec3(0.5, 64, 0.5));
  assert.equal(bot.entity.onGround, false);
  assert.ok(server.packets.some((packet) => packet.name === "teleport_confirm"));
  await clock.advance(1_450);
  assert.equal(ticks, 0);
  await clock.advance(100);
  assert.ok(ticks > 0);
});

test("sneak and sprint controls and a hand equip write the packets Mineflayer writes, on change only", async () => {
  const { bot, server } = createFakeBot({ slots: { 36: { name: "dirt" }, 20: { name: "stone_pickaxe" } } });
  bot.setControlState("sneak", true);
  bot.setControlState("sneak", true);
  bot.setControlState("sprint", true);
  await bot.equip(bot.inventory.slots[20]!, "hand");
  assert.deepEqual(
    server.packets.map((packet) => packet.name),
    ["player_input", "entity_action", "held_item_slot"],
  );
});

test("a dig with the eye in water ends 5 times later than on dry ground", async () => {
  const { bot, clock } = createFakeBot({ cells: { "1,64,0": "dirt", "0,65,0": "water" } });
  const block = bot.blockAt(DIRT)!;
  const onDry = block.digTime(null, false, false, false, [], bot.entity.effects);
  const digging = track(bot.dig(block, true));
  await clock.advance(onDry * 5 - 50);
  assert.equal(digging.done, false);
  await clock.advance(50);
  assert.deepEqual(digging, { done: true, error: null });
});

test("a death removes the dig's listeners and aborts it", async () => {
  const { bot, clock } = createFakeBot({ cells: { "1,64,0": "dirt" } });
  bot.on("diggingCompleted", () => undefined);
  const digging = track(bot.dig(bot.blockAt(DIRT)!, true));
  await clock.advance(50);
  bot.emit("death");
  await clock.advance(50);
  assert.match(String(digging.error), /Digging aborted/);
  assert.equal(bot.listenerCount("diggingCompleted"), 0);
});

test("time is the full day time and day counts from it, timeOfDay wraps", async () => {
  const { bot, clock } = createFakeBot({ server: { timeOfDay: 23_990 } });
  await clock.advance(1_000);
  assert.equal(bot.time.timeOfDay, 10);
  assert.equal(bot.time.time, 24_010);
  assert.equal(bot.time.day, 1);
});
