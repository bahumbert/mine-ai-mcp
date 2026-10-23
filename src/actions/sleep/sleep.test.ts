import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { type FakeBotOptions, type FakeCell, type FakeHarness, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { parseSleepRequest, sleepOutcomes } from "./contract.js";
import { beginSleep, executeSleep, formatSleepResult } from "./sleep.js";

const NIGHT = 14_000;
const DAY = 6_000;
/** The bed's head lies one block from its foot toward the way it faces (`bed.js` `parseBedMetadata`). */
const HEAD_OFFSETS = { east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1) };
type Facing = keyof typeof HEAD_OFFSETS;

/** Both halves of a bed as the game stores them: the foot at `foot`, the head one block toward `facing`. */
function bedCells(name: string, foot: Vec3, { facing = "east", occupied = false }: { facing?: Facing; occupied?: boolean } = {}): Record<string, FakeCell> {
  const half = (part: string, at: Vec3): [string, FakeCell] => [at.toArray().join(","), { name, properties: { facing, occupied: String(occupied), part } }];
  return Object.fromEntries([half("foot", foot), half("head", foot.plus(HEAD_OFFSETS[facing]))]);
}

/** Put a bed in the world after the start (a bed placed, taken, or occupied by another player). */
function setBed(harness: FakeHarness, name: string, foot: Vec3, options: { facing?: Facing; occupied?: boolean } = {}): void {
  for (const [key, cell] of Object.entries(bedCells(name, foot, options))) harness.world.setCell(new Vec3(...key.split(",").map(Number) as [number, number, number]), cell);
}

/** A bot at night on the fake's mocked clock, standing at the origin of the old tests. */
function sleeper(options: FakeBotOptions = {}): FakeHarness {
  const clock = options.clock ?? createFakeClock({ mode: "mocked" });
  return createFakeBot({ position: { x: 0, y: 64, z: 0 }, ...options, clock, server: { timeOfDay: NIGHT, ...options.server } });
}

const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;

/** Bed blocks written to the server by a `block_place`: how many times the bot used a block. */
const blockUses = (harness: FakeHarness): number => harness.server.packets.filter((packet) => packet.name === "block_place").length;

test("finds the bed in the diagonal section missed during the run 12 underground return", async () => {
  const bedPos = new Vec3(80, 66, 135);
  const h = sleeper({ position: { x: 71.51, y: 38, z: 144.49 }, cells: bedCells("white_bed", bedPos) });
  using _installed = h.clock.install();
  const navigation = {
    ...fakeNavigation,
    navigate: async () => {
      h.bot.entity.position = bedPos.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as NavigationRuntime;

  const result = await h.clock.settle(executeSleep(h.bot, navigation, {}), 60_000);
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.sleep?.bedPosition, { x: 80, y: 66, z: 135 });
});

test("parses sleep requests with zero arguments and rejects unknown keys", () => {
  assert.deepEqual(parseSleepRequest({}), {});
  assert.deepEqual(parseSleepRequest(undefined), {});
  assert.throws(() => parseSleepRequest({ unexpected: 123 }));
});

test("refuses to sleep in the Nether or the End to avoid explosions", async () => {
  const h = sleeper({ dimension: "the_nether" });
  using _installed = h.clock.install();
  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 1_000);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.dimensionUnsafe);
  }
});

test("reports immediately if bot is already sleeping", async () => {
  const h = sleeper();
  using _installed = h.clock.install();
  h.bot.isSleeping = true;
  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 1_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.asleep, true);
  assert.equal(result.sleep?.observation, sleepOutcomes.alreadySleeping);
});

test("refuses if no bed is nearby and none is in inventory, advising wool and wood", async () => {
  const h = sleeper();
  using _installed = h.clock.install();
  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 10_000);

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.noBedFound);
  }
});

test("skips occupied beds and chooses an unoccupied one", async () => {
  // The taken bed lies west of the free one, so the nearest-first scan meets its halves, then the free bed's foot at 3,64,0.
  const h = sleeper({
    server: { timeOfDay: 15_000 },
    cells: { ...bedCells("red_bed", new Vec3(2, 64, 0), { facing: "west", occupied: true }), ...bedCells("blue_bed", new Vec3(3, 64, 0)) },
  });
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 60_000);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.sleep?.bedPosition, { x: 3, y: 64, z: 0 });
  assert.equal(result.sleep?.morning, true);
});

