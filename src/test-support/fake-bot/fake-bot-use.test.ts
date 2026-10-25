/**
 * The fake bot's item use: `activateItem` as Mineflayer writes it, and the server's answer to a boat used (contract check
 * `boat-placed-by-use`, Mine Labs 1.21.4, 2026-10-23: a boat is put where the look meets water or ground within 4.5
 * blocks, the stack loses its one boat, a boat rests 0.37 below the surface by 1.5 s).
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { createFakeClock } from "./fake-clock.js";

const POOL = Object.fromEntries([2, 3, 4].flatMap((x) => [-1, 0, 1].map((z) => [`${x},-61,${z}`, "water"])));
const WATER_SURFACE = -61 + 8 / 9;
const WATER_AIM = new Vec3(3.5, WATER_SURFACE, 0.5);
const IN_REACH_AIM = new Vec3(0.5, -60, -3.59);
const OUT_OF_REACH_AIM = new Vec3(0.5, -60, -3.91);
const WALL_AIM = new Vec3(-2, -59.5, 0.5);
const SKY_AIM = new Vec3(0.5, 20, 0.5);
const NEAR = 0.02;
/** Hotbar slot 0 is window slot 36. */
const HOTBAR_START = 36;

function boatBot(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({ position: new Vec3(0.5, -60, 0.5), cells: { ...POOL, "-3,-60,0": "stone" }, carried: { oak_boat: 3 }, ...options });
}

/** Select `slot`, look at `aim`, use the held item for 100 ms and let the server answer; the boats that appeared. */
async function useAt({ bot, clock }: FakeHarness, slot: number, aim: Vec3, offHand = false) {
  const known = new Set(Object.keys(bot.entities));
  bot.setQuickBarSlot(slot);
  await bot.lookAt(aim, true);
  bot.activateItem(offHand);
  await clock.advance(100);
  bot.deactivateItem();
  await clock.advance(1_000);
  return Object.values(bot.entities).filter((entity) => entity.name === "oak_boat" && !known.has(String(entity.id)));
}

const boatsCarried = ({ bot }: FakeHarness) => bot.inventory.count(bot.registry.itemsByName.oak_boat!.id, null);

test("activateItem writes use_item with the hand, a sequence and the look, and sets usingHeldItem (inventory.js:127)", async () => {
  const harness = boatBot();
  const { bot, server } = harness;
  await bot.look(0, Math.PI / 2, true);
  bot.activateItem();
  assert.equal(bot.usingHeldItem, true);
  const packet = server.packets.find(({ name }) => name === "use_item")!;
  const { sequence, ...sent } = packet.data as { hand: number; sequence: number; rotation: { x: number; y: number } };
  // toNotchianYaw / toNotchianPitch: 180 minus the yaw in degrees, the pitch negated; straight up from a body facing north.
  assert.deepEqual(sent, { hand: 0, rotation: { x: 180, y: -90 } });
  assert.equal(typeof sequence, "number");
  bot.activateItem(true);
  assert.equal((server.packets.filter(({ name }) => name === "use_item")[1]!.data as { hand: number }).hand, 1, "the off hand's use");
});

test("a boat used at water is put at the surface point the look meets, one stack lighter", async () => {
  const harness = boatBot();
  const { bot } = harness;
  const spawned: string[] = [];
  bot.on("entitySpawn", (entity) => void spawned.push(entity.name!));
  const [boat, ...others] = await useAt(harness, 0, WATER_AIM);
  assert.deepEqual(others, []);
  assert.ok(Math.hypot(boat!.position.x - WATER_AIM.x, boat!.position.z - WATER_AIM.z) < NEAR, `at ${boat!.position}`);
  assert.ok(Math.abs(boat!.position.y - WATER_SURFACE) < NEAR, `at y ${boat!.position.y}`);
  assert.deepEqual(spawned, ["oak_boat"]);
  assert.equal(bot.entities[boat!.id], boat);
  assert.equal(boat!.kind, "Vehicles");
  assert.equal(bot.inventory.slots[HOTBAR_START], null, "a boat stacks to 1: the used stack is gone");
  assert.equal(boatsCarried(harness), 2);
});

/** An entity yaw travels as one byte, 256 steps a turn; a look east is Notchian yaw -90 degrees, exactly -64 steps. */
const DEGREES_PER_STEP = 360 / 256;

