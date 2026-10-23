import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";
import { exactBlockGoal } from "../../navigation/goals/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { createNavigationRuntime } from "../../navigation/runtime.js";
import { createFakeClock } from "./fake-clock.js";

/** A red bed one block east of the feet, its head further east: the contract scene (`bed-sleep-and-wake`) on the fake's ground. */
const BED_FOOT = new Vec3(1, 64, 0);
const BED_HEAD = new Vec3(2, 64, 0);
const BED_CELLS: NonNullable<FakeBotOptions["cells"]> = {
  "1,64,0": { name: "red_bed", properties: { facing: "east", occupied: "false", part: "foot" } },
  "2,64,0": { name: "red_bed", properties: { facing: "east", occupied: "false", part: "head" } },
};
const NIGHT = 14_000;
const NOON = 6_000;
const NIGHT_START = 12_541;
/** A server answer reaches the client one slice after the packet that asked (`FakeServer.answer`). */
const DELIVERY_MS = 50;
/** The sleep that skips the night: 100 ticks (`bed-sleep-and-wake`, measured on a 1.21.4 server). */
const SKIP_AFTER_MS = 5_000;

/** A bot in a bedroom at night: the bed, and the options a test adds. */
function bedroom(options: FakeBotOptions = {}): FakeHarness {
  return createFakeBot({ cells: BED_CELLS, ...options, server: { timeOfDay: NIGHT, ...options.server } });
}

/** The index of a player metadata field in the version's registry (`entities.js:481-484` reads `pose` and `sleeping_pos` by key). */
function keyOf(bot: FakeHarness["bot"], name: string): number {
  return bot.registry.entitiesByName.player!.metadataKeys!.indexOf(name);
}

/** The event names the client hears of a sleep, in order. */
function watchSleep(bot: FakeHarness["bot"]): string[] {
  const events: string[] = [];
  for (const name of ["sleep", "wake"] as const) bot.on(name, () => void events.push(name));
  return events;
}

/** The translation keys of the action-bar messages the client hears. */
function watchActionBar(bot: FakeHarness["bot"]): string[] {
  const messages: string[] = [];
  bot.on("actionBar", (message) => void messages.push((message as unknown as { translate: string }).translate));
  return messages;
}

/** Mineflayer turns to the bed before the use (`activateBlock`: a look of about 11 ticks), then the server answers. */
const USE_MS = 1_000;

/** Sleep in the bed and let the look and the answer pass. */
async function sleepIn(h: FakeHarness): Promise<void> {
  const outcome = h.bot.sleep(h.bot.blockAt(BED_FOOT)!);
  await h.clock.advance(USE_MS);
  await outcome;
}

const occupiedAt = (h: FakeHarness, cell: Vec3): string => String(h.bot.blockAt(cell)!.getProperties().occupied);
const writtenBlockPlaces = (h: FakeHarness): number => h.server.packets.filter((packet) => packet.name === "block_place").length;

test("a weather set on the server ramps the rain level a hundredth a tick, and the client reads it as rain.js does (isRaining, rainState, thunderState, weatherUpdate)", async () => {
  const { bot, clock, server } = createFakeBot({});
  assert.deepEqual([bot.isRaining, bot.rainState, bot.thunderState], [false, 0, 0]);
  const updates: number[] = [];
  bot.on("weatherUpdate", () => void updates.push(bot.rainState));
  server.setWeather("rain");
  await clock.advance(1_000 + DELIVERY_MS);
  assert.equal(bot.isRaining, true);
  assert.ok(Math.abs(bot.rainState - 0.2) < 0.015, `after 20 ticks ${bot.rainState}`);
  assert.equal(bot.thunderState, 0);
  await clock.advance(5_000);
  assert.equal(bot.rainState, 1);
  // A hundred rain steps, and the flag flip past 0.2 sends both levels again (contract rain-and-thunder-state: 100 steps in 102 updates).
  assert.equal(updates.length, 102);
});

test("thunder raises the thunder level the same way, and clear lowers both: the rain flag drops when the level is back at 0.2 (4 s), the levels follow to 0", async () => {
  const { bot, clock, server } = createFakeBot({});
  server.setWeather("thunder");
  await clock.advance(6_000);
  assert.deepEqual([bot.isRaining, bot.rainState, bot.thunderState], [true, 1, 1]);
  server.setWeather("clear");
  await clock.advance(1_000);
  assert.equal(bot.isRaining, true, "the server still counts rain above a level of 0.2");
  await clock.advance(3_100);
  assert.equal(bot.isRaining, false, "stop_raining came at 0.2, 80 ticks after the clear");
  assert.ok(bot.rainState > 0.15 && bot.rainState < 0.25, `${bot.rainState}`);
  await clock.advance(2_000);
  assert.deepEqual([bot.rainState, bot.thunderState], [0, 0]);
});

