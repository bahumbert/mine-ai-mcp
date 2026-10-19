import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import { botFixture, registry } from "../../test-support/bot.js";
import { createRequire } from "node:module";
import { parseSleepRequest, sleepOutcomes } from "./contract.js";
import { beginSleep, executeSleep, formatSleepResult } from "./sleep.js";

const loadChunk = createRequire(import.meta.url)("prismarine-chunk") as typeof import("prismarine-chunk").default;

function mockBed(name: string, position: Vec3, occupied = false) {
  return {
    name,
    boundingBox: "block",
    position,
    getProperties: () => ({ occupied }),
  };
}

function mockBot(overrides: Record<string, any> = {}) {
  const Chunk = loadChunk("1.21.4");
  const columns = new Map<string, { chunkX: number; chunkZ: number; column: InstanceType<typeof Chunk> }>();
  for (const position of (overrides.beds ?? []) as Vec3[]) {
    const chunkX = Math.floor(position.x / 16);
    const chunkZ = Math.floor(position.z / 16);
    const key = `${chunkX},${chunkZ}`;
    const loaded = columns.get(key) ?? { chunkX, chunkZ, column: new Chunk({ x: chunkX, z: chunkZ }) };
    loaded.column.setBlockStateId(
      position.offset(-chunkX * 16, 0, -chunkZ * 16),
      registry.blocksByName.white_bed!.minStateId,
    );
    columns.set(key, loaded);
  }
  const bot: any = botFixture(
    { username: "sleeper", position: { x: 0, y: 64, z: 0 }, time: { timeOfDay: 14000 } },
    {
      world: { getColumns: () => [...columns.values()] },
      isSleeping: false,
      activateBlock: async () => {},
      sleep: async () => {
        bot.isSleeping = true;
        setTimeout(() => {
          bot.isSleeping = false;
          bot.time.timeOfDay = 0; // Morning
          bot.emit("wake");
        }, 20);
      },
      ...overrides,
    },
  );
  return bot;
}

const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;

test("finds the bed in the diagonal section missed during the run 12 underground return", async () => {
  const bedPos = new Vec3(80, 66, 135);
  const bot = mockBot({
    entity: { position: new Vec3(71.51, 38, 144.49) },
    beds: [bedPos],
    blockAt: (position: Vec3) => (position.equals(bedPos) ? mockBed("white_bed", bedPos) : null),
  });
  const navigation = {
    ...fakeNavigation,
    navigate: async () => {
      bot.entity.position = bedPos.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as NavigationRuntime;

  const result = await executeSleep(bot, navigation, {});
  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.sleep?.bedPosition, { x: 80, y: 66, z: 135 });
});

test("parses sleep requests with zero arguments and rejects unknown keys", () => {
  assert.deepEqual(parseSleepRequest({}), {});
  assert.deepEqual(parseSleepRequest(undefined), {});
  assert.throws(() => parseSleepRequest({ unexpected: 123 }));
});

test("refuses to sleep in the Nether or the End to avoid explosions", async () => {
  const bot = mockBot({ game: { dimension: "the_nether" } });
  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.dimensionUnsafe);
  }
});

test("reports immediately if bot is already sleeping", async () => {
  const bot = mockBot({ isSleeping: true });
  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.asleep, true);
  assert.equal(result.sleep?.observation, sleepOutcomes.alreadySleeping);
});

test("refuses if no bed is nearby and none is in inventory, advising wool and wood", async () => {
  const bot = mockBot({
    beds: [],
    inventory: { items: () => [] },
  });
  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.noBedFound);
  }
});