test("sets respawn point during daytime when night sleep is unavailable", async () => {
  const bedPos = new Vec3(2, 64, 0);
  const h = sleeper({ server: { timeOfDay: DAY }, cells: bedCells("white_bed", bedPos) });
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 10_000);

  assert.equal(result.status, "succeeded");
  assert.equal(blockUses(h), 1, "the bed was used: the server's block_place");
  assert.equal(result.sleep?.respawnSet, true);
  assert.equal(result.sleep?.morning, false);
  assert.equal(result.sleep?.asleep, false);
  assert.equal(result.sleep?.timeOfDay, 6000);
  assert.equal(result.sleep?.ticksUntilNight, 6542);
  assert.equal(result.sleep?.minutesUntilNight, 6542 / 20 / 60);
  assert.equal(result.sleep?.observation, sleepOutcomes.daytimeRespawnSet(6000));
  assert.equal(result.sleep?.warning, sleepOutcomes.noBedInInventory("white_bed", bedPos));
  const markdown = formatSleepResult(result);
  assert.match(markdown, /Respawn point set at the bed/);
  assert.match(markdown, /Respawn set: true/);
  assert.match(markdown, /Ticks until night: 6542/);
  assert.match(markdown, /Time until night at 20 ticks\/second: 5\.45 minutes/);
  assert.match(markdown, /Bed: `2, 64, 0`/);
  assert.match(markdown, /Bed reminder/);
  assert.match(markdown, /collect_block/);
});

test("does not warn when another bed remains in inventory", async () => {
  const h = sleeper({ server: { timeOfDay: DAY }, carried: { cyan_bed: 1 }, cells: bedCells("white_bed", new Vec3(2, 64, 0)) });
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 10_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.warning, undefined);
  assert.doesNotMatch(formatSleepResult(result), /Bed reminder/);
});

test("does not claim a daytime respawn point when activation is rejected", async () => {
  const h = sleeper({
    server: { timeOfDay: DAY },
    cells: bedCells("white_bed", new Vec3(2, 64, 0)),
    overrides: { activateBlock: async () => { throw new Error("server refused interaction"); } },
  });
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 10_000);

  assert.equal(result.status, "failed");
  assert.equal(result.sleep?.respawnSet, false);
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.respawnRejected("server refused interaction"));
  }
});

test("sleeps through the night and wakes up in the morning", async () => {
  const h = sleeper({
    server: { timeOfDay: 15_000 },
    // Bob is awake, so the server keeps the night: the morning comes by an operator's time set at the test's tick.
    players: { Alice: { sleeping: true }, Bob: { sleeping: false }, Carol: {} },
    cells: bedCells("red_bed", new Vec3(2, 64, 0)),
  });
  using _installed = h.clock.install();

  const execution = executeSleep(h.bot, fakeNavigation, {});
  await h.clock.advance(2_000);
  assert.equal(h.bot.isSleeping, true);
  h.server.setDayTime(24_000);
  const result = await h.clock.settle(execution, 30_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.morning, true);
  assert.equal(result.sleep?.timeOfDay, 0);
  assert.equal(result.sleep?.respawnSet, true);
  assert.equal(result.sleep?.observation, sleepOutcomes.sleptMorning);
  assert.deepEqual(result.sleep?.otherPlayers, [
    { username: "Alice", sleepState: "sleeping" },
    { username: "Bob", sleepState: "awake" },
    { username: "Carol", sleepState: "unknown" },
  ]);
  const markdown = formatSleepResult(result);
  assert.match(markdown, /Alice: sleeping/);
  assert.match(markdown, /Bob: awake/);
  assert.match(markdown, /Carol: sleep state unknown/);
});

test("keeps waiting for morning if the bot leaves bed early", async () => {
  const controller = new AbortController();
  const h = sleeper({ server: { timeOfDay: 15_000 }, cells: bedCells("red_bed", new Vec3(2, 64, 0)) });
  using _installed = h.clock.install();

  let settled = false;
  const execution = executeSleep(h.bot, fakeNavigation, {}, controller.signal).finally(() => {
    settled = true;
  });
  await h.clock.advance(2_000);
  assert.equal(h.bot.isSleeping, true);
  await h.bot.wake();
  await h.clock.advance(2_000);

  assert.equal(h.bot.isSleeping, false);
  assert.equal(settled, false);
  controller.abort();
  await assert.rejects(execution, { name: "AbortError" });
});

test("reports an observed nearby hostile instead of Mineflayer's generic sleep timeout", async () => {
  const h = sleeper({
    cells: bedCells("white_bed", new Vec3(2, 64, 0)),
    entities: { 17: { name: "zombie", position: new Vec3(4.5, 64, 1) } },
  });
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 10_000);

  assert.equal(result.status, "failed");
  assert.equal(blockUses(h), 0, "no sleep was tried");
  if (result.status === "failed") {
    assert.match(result.error, /^\[BED_HOSTILES_NEARBY\]/);
    assert.match(result.error, /zombie \(2\.69 blocks\)/);
    assert.equal(result.sleep?.nearbyHostiles?.[0]?.name, "zombie");
  }
  assert.match(formatSleepResult(result), /Nearby hostile mobs/);
  assert.match(formatSleepResult(result), /`4, 64, 1`/);
});