test("a world that starts in a thunderstorm tells the bot at creation, at the full levels", () => {
  const { bot } = createFakeBot({ server: { weather: "thunder" } });
  assert.deepEqual([bot.isRaining, bot.rainState, bot.thunderState], [true, 1, 1]);
});

test("timePacketYet false leaves the client with no world age until the first time packet, as time.js starts", async () => {
  const { bot, clock } = createFakeBot({ server: { timePacketYet: false } });
  assert.equal(bot.time.age, null);
  assert.equal(bot.time.timeOfDay, null);
  await clock.advance(1_000);
  assert.equal(bot.time.age, 24_020);
  assert.equal(bot.time.timeOfDay, 6_020);
});

test("a night sleep is accepted: sleep and isSleeping, the pose and the bed's head in her metadata, the bed shown occupied", async () => {
  const h = bedroom();
  const events = watchSleep(h.bot);
  await sleepIn(h);
  assert.deepEqual(events, ["sleep"]);
  assert.equal(h.bot.isSleeping, true);
  const metadata = h.bot.entity.metadata as unknown[];
  assert.equal(metadata[keyOf(h.bot, "pose")], 2);
  assert.deepEqual(metadata[keyOf(h.bot, "sleeping_pos")], { x: BED_HEAD.x, y: BED_HEAD.y, z: BED_HEAD.z });
  assert.equal(occupiedAt(h, BED_FOOT), "true");
  assert.equal(occupiedAt(h, BED_HEAD), "true");
});

test("wake before the night is skipped frees her at once with the night on and the bed free again", async () => {
  const h = bedroom();
  const events = watchSleep(h.bot);
  await sleepIn(h);
  await h.bot.wake();
  await h.clock.advance(DELIVERY_MS * 2);
  assert.deepEqual(events, ["sleep", "wake"]);
  assert.equal(h.bot.isSleeping, false);
  assert.equal(occupiedAt(h, BED_FOOT), "false");
  assert.ok(h.bot.time.timeOfDay >= NIGHT);
  assert.equal((h.bot.entity.metadata as unknown[])[keyOf(h.bot, "pose")], 0);
});

test("wake while awake is Mineflayer's own error, and writes no packet", async () => {
  const h = bedroom();
  await assert.rejects(h.bot.wake(), /already awake/u);
  assert.equal(h.server.packets.some((packet) => packet.name === "entity_action"), false);
});

test("a sleep left alone is cut off 100 ticks on by the server skipping the night: the time packet at the dawn, then the wake", async () => {
  const h = bedroom();
  const events = watchSleep(h.bot);
  const times: number[] = [];
  h.bot.on("time", () => void times.push(h.bot.time.time));
  await sleepIn(h);
  await h.clock.advance(SKIP_AFTER_MS - USE_MS - DELIVERY_MS * 4);
  assert.deepEqual(events, ["sleep"], "still asleep before the hundredth tick");
  await h.clock.advance(1_000);
  assert.deepEqual(events, ["sleep", "wake"]);
  assert.ok(h.bot.time.timeOfDay < NIGHT_START, `morning: ${h.bot.time.timeOfDay}`);
  assert.ok(h.bot.time.time >= 24_000 && h.bot.time.time - 24_000 <= 20, `the dawn: ${h.bot.time.time}`);
  assert.equal(times.at(-1), h.bot.time.time);
  assert.equal(occupiedAt(h, BED_FOOT), "false");
});

test("another player awake keeps the night: no skip, the sleeper stays asleep; the others asleep too, the skip comes", async () => {
  const awake = bedroom({ players: { Alice: { sleeping: false } } });
  await sleepIn(awake);
  await awake.clock.advance(SKIP_AFTER_MS + 2_000);
  assert.equal(awake.bot.isSleeping, true);
  assert.ok(awake.bot.time.timeOfDay >= NIGHT);

  const asleep = bedroom({ players: { Alice: { sleeping: true } } });
  await sleepIn(asleep);
  await asleep.clock.advance(SKIP_AFTER_MS + 2_000);
  assert.equal(asleep.bot.isSleeping, false);
  assert.ok(asleep.bot.time.timeOfDay < NIGHT_START);
});