test("skips occupied beds and chooses an unoccupied one", async () => {
  const occupiedBedPos = new Vec3(2, 64, 0);
  const freeBedPos = new Vec3(3, 64, 0);
  const bot = mockBot({
    time: { timeOfDay: 15000 },
    beds: [occupiedBedPos, freeBedPos],
    blockAt: (pos: Vec3) => {
      if (pos.equals(occupiedBedPos)) {
        return mockBed("red_bed", occupiedBedPos, true);
      }
      if (pos.equals(freeBedPos)) {
        return mockBed("blue_bed", freeBedPos);
      }
      return { name: "air", boundingBox: "empty", position: pos };
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.sleep?.bedPosition, { x: 3, y: 64, z: 0 });
  assert.equal(result.sleep?.morning, true);
});

test("sets respawn point during daytime when night sleep is unavailable", async () => {
  const bedPos = new Vec3(2, 64, 0);
  let activated = false;
  const bot = mockBot({
    time: { timeOfDay: 6000 }, // Midday
    beds: [bedPos],
    blockAt: (pos: Vec3) => {
      if (pos.equals(bedPos)) return mockBed("white_bed", bedPos);
      return { name: "air", boundingBox: "empty", position: pos };
    },
    activateBlock: async () => {
      activated = true;
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "succeeded");
  assert.equal(activated, true);
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
  const bedPos = new Vec3(2, 64, 0);
  const bot = mockBot({
    time: { timeOfDay: 6000 },
    inventory: { items: () => [{ name: "cyan_bed", count: 1 }] },
    beds: [bedPos],
    blockAt: (pos: Vec3) =>
      pos.equals(bedPos) ? mockBed("white_bed", bedPos) : { name: "air", boundingBox: "empty", position: pos },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.warning, undefined);
  assert.doesNotMatch(formatSleepResult(result), /Bed reminder/);
});

test("does not claim a daytime respawn point when activation is rejected", async () => {
  const bedPos = new Vec3(2, 64, 0);
  const bot = mockBot({
    time: { timeOfDay: 6000 },
    beds: [bedPos],
    blockAt: (pos: Vec3) =>
      pos.equals(bedPos) ? mockBed("white_bed", bedPos) : { name: "air", boundingBox: "empty", position: pos },
    activateBlock: async () => {
      throw new Error("server refused interaction");
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "failed");
  assert.equal(result.sleep?.respawnSet, false);
  if (result.status === "failed") {
    assert.equal(result.error, sleepOutcomes.respawnRejected("server refused interaction"));
  }
});

test("sleeps through the night and wakes up in the morning", async () => {
  const bedPos = new Vec3(2, 64, 0);
  const metadataKeys = ["pose", "sleeping_pos"];
  const bot = mockBot({
    time: { timeOfDay: 15000 }, // Nighttime
    registry: { ...minecraftData("1.21.4"), entitiesByName: { player: { metadataKeys } } },
    players: {
      sleeper: { entity: { metadata: [] } },
      Alice: { entity: { metadata: [2, null] } },
      Bob: { entity: { metadata: [0, null] } },
      Carol: { entity: null },
    },
    beds: [bedPos],
    blockAt: (pos: Vec3) => {
      if (pos.equals(bedPos)) return mockBed("red_bed", bedPos);
      return { name: "air", boundingBox: "empty", position: pos };
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

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
  const bedPos = new Vec3(2, 64, 0);
  const controller = new AbortController();
  const bot = mockBot({
    time: { timeOfDay: 15000 },
    beds: [bedPos],
    blockAt: (pos: Vec3) =>
      pos.equals(bedPos) ? mockBed("red_bed", bedPos) : { name: "air", boundingBox: "empty", position: pos },
    sleep: async () => {
      bot.isSleeping = true;
      setTimeout(() => {
        bot.isSleeping = false;
        bot.emit("wake");
      }, 5);
    },
  });

  let settled = false;
  const execution = executeSleep(bot, fakeNavigation, {}, controller.signal).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(settled, false);
  controller.abort();
  await assert.rejects(execution, { name: "AbortError" });
});

test("reports an observed nearby hostile instead of Mineflayer's generic sleep timeout", async () => {
  const bedPos = new Vec3(2, 64, 0);
  let sleepCalled = false;
  const bot = mockBot({
    beds: [bedPos],
    blockAt: (pos: Vec3) =>
      pos.equals(bedPos) ? mockBed("white_bed", bedPos) : { name: "air", boundingBox: "empty", position: pos },
    entities: {
      17: {
        type: "hostile",
        name: "zombie",
        position: new Vec3(4.5, 64, 1),
      },
    },
    sleep: async () => {
      sleepCalled = true;
      throw new Error("bot is not sleeping");
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "failed");
  assert.equal(sleepCalled, false);
  if (result.status === "failed") {
    assert.match(result.error, /^\[BED_HOSTILES_NEARBY\]/);
    assert.match(result.error, /zombie \(2\.69 blocks\)/);
    assert.equal(result.sleep?.nearbyHostiles?.[0]?.name, "zombie");
  }
  assert.match(formatSleepResult(result), /Nearby hostile mobs/);
  assert.match(formatSleepResult(result), /`4, 64, 1`/);
});

test("places a carried bed and sleeps in it when no bed is around", async () => {
  let placedPos: Vec3 | null = null;
  let bedPlaced = false;
  const bot = mockBot({
    time: { timeOfDay: 15000 },
    beds: [],
    inventory: {
      items: () => (bedPlaced ? [] : [{ name: "cyan_bed", count: 1 }]),
    },
    blockAt: (pos: Vec3) => {
      const offset = placedPos ? pos.minus(placedPos) : null;
      if (offset && offset.y === 0 && Math.abs(offset.x) + Math.abs(offset.z) <= 1) {
        return { name: "cyan_bed", boundingBox: "block", position: pos };
      }
      if (pos.y === 63) {
        return { name: "stone", boundingBox: "block", position: pos };
      }
      return { name: "air", boundingBox: "empty", position: pos };
    },
    _placeBlockWithOptions: async (support: any) => {
      placedPos = support.position.offset(0, 1, 0);
      bedPlaced = true;
    },
  });

  const result = await executeSleep(bot, fakeNavigation, {});

  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.placedBed, true);
  assert.equal(result.sleep?.morning, true);
  assert.match(result.sleep?.warning ?? "", /No bed remains in inventory/);
  assert.match(result.sleep?.warning ?? "", /cyan_bed/);
  assert.match(result.sleep?.warning ?? "", /collect_block/);
});

/** A bot carrying one bed that places it on the stone at y 63; `placements` counts how many beds were put down. */
function bedPlacingBot() {
  const state = { placedAt: null as Vec3 | null, placements: 0, taken: false, occupied: false };
  // The bot ends up eight blocks from the bed it places (placement walked it off), so every sleep has a route to take.
  const bot = mockBot({
    time: { timeOfDay: 15000 },
    beds: [],
    inventory: Object.assign(new EventEmitter(), {
      slots: {},
      items: () => (state.placements > 0 ? [] : [{ name: "cyan_bed", count: 1 }]),
    }),
    blockAt: (pos: Vec3) => {
      const offset = state.placedAt ? pos.minus(state.placedAt) : null;
      if (!state.taken && offset && offset.y === 0 && Math.abs(offset.x) + Math.abs(offset.z) <= 1) {
        return { name: "cyan_bed", boundingBox: "block", position: pos, getProperties: () => ({ occupied: state.occupied }) };
      }
      if (pos.y === 63) return { name: "stone", boundingBox: "block", position: pos };
      return { name: "air", boundingBox: "empty", position: pos };
    },
    _placeBlockWithOptions: async (support: any) => {
      state.placedAt = support.position.offset(0, 1, 0);
      state.placements += 1;
      bot.entity.position = state.placedAt!.offset(8, 0, 0);
    },
  });
  return { bot, state };
}

/** A navigation that walks to the placed bed; given an owner, its first route is the one a reflex aborts. */
function walkToPlacedBed(bot: any, state: { placedAt: Vec3 | null }, owner?: AbortController): NavigationRuntime {
  let routes = 0;
  return {
    navigate: async () => {
      routes += 1;
      if (owner && routes === 1) { owner.abort(new Error("hunger reflex")); throw owner.signal.reason; }
      bot.entity.position = state.placedAt!.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
}

/** Makes the chunk the bed was placed in loaded, as the server's column is once the bed exists. */
function loadBedColumn(bot: any, bedAt: Vec3): void {
  const Chunk = loadChunk("1.21.4");
  const chunkX = Math.floor(bedAt.x / 16), chunkZ = Math.floor(bedAt.z / 16);
  const column = new Chunk({ x: chunkX, z: chunkZ });
  column.setBlockStateId(bedAt.offset(-chunkX * 16, 0, -chunkZ * 16), registry.blocksByName.cyan_bed!.minStateId);
  bot.world.getColumns = () => [{ chunkX, chunkZ, column }];
}

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function sleepAttempts(bot: any, navigation: NavigationRuntime) {
  const run = beginSleep(bot, navigation, {}, () => {});
  return (signal?: AbortSignal) => run({ signal });
}

test("a sleep cut off on the way to the bed it placed sleeps in that bed next time, without placing another", async () => {
  const { bot, state } = bedPlacingBot();
  const owner = new AbortController();
  const navigation = walkToPlacedBed(bot, state, owner);
  const attempt = sleepAttempts(bot, navigation);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(state.placements, 1);
  assert.equal(result.sleep?.placedBed, true);
  assert.equal(result.sleep?.morning, true);
});

test("a bed placed just before the abort is found again by the next attempt, not replaced from an empty inventory", async () => {
  const { bot, state } = bedPlacingBot();
  const owner = new AbortController();
  const place = bot._placeBlockWithOptions;
  let placeCalls = 0;
  bot._placeBlockWithOptions = async (...args: unknown[]) => {
    placeCalls += 1;
    await place(...args);
    loadBedColumn(bot, state.placedAt!);
    owner.abort(new Error("fall reflex"));
    throw owner.signal.reason;
  };
  const attempt = sleepAttempts(bot, walkToPlacedBed(bot, state));

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(placeCalls, 1);
  assert.equal(result.status, "succeeded");
  assert.equal(result.sleep?.placedBed, true);
});

test("a bed that was taken between attempts is reported missing, and no second bed is placed", async () => {
  const { bot, state } = bedPlacingBot();
  const owner = new AbortController();
  const navigation = walkToPlacedBed(bot, state, owner);
  const attempt = sleepAttempts(bot, navigation);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  state.taken = true;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.equal(state.placements, 1);
  if (result.status === "failed") assert.equal(result.error, sleepOutcomes.noBedFound);
});

test("a second call after a sleep that finished returns its success without sleeping again", async () => {
  const bedPos = new Vec3(2, 64, 0);
  let sleeps = 0;
  const bot = mockBot({
    time: { timeOfDay: 15000 },
    beds: [bedPos],
    blockAt: (pos: Vec3) =>
      pos.equals(bedPos) ? mockBed("red_bed", bedPos) : { name: "air", boundingBox: "empty", position: pos },
  });
  const sleep = bot.sleep;
  bot.sleep = async (...args: unknown[]) => { sleeps += 1; await sleep(...args); };
  const attempt = sleepAttempts(bot, fakeNavigation);

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.deepEqual(second, first);
  assert.equal(sleeps, 1);
});

test("a bed another player now occupies is not ours: the free bed found instead is not reported as placed", async () => {
  const { bot, state } = bedPlacingBot();
  const owner = new AbortController();
  let walksTo: Vec3 | null = null; // where a route ends; the first route is the one the reflex aborts
  let routes = 0;
  const navigation = {
    navigate: async () => {
      routes += 1;
      if (routes === 1) { owner.abort(new Error("hunger reflex")); throw owner.signal.reason; }
      bot.entity.position = walksTo!.offset(-1, 0, 0);
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const attempt = sleepAttempts(bot, navigation);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  state.occupied = true; // our bed is taken by someone else; another free bed stands nearby
  const otherBed = state.placedAt!.offset(4, 0, 0);
  const blockAt = bot.blockAt;
  bot.blockAt = (pos: Vec3) => (pos.equals(otherBed) ? mockBed("cyan_bed", otherBed) : blockAt(pos));
  loadBedColumn(bot, otherBed);
  walksTo = otherBed;
  const result = await attempt(new AbortController().signal);

  assert.equal(state.placements, 1);
  assert.deepEqual(result.sleep?.bedPosition, { x: otherBed.x, y: otherBed.y, z: otherBed.z });
  assert.equal(result.sleep?.placedBed, false, "the bed slept in is not the one this request put down");
});