/** The way a placed bed's head lies from the bot's look (the game's `getDirection`), as the nearest of the four sides. */
function facingOfYaw(yaw: number): Facing {
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  if (Math.abs(x) > Math.abs(z)) return x > 0 ? "east" : "west";
  return z > 0 ? "south" : "north";
}

/** A bot carrying one bed that places it on the stone at y 63; `placements` counts how many beds were put down. */
function bedPlacingBot(clock = createFakeClock({ mode: "mocked" }), walksOff = true) {
  const state = { placedAt: null as Vec3 | null, facing: "east" as Facing, placements: 0 };
  // The bot ends up eight blocks from the bed it places (placement walked it off), so every sleep has a route to take.
  const h = sleeper({ clock, server: { timeOfDay: 15_000, startAge: 24_000 }, carried: { cyan_bed: 1 } });
  const bedType = h.bot.registry.itemsByName.cyan_bed!.id;
  Object.assign(h.bot, {
    // Stopgap until task W2 gives the fake the server's placement of a held bed (both halves, the item taken): `place_block.js`.
    _placeBlockWithOptions: async (support: { position: Vec3 }) => {
      state.placedAt = support.position.offset(0, 1, 0);
      state.placements += 1;
      state.facing = facingOfYaw(h.bot.entity.yaw);
      setBed(h, "cyan_bed", state.placedAt, { facing: state.facing });
      setCarriedCount(h.inventory, h.bot.registry, bedType, 0);
      if (walksOff) h.bot.entity.position = state.placedAt.offset(8, 0, 0);
    },
  });
  return { h, state };
}

test("places a carried bed and sleeps in it when no bed is around", async () => {
  const { h } = bedPlacingBot(undefined, false);
  using _installed = h.clock.install();

  const result = await h.clock.settle(executeSleep(h.bot, fakeNavigation, {}), 60_000);

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.placedBed, true);
  assert.equal(result.sleep?.morning, true);
  assert.match(result.sleep?.warning ?? "", /No bed remains in inventory/);
  assert.match(result.sleep?.warning ?? "", /cyan_bed/);
  assert.match(result.sleep?.warning ?? "", /collect_block/);
});