test("the players option files a sleeper's pose and bed at the version's metadata keys, an awake one's pose standing, and gives a player with no entity none", () => {
  const { bot } = createFakeBot({ players: { Alice: { sleeping: true }, Bob: { sleeping: false }, Carol: {} } });
  const alice = bot.players.Alice!.entity.metadata as unknown[];
  assert.equal(alice[keyOf(bot, "pose")], 2);
  assert.notEqual(alice[keyOf(bot, "sleeping_pos")], null);
  const bob = bot.players.Bob!.entity.metadata as unknown[];
  assert.equal(bob[keyOf(bot, "pose")], 0);
  assert.equal(bob[keyOf(bot, "sleeping_pos")], null);
  assert.equal(bot.players.Carol!.entity, undefined);
});

test("with a monster near Mineflayer refuses before any packet; the use sent anyway is refused by the server with the not-safe action bar", async () => {
  const h = bedroom({ entities: { 7: { name: "zombie", position: new Vec3(4.5, 64, 3.5) } } });
  const messages = watchActionBar(h.bot);
  await assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /monsters nearby/u);
  assert.equal(writtenBlockPlaces(h), 0);

  const use = h.bot.activateBlock(h.bot.blockAt(BED_FOOT)!);
  await h.clock.advance(USE_MS);
  await use;
  assert.deepEqual(messages, ["block.minecraft.bed.not_safe"]);
  assert.equal(h.bot.isSleeping, false);
  assert.equal(writtenBlockPlaces(h), 1);
});

test("a monster outside the 8 by 5 by 8 box around the bed does not refuse", async () => {
  const h = bedroom({ entities: { 7: { name: "zombie", position: new Vec3(14.5, 64, 0.5) } } });
  await sleepIn(h);
  assert.equal(h.bot.isSleeping, true);
});

test("by day Mineflayer throws before any packet; a use of the bed by day is answered with the no-sleep action bar", async () => {
  const h = bedroom({ server: { timeOfDay: NOON } });
  const messages = watchActionBar(h.bot);
  await assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /not night/u);
  assert.equal(writtenBlockPlaces(h), 0);
  const use = h.bot.activateBlock(h.bot.blockAt(BED_FOOT)!);
  await h.clock.advance(USE_MS);
  await use;
  assert.deepEqual(messages, ["block.minecraft.bed.no_sleep"]);
  assert.equal(h.bot.isSleeping, false);
});

test("at noon a full thunderstorm allows the sleep; rain alone does not", async () => {
  const stormy = bedroom({ server: { timeOfDay: NOON, weather: "thunder" } });
  await sleepIn(stormy);
  assert.equal(stormy.bot.isSleeping, true);

  const rainy = bedroom({ server: { timeOfDay: NOON, weather: "rain" } });
  await assert.rejects(rainy.bot.sleep(rainy.bot.blockAt(BED_FOOT)!), /not night/u);
});

/** Mineflayer waits for a sleep with a timer of the global clock: a test that outlasts it runs on a clock that moves that too. */
function onMockedClock(options: FakeBotOptions = {}): { harness: FakeHarness; installed: Disposable } {
  const clock = createFakeClock({ mode: "mocked" });
  return { harness: bedroom({ ...options, clock }), installed: clock.install() };
}

test("a storm still ramping is let through by Mineflayer (any thunder level) and refused by the server, which wants the sky dark: not measured, the game's skyDarken rule", async () => {
  const { harness: h, installed } = onMockedClock({ server: { timeOfDay: NOON, weather: "rain" } });
  using _installed = installed;
  h.server.setWeather("thunder");
  await h.clock.advance(100);
  const refused = assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /bot is not sleeping/u);
  await h.clock.advance(3_100);
  await refused;
  assert.equal(h.bot.isSleeping, false);
});

test("a bed out of reach is Mineflayer's refusal (its reach test comes before the too-far one), with no packet", async () => {
  const h = bedroom({ position: new Vec3(12.5, 64, 0.5) });
  await assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /cant click the bed/u);
  assert.equal(writtenBlockPlaces(h), 0);
});

test("a server stopped while she sleeps skips nothing until it runs again", async () => {
  const h = bedroom();
  await sleepIn(h);
  h.server.stop();
  await h.clock.advance(SKIP_AFTER_MS * 2);
  assert.equal(h.bot.isSleeping, true);
  h.server.resume();
  await h.clock.advance(SKIP_AFTER_MS + 1_000);
  assert.equal(h.bot.isSleeping, false);
});