/** Look at the water `steps` byte steps past east (the pitch kept), use slot 0: the boat that was put. */
async function boatLookingEastPlus(steps: number) {
  const harness = boatBot();
  const { bot } = harness;
  const known = new Set(Object.keys(bot.entities));
  bot.setQuickBarSlot(0);
  // As the contract check turns: the aim rotated about the bot, so `lookAt` (yaw -pi/2 +- a little, Notchian 270 degrees) sends it.
  const turn = ((steps * DEGREES_PER_STEP) * Math.PI) / 180;
  const distance = WATER_AIM.x - bot.entity.position.x;
  await bot.lookAt(new Vec3(bot.entity.position.x + distance * Math.cos(turn), WATER_AIM.y, bot.entity.position.z + distance * Math.sin(turn)), true);
  bot.activateItem();
  await harness.clock.advance(200);
  return Object.values(bot.entities).find((entity) => entity.name === "oak_boat" && !known.has(String(entity.id)))!;
}

/** The yaw a signed byte decodes to in Mineflayer (`fromNotchianYawByte`): radians, 0 to 2 pi. */
const { fromNotchianYawByte } = createRequire(import.meta.url)("mineflayer/lib/conversions") as { fromNotchianYawByte(byte: number): number };

test("a boat's yaw is the look's floored to a signed byte of 256 steps a turn (contract check boat-placed-by-use): 0.3 of a step under east is -65, over it -64", async () => {
  for (const [steps, byte] of [[0.3, -64], [-0.3, -65], [0.9, -64], [-0.9, -65]] as const) {
    const boat = await boatLookingEastPlus(steps);
    assert.equal(boat.yaw, fromNotchianYawByte(byte), `${steps} steps from east: byte ${byte}`);
  }
});

test("a water plant counts as water: the boat is put at the surface above it", async () => {
  for (const cell of ["kelp", "seagrass"]) {
    const [boat] = await useAt(boatBot({ cells: { ...POOL, "3,-61,0": cell } }), 0, WATER_AIM);
    assert.ok(boat !== undefined && Math.abs(boat.position.y - WATER_SURFACE) < NEAR, `${JSON.stringify(cell)}`);
  }
});

test("the use ends when the used stack leaves the hand (inventory.js:84-103)", async () => {
  const harness = boatBot({ carried: { oak_boat: 1 } });
  await useAt(harness, 0, WATER_AIM);
  assert.equal(harness.bot.heldItem, null);
  assert.equal(harness.bot.usingHeldItem, false);
});

test("a boat on water sinks to its rest level 0.366 below the surface by 1.5 s and stays there", async () => {
  const harness = boatBot();
  const moved: number[] = [];
  harness.bot.on("entityMoved", (entity) => void moved.push(entity.position.y));
  const [boat] = await useAt(harness, 0, WATER_AIM);
  await harness.clock.advance(3_000);
  assert.ok(Math.abs(boat!.position.y - (WATER_SURFACE - 0.366)) < 0.001, `rests at ${boat!.position.y}`);
  assert.deepEqual(moved.map((y) => Math.round(y * 1000)), [Math.round((WATER_SURFACE - 0.366) * 1000)], "one move to the rest level");
});

const restLevel = WATER_SURFACE - 0.366;
const isResting = (boat: { position: Vec3 }) => Math.abs(boat.position.y - restLevel) < 0.001;

test("a boat rests 30 server ticks after it is put: a server at 10 ticks a second takes 3 s of clock, not 1.5", async () => {
  const harness = boatBot({ server: { ticksPerSecond: 10 } });
  const [boat] = await useAt(harness, 0, WATER_AIM);
  await harness.clock.advance(1_000);
  assert.equal(isResting(boat!), false, `still at the surface after 2.1 s of clock: ${boat!.position.y}`);
  await harness.clock.advance(2_500);
  assert.equal(isResting(boat!), true, `rests at ${boat!.position.y}`);
});

test("a boat put on water does not rest while the server is stopped, and rests once it has run its ticks again", async () => {
  const harness = boatBot();
  const [boat] = await useAt(harness, 0, WATER_AIM);
  harness.server.stop();
  await harness.clock.advance(10_000);
  assert.equal(isResting(boat!), false, "a stopped server runs no ticks");
  harness.server.resume();
  await harness.clock.advance(3_000);
  assert.equal(isResting(boat!), true, `rests at ${boat!.position.y}`);
});

test("a short stop is caught up: the boat rests inside the owed ticks at the resume", async () => {
  const harness = boatBot();
  const [boat] = await useAt(harness, 0, WATER_AIM);
  harness.server.stop();
  await harness.clock.advance(1_500);
  assert.equal(isResting(boat!), false);
  harness.server.resume();
  assert.equal(isResting(boat!), true, `rests at ${boat!.position.y}`);
});

test("a boat removed before its rest is not moved: nothing is heard and nothing throws", async () => {
  const harness = boatBot();
  const moved: number[] = [];
  harness.bot.on("entityMoved", (entity) => void moved.push(entity.id));
  const [boat] = await useAt(harness, 0, WATER_AIM);
  harness.entities.remove(boat!.id);
  await harness.clock.advance(3_000);
  assert.deepEqual(moved, []);
  assert.equal(harness.bot.entities[boat!.id], undefined);
});