/** A navigation that walks to the placed bed; given an owner, its first route is the one a reflex aborts. */
function walkToPlacedBed(h: FakeHarness, state: { placedAt: Vec3 | null }, owner?: AbortController): NavigationRuntime {
  let routes = 0;
  return {
    navigate: async () => {
      routes += 1;
      if (owner && routes === 1) { owner.abort(new Error("hunger reflex")); throw owner.signal.reason; }
      h.bot.entity.position = state.placedAt!.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
}

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal, each run on the clock. */
function sleepAttempts(h: FakeHarness, navigation: NavigationRuntime) {
  const run = beginSleep(h.bot, navigation, {}, () => {});
  return (signal?: AbortSignal) => h.clock.settle(run({ signal }), 60_000);
}

test("a sleep cut off on the way to the bed it placed sleeps in that bed next time, without placing another", async () => {
  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install();
  const owner = new AbortController();
  const attempt = sleepAttempts(h, walkToPlacedBed(h, state, owner));

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(state.placements, 1);
  assert.equal(result.sleep?.placedBed, true);
  assert.equal(result.sleep?.morning, true);
});

test("a bed placed just before the abort is found again by the next attempt, not replaced from an empty inventory", async () => {
  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install();
  const owner = new AbortController();
  const place = (h.bot as unknown as { _placeBlockWithOptions: (...args: unknown[]) => Promise<void> })._placeBlockWithOptions;
  let placeCalls = 0;
  Object.assign(h.bot, {
    _placeBlockWithOptions: async (...args: unknown[]) => {
      placeCalls += 1;
      await place(...args);
      owner.abort(new Error("fall reflex"));
      throw owner.signal.reason;
    },
  });
  const attempt = sleepAttempts(h, walkToPlacedBed(h, state));

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(placeCalls, 1);
  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.placedBed, true);
});

test("a bed that was taken between attempts is reported missing, and no second bed is placed", async () => {
  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install(); // the placement was sent a moment ago: "gone" is the answer once the world age moved 40 ticks
  const owner = new AbortController();
  const navigation = walkToPlacedBed(h, state, owner);
  const attempt = sleepAttempts(h, navigation);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  for (const cell of [state.placedAt!, state.placedAt!.plus(HEAD_OFFSETS[state.facing])]) h.world.setCell(cell, "air");
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.equal(state.placements, 1);
  if (result.status === "failed") assert.equal(result.error, sleepOutcomes.noBedFound);
});

test("a second call after a sleep that finished returns its success without sleeping again", async () => {
  const h = sleeper({ server: { timeOfDay: 15_000 }, cells: bedCells("red_bed", new Vec3(2, 64, 0)) });
  using _installed = h.clock.install();
  let sleeps = 0;
  const sleep = h.bot.sleep;
  h.bot.sleep = async (...args: Parameters<typeof sleep>) => { sleeps += 1; await sleep(...args); };
  const attempt = sleepAttempts(h, fakeNavigation);

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.deepEqual(second, first);
  assert.equal(sleeps, 1);
});

test("a bed another player now occupies is not ours: the free bed found instead is not reported as placed", async () => {
  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install();
  const owner = new AbortController();
  let walksTo: Vec3 | null = null; // where a route ends; the first route is the one the reflex aborts
  let routes = 0;
  const navigation = {
    navigate: async () => {
      routes += 1;
      if (routes === 1) { owner.abort(new Error("hunger reflex")); throw owner.signal.reason; }
      h.bot.entity.position = walksTo!.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const attempt = sleepAttempts(h, navigation);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  // Our bed is taken by someone else; another free bed stands nearby.
  setBed(h, "cyan_bed", state.placedAt!, { facing: state.facing, occupied: true });
  const otherBed = state.placedAt!.offset(4, 0, 0);
  // Its head lies away from the bot (which stands east of both beds), so the scan meets the foot first: the position asserted below.
  setBed(h, "cyan_bed", otherBed, { facing: "west" });
  walksTo = otherBed;
  const result = await attempt(new AbortController().signal);

  assert.equal(state.placements, 1);
  assert.deepEqual(result.sleep?.bedPosition, { x: otherBed.x, y: otherBed.y, z: otherBed.z });
  assert.equal(result.sleep?.placedBed, false, "the bed slept in is not the one this request put down");
});

test("a bed a reflex set down in the footprint before the send is not ours", async () => {
  // Where the request's bed would go: learned from a complete run on an identical world.
  const dry = bedPlacingBot();
  {
    using _dryInstalled = dry.h.clock.install();
    await dry.h.clock.settle(executeSleep(dry.h.bot, walkToPlacedBed(dry.h, dry.state), {}), 60_000);
  }
  const footprint = dry.state.placedAt!;
  const footprintFacing = dry.state.facing;

  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install();
  const owner = new AbortController();
  h.bot.look = async () => {
    owner.abort(new Error("hunger reflex")); // during the look: nothing was sent
    owner.signal.throwIfAborted();
  };
  const attempt = sleepAttempts(h, walkToPlacedBed(h, state));
  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  assert.equal(state.placements, 0);

  // The reflex sets a bed down in that very footprint (the world now shows one), and the resume goes to sleep.
  state.placedAt = footprint;
  setBed(h, "cyan_bed", footprint, { facing: footprintFacing });
  h.bot.look = async () => undefined;
  const result = await attempt(new AbortController().signal);

  assert.equal(state.placements, 0, "the free bed found is used; this request placed none");
  assert.equal(result.sleep?.placedBed, false, "the reflex's bed is not reported as the one this request put down");
});

test("the bed this request placed, in a chunk that is no longer loaded, fails naming the cell and places no second bed", async () => {
  const { h, state } = bedPlacingBot();
  using _installed = h.clock.install();
  const owner = new AbortController();
  const attempt = sleepAttempts(h, walkToPlacedBed(h, state, owner));
  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const placedAt = state.placedAt!;
  for (const cell of [placedAt, placedAt.plus(HEAD_OFFSETS[state.facing])]) h.world.setCell(cell, "void");

  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /BED_NOT_LOADED.*go back near it/su);
  assert.equal(state.placements, 1);
});

test("two sleep requests on two bots keep their own beds", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const requests = [bedPlacingBot(clock), bedPlacingBot(clock)];
  const owners = requests.map(() => new AbortController());
  const attempts = requests.map(({ h, state }, index) => sleepAttempts(h, walkToPlacedBed(h, state, owners[index])));
  await Promise.all(attempts.map((attempt, index) => assert.rejects(attempt(owners[index]!.signal), /hunger reflex/)));

  const results = await Promise.all(attempts.map((attempt) => attempt(new AbortController().signal)));

  assert.deepEqual(results.map((result) => result.status), ["succeeded", "succeeded"]);
  assert.deepEqual(requests.map(({ state }) => state.placements), [1, 1]);
  assert.deepEqual(results.map((result) => result.sleep?.placedBed), [true, true]);
});