test("an answer later than Mineflayer's 3 s wait: sleep rejects, and the bed seats her all the same when the server answers", async () => {
  const { harness: h, installed } = onMockedClock({ lagMs: 4_000 });
  using _installed = installed;
  const rejected = assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /bot is not sleeping/u);
  await h.clock.advance(3_100);
  await rejected;
  assert.equal(h.bot.isSleeping, false);
  await h.clock.advance(2_000);
  assert.equal(h.bot.isSleeping, true);
});

test("a second sleep while she sleeps is Mineflayer's own error", async () => {
  const h = bedroom();
  await sleepIn(h);
  await assert.rejects(h.bot.sleep(h.bot.blockAt(BED_FOOT)!), /already sleeping/u);
});

test("a sleeper wakes the tick the day comes, with the other players still awake (an operator's time set; Player.tick stops a sleep once the sky is bright: not measured)", async () => {
  const h = bedroom({ players: { Bob: { sleeping: false } } });
  const events = watchSleep(h.bot);
  await sleepIn(h);
  assert.deepEqual(events, ["sleep"]);
  h.server.setDayTime(24_000);
  await h.clock.advance(DELIVERY_MS * 3);
  assert.deepEqual(events, ["sleep", "wake"]);
  assert.equal(h.bot.isSleeping, false);
  assert.equal(occupiedAt(h, BED_FOOT), "false");
});

test("end state asleep -> awake: after a wake a navigate of 3 blocks on the body finishes", async () => {
  const { harness: h, installed } = onMockedClock({ simulatePhysics: true, groundY: 63 });
  using _installed = installed;
  await sleepIn(h);
  await h.bot.wake();
  await h.clock.advance(DELIVERY_MS * 3);
  assert.equal(h.bot.isSleeping, false);
  const navigation = createNavigationRuntime(h.bot);
  try {
    const route = navigation.navigate({ movements: createMovementPolicy({ allowDigging: false, allowParkour: false }), goal: exactBlockGoal({ x: -3, y: 64, z: 0 }) });
    const result = await h.clock.settle(route, 20_000);
    assert.equal(result.status, "completed");
    assert.ok(h.bot.entity.position.x < -2, `walked west: ${h.bot.entity.position}`);
  } finally {
    await navigation.close();
  }
});

test("a bed use places nothing: a block held in the hand stays in the hand and its cell stays empty", async () => {
  const h = bedroom({ carried: { dirt: 2 } });
  await sleepIn(h);
  assert.equal(h.bot.isSleeping, true);
  assert.equal(h.bot.blockAt(BED_FOOT.offset(0, 1, 0))!.name, "air");
  assert.equal(h.inventory.count(h.bot.registry.itemsByName.dirt!.id, null), 2);
});

test("the skip clears the storm on the server's own weather, whatever the client heard: the levels fall to 0", async () => {
  const h = bedroom({ server: { weather: "thunder" }, lagMs: 0 });
  await sleepIn(h);
  await h.clock.advance(SKIP_AFTER_MS + 1_000);
  assert.equal(h.bot.isSleeping, false);
  await h.clock.advance(6_000);
  assert.deepEqual([h.server.rainLevel, h.server.thunderLevel, h.bot.rainState, h.bot.thunderState], [0, 0, 0, 0]);
});

test("a monster is in the box when its body reaches it: a zombie standing just outside the box edge but with its body across it refuses the use, one wholly outside does not", async () => {
  // The head lies at x 2: the box runs to x 2 + 1 + 8 = 11 (the game: the bed cell grown 8, tested against the monster's body, 0.6 wide).
  // Mineflayer's own test is by the monster's point and lets both through: it is the server's answer that is heard.
  const heard = async (x: number) => {
    const h = bedroom({ entities: { 7: { name: "zombie", position: new Vec3(x, 64, 0.5) } } });
    const messages = watchActionBar(h.bot);
    const use = h.bot.activateBlock(h.bot.blockAt(BED_FOOT)!);
    await h.clock.advance(USE_MS);
    await use;
    return { messages, asleep: h.bot.isSleeping };
  };
  assert.deepEqual(await heard(11.2), { messages: ["block.minecraft.bed.not_safe"], asleep: false });
  assert.deepEqual(await heard(11.4), { messages: [], asleep: true });
});