test("a boat put on water and mounted at once keeps the rider's moves: the rest level is the server's own, not a rider's", async () => {
  const harness = boatBot();
  const [boat] = await useAt(harness, 0, WATER_AIM);
  harness.bot.mount(boat!);
  await harness.clock.advance(100);
  harness.bot._client.write("vehicle_move", { x: 3.6, y: WATER_SURFACE - 0.2, z: 0.5, yaw: -90, pitch: 0, onGround: false });
  await harness.clock.advance(2_000);
  assert.ok(Math.abs(boat!.position.y - (WATER_SURFACE - 0.2)) < 1e-6, `${boat!.position.y}`);
  assert.ok(Math.abs(harness.server.serverPositionOf(boat!.id)!.y - (WATER_SURFACE - 0.2)) < 1e-6);
});

test("nothing is put for the sky, ground past the 4.5 reach or a wall's face; the stack is kept", async () => {
  for (const [label, aim] of [["sky", SKY_AIM], ["4.7 blocks", OUT_OF_REACH_AIM], ["wall", WALL_AIM]] as const) {
    const harness = boatBot();
    assert.deepEqual(await useAt(harness, 0, aim), [], label);
    assert.equal(boatsCarried(harness), 3, label);
    assert.ok(harness.server.packets.some(({ name }) => name === "use_item"), `${label}: the use was sent`);
  }
});

test("a second boat is not put on the spot the first holds; a boat 4.4 blocks away is, on ground where it stays, with an id of its own", async () => {
  const harness = boatBot();
  const [first] = await useAt(harness, 0, WATER_AIM);
  assert.deepEqual(await useAt(harness, 1, WATER_AIM), [], "boats collide");
  assert.equal(boatsCarried(harness), 2, "the refused use kept its stack");
  const [far] = await useAt(harness, 1, IN_REACH_AIM);
  await harness.clock.advance(3_000);
  assert.ok(far!.position.distanceTo(IN_REACH_AIM) < NEAR, `a boat on ground stays where it was put: ${far!.position}`);
  assert.notEqual(far!.id, first!.id);
  assert.equal(boatsCarried(harness), 1);
});

test("a creative bot keeps its stack", async () => {
  const harness = boatBot({ gameMode: "creative" });
  assert.equal((await useAt(harness, 0, WATER_AIM)).length, 1);
  assert.equal(boatsCarried(harness), 3);
});

test("a boat held in the off hand is used from there", async () => {
  const harness = boatBot({ carried: {}, slots: { 45: { name: "oak_boat" } } });
  const [boat] = await useAt(harness, 0, WATER_AIM, true);
  assert.ok(boat !== undefined);
  assert.equal(harness.bot.inventory.slots[45], null);
});

test("a use of an item that is no boat sends the packet and changes nothing else", async () => {
  const harness = boatBot({ carried: { cobblestone: 5 } });
  assert.deepEqual(await useAt(harness, 0, WATER_AIM), []);
  assert.equal(harness.bot.inventory.count(harness.bot.registry.itemsByName.cobblestone!.id, null), 5);
});

test("the boat comes with the server's answer: not while it is stopped, a lag later when it lags", async () => {
  const stopped = boatBot();
  stopped.server.stop();
  assert.deepEqual(await useAt(stopped, 0, WATER_AIM), []);
  stopped.server.resume();
  await stopped.clock.advance(100);
  assert.equal(Object.values(stopped.bot.entities).filter(({ name }) => name === "oak_boat").length, 1, "answered once it is back");
  const lagging = boatBot({ lagMs: 200 });
  lagging.bot.setQuickBarSlot(0);
  await lagging.bot.lookAt(WATER_AIM, true);
  lagging.bot.activateItem();
  await lagging.clock.advance(150);
  assert.equal(boatsCarried(lagging), 3);
  await lagging.clock.advance(150);
  assert.equal(boatsCarried(lagging), 2);
});

test("two harnesses on one clock each put their own boat, the other's stack untouched", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const first = boatBot({ clock });
  const second = boatBot({ clock });
  first.bot.setQuickBarSlot(0);
  await first.bot.lookAt(WATER_AIM, true);
  first.bot.activateItem();
  await clock.advance(200);
  assert.equal(boatsCarried(first), 2);
  assert.equal(boatsCarried(second), 3);
  assert.equal(Object.values(second.bot.entities).filter(({ name }) => name === "oak_boat").length, 0);
});

test("a boat put beside her takes her when she mounts it, and the server has her seated", async () => {
  const harness = boatBot();
  const [boat] = await useAt(harness, 0, WATER_AIM);
  harness.bot.mount(boat!);
  await harness.clock.advance(100);
  assert.equal(harness.bot.vehicle, boat);
  assert.equal(harness.server.riderOf(boat!.id), harness.bot.entity.id);
});
