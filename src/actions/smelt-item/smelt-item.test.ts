import type { NavigationRuntime } from "../../navigation/index.js";
import type { Bot } from "mineflayer";
const navigation = {} as NavigationRuntime;
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { ANSWERED_ATTEMPT_MS, observedFurnace } from "../../test-support/furnace.js";
import { createSmeltItemAction, parseSmeltItemRequest, smeltItem, type SmeltItemDependencies } from "./index.js";

test("a named furnace and a temporary one are exclusive, and a temporary one must be carried", async () => {
  assert.deepEqual(
    parseSmeltItemRequest({
      item_name: " Minecraft:Raw Iron ",
      count: 3,
      fuel_item_name: "Coal",
      x: 4,
      y: 64,
      z: -2,
    }),
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 4, y: 64, z: -2 },
  );

  const input = { item_name: "raw_iron", count: 3, fuel_item_name: "coal", temporary_workstation: true };
  const request = parseSmeltItemRequest(input);
  assert.deepEqual(request, { itemName: "raw_iron", count: 3, fuelItemName: "coal", temporaryWorkstation: true });
  assert.throws(() => parseSmeltItemRequest({ ...input, x: 1, y: 64, z: 0 }));
  assert.throws(() => parseSmeltItemRequest({ ...input, temporary_workstation: false }));
  assert.throws(() => parseSmeltItemRequest({ ...input, temporary_workstation: false, x: 1 }));
  const { bot, dependencies } = smeltingBot();
  const result = await smeltItem(bot, navigation, request, {}, dependencies);
  assert.equal(result.status, "failed");
  assert.match(result.error, /WORKSTATION_NOT_CARRIED.*furnace/);
  assert.equal(result.smelt.furnace, null);
  assert.equal(result.smelt.inputInventoryAfter, 3);
});

const registry = minecraftData("1.21.4");

/** A mocked clock the test installs: the smelt's waits for the server (world age, wall bound) run on it. */
const mockedClock = () => createFakeClock({ mode: "mocked" });

/** `clock`: a mocked one the test installs, for a test whose waits run on it. */
function smeltingBot({ clock }: { readonly clock?: FakeClock } = {}) {
  const harness = createFakeBot({ clock, version: "1.21.4", carried: { raw_iron: 3, coal: 1 }, cells: { "2,64,0": "furnace" } });
  const counts = new CarriedCounts(harness.inventory, harness.bot.registry);
  /** A furnace transfer's change to what the bot carries, as the server's slot updates make it. */
  const adjust = (name: string, delta: number) => {
    const type = registry.itemsByName[name]!.id;
    counts.set(type, (counts.get(type) ?? 0) + delta);
  };
  let input: { name: string; count: number } | null = null;
  let fuel: { name: string; count: number } | null = null;
  let output: { name: string; count: number; type: number; stackSize: number; slot: number } | null = null;
  const take = (slot: { name: string; count: number } | null) => {
    if (slot) adjust(slot.name, slot.count);
    return slot;
  };
  const furnace = {
    inputItem: () => input,
    fuelItem: () => fuel,
    outputItem: () => output,
    putInput: async (_type: number, _metadata: null, count: number) => {
      adjust("raw_iron", -count);
      input = { name: "raw_iron", count };
    },
    putFuel: async (_type: number, _metadata: null, count: number) => {
      adjust("coal", -count);
      fuel = null;
      input = null;
      output = { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 };
    },
    takeInput: async () => take(input),
    takeFuel: async () => take(fuel),
    takeOutput: async () => take(output),
    close: () => undefined,
  };
  const { bot } = harness;
  bot.clickWindow = async (slot) => {
    if (slot !== 2 || !output) return;
    adjust(output.name, output.count);
    output = null;
  };
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    openFurnace: async () => furnace as never,
    now: Date.now,
    pause: async () => undefined,
  };
  return { bot, dependencies, adjust };
}

test("smelts the requested input and reports output actually taken into inventory", async () => {
  const { bot, dependencies } = smeltingBot();
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.smelt.outputItem, "iron_ingot");
  assert.equal(result.smelt.produced, 3);
  assert.equal(result.smelt.inputInventoryAfter, 0);
  assert.equal(result.smelt.fuelInventoryAfter, 0);
});

test("snapshots the output stack before a shift-click merges it into carried ingots", async () => {
  // The combined workshop cooked both batches, but reported 0/9 on the second:
  // prismarine-windows.fillSlotWithItem mutates the source count to zero.
  const { bot, dependencies, adjust } = smeltingBot();
  adjust("iron_ingot", 2);
  const openFurnace = dependencies.openFurnace;
  const click = bot.clickWindow;
  const result = await smeltItem(bot, navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 }, {}, {
      ...dependencies,
      openFurnace: async (actor, block) => {
        const furnace = await openFurnace(actor, block);
        bot.clickWindow = async (...args) => {
          const source = furnace.outputItem()!;
          await click(...args);
          source.count = 0;
        };
        return Object.assign(new EventEmitter(), furnace);
      },
    });
  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 3);
  assert.equal(bot.inventory.items().find((item) => item.name === "iron_ingot")?.count, 5);
});

test("does not insert anything into a furnace that already owns contents", async () => {
  let readProgress: (() => import("../../session/request.js").RequestEvidence) | undefined;
  const { bot, dependencies } = smeltingBot();
  const occupiedDependencies: SmeltItemDependencies = {
    ...dependencies,
    openFurnace: async () =>
      ({
        inputItem: () => ({ name: "sand", count: 1 }),
        fuelItem: () => null,
        outputItem: () => null,
        takeInput: async () => ({ name: "sand", count: 1 }),
        takeFuel: async () => null,
        takeOutput: async () => null,
        close: () => undefined,
      }) as never,
  };

  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    { observeProgress: (read) => { readProgress = read; } },
    occupiedDependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /FURNACE_NOT_EMPTY/);
  assert.equal(result.smelt.inputInventoryAfter, 3);
  assert.equal(readProgress?.().completion.observed, false);
});

test("keeps waiting while native cook progress advances beyond the old wall-clock deadline", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 20_000 });
  const result = await clock.settle(smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  ), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded");
  assert.equal(result.smelt.produced, 3);
  assert.equal(result.smelt.rawRecovered, 0);
  assert(fixture.now > 3 * 10_000 + 5_000);
});

test("reports a true cook stall and the raw input recovered from the furnace", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 2_000, stopAfter: 1 });
  const result = await clock.settle(smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  ), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.match(result.error, /SMELT_STALLED.*retrieved 1\/3 cooked, 2 raw, and 0 fuel/);
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 2);
  assert.equal(result.smelt.inputInventoryAfter, 2);
});

test("distinguishes exhausted fuel from a cook stall", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 2_000, starved: true });
  const result = await clock.settle(smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  ), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "failed");
  assert.match(result.error, /SMELT_FUEL_STARVED.*0\/3 cooked, 3 raw, and 0 fuel/);
  assert.equal(result.smelt.rawRecovered, 3);
  assert.equal(fixture.now, 1_000);
});

test("reports only the raw count removed from a partially recovered furnace slot", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 2_000, stopAfter: 1, recoverInputCount: 1 });
  // "The server answered": the window showed the slot as the server held it, so no correction comes, and the wait after
  // the take ends once the clock moved the world age 40 ticks past it (within `ANSWERED_ATTEMPT_MS`), not on the wall bound.
  const result = await clock.settle(smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  ), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 1);
  assert.match(result.error, /retrieved 1\/3 cooked, 1 raw, and 0 fuel/);
});

for (const stop of ["cancelled", "disconnected"] as const) {
  test(`bounds ${stop} settlement and gives back observed furnace contents`, async () => {
    const clock = mockedClock();
    using _installed = clock.install();
    const fixture = observedFurnace({ clock, cookMs: 2_000 });
    const controller = new AbortController();
    const originalPause = fixture.dependencies.pause;
    const dependencies: SmeltItemDependencies = {
      ...fixture.dependencies,
      pause: async (milliseconds, signal) => {
        await originalPause(milliseconds, signal);
        controller.abort(new Error(stop));
      },
    };
    await assert.rejects(
      clock.settle(smeltItem(
        fixture.bot,
        navigation,
        { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
        { signal: controller.signal },
        dependencies,
      ), ANSWERED_ATTEMPT_MS),
      new RegExp(stop),
    );
    assert.equal(fixture.bot.inventory.items().find((item) => item.name === "raw_iron")?.count, 3);
  });
}

test("the production action clock is monotonic when the wall clock jumps", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // The installed clock's `Date.now` jumps a million ms a read; `performance.now` stays the clock's.
  const clockDateNow = Date.now;
  let wallNow = clockDateNow();
  Date.now = () => (wallNow += 1_000_000);
  try {
    const fixture = observedFurnace({ clock, cookMs: 20_000, stopAfter: 0 });
    fixture.bot.openFurnace = async () => fixture.furnace as never;
    const controller = new AbortController();
    const lifetime = new AbortController();
    const pending = createSmeltItemAction(fixture.bot, navigation).begin(
      { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
      lifetime.signal,
      () => {},
    )({ signal: controller.signal });
    await clock.advance(20);
    controller.abort(new Error("clock test cancelled"));

    await assert.rejects(clock.settle(pending, ANSWERED_ATTEMPT_MS), /clock test cancelled/);
  } finally {
    Date.now = clockDateNow;
  }
});

test("a nonsettling slot take closes the window without starting later recovery mutations", async () => {
  // The take's 2 s bound is a wall bound: it runs on the installed clock, as `performance.now` does.
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, dependencies } = smeltingBot({ clock });
  let closed = false;
  let inputTakes = 0;
  let fuelTakes = 0;
  let loaded = false;
  let takingOutput = false;
  let outputClick: readonly [number, number, number] | null = null;
  const unresolved = new Promise<never>(() => undefined);
  bot.clickWindow = (slot, button, mode) => {
    outputClick = [slot, button, mode];
    takingOutput = true;
    return unresolved;
  };
  const stuckDependencies: SmeltItemDependencies = {
    ...dependencies,
    openFurnace: async () => ({
      progress: 0,
      fuel: 0,
      inputItem: () => takingOutput ? { name: "raw_iron", count: 3 } : null,
      fuelItem: () => takingOutput ? { name: "coal", count: 1 } : null,
      outputItem: () => loaded ? { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
      putInput: async () => undefined,
      putFuel: async () => { loaded = true; },
      takeOutput: () => unresolved,
      takeInput: async () => { inputTakes += 1; return null; },
      takeFuel: async () => { fuelTakes += 1; return null; },
      close: () => { closed = true; },
    }) as never,
  };
  const started = performance.now();
  const result = await clock.settle(smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    stuckDependencies,
  ), ANSWERED_ATTEMPT_MS);
  const elapsed = performance.now() - started;

  assert.equal(result.status, "failed");
  assert.match(result.error, /takeOutput did not settle within 2000 ms/);
  assert(elapsed >= 1_900 && elapsed < 3_000, `bounded settlement took ${elapsed} ms`);
  assert.equal(closed, true);
  assert.equal(inputTakes, 0);
  assert.equal(fuelTakes, 0);
  assert.deepEqual(outputClick, [2, 0, 1], "furnace output uses one shift-click, never the result-slot cursor path");
  await clock.advance(20);
  assert.equal(inputTakes, 0, "the timed-out operation cannot advance to a later slot after close");
  assert.equal(fuelTakes, 0, "the timed-out operation cannot advance to a later slot after close");
});

test("refuses furnace output recovery before clicking when inventory has no room", async () => {
  const { bot, dependencies } = smeltingBot();
  let loaded = false;
  let clicks = 0;
  bot.inventory.emptySlotCount = () => 0;
  bot.clickWindow = async () => { clicks += 1; };
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    {
      ...dependencies,
      openFurnace: async () => ({
        progress: 0,
        fuel: 0,
        inputItem: () => null,
        fuelItem: () => null,
        outputItem: () => loaded ? { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
        putInput: async () => undefined,
        putFuel: async () => { loaded = true; },
        takeOutput: async () => null,
        takeInput: async () => null,
        takeFuel: async () => null,
        close: () => undefined,
      }) as never,
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /No inventory room for furnace output iron_ingot x3/);
  assert.equal(clicks, 0);
});

test("does not start a multi-click raw recovery after output consumes the last inventory slot", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const { bot, dependencies, adjust } = smeltingBot({ clock });
  let loaded = false;
  let outputRemoved = false;
  let freeSlots = 1;
  let inputTakes = 0;
  let fuelTakes = 0;
  bot.inventory.emptySlotCount = () => freeSlots;
  bot.clickWindow = async () => {
    freeSlots = 0;
    outputRemoved = true;
    adjust("iron_ingot", 1);
  };
  // Nothing here waits for the server's answer: the output's click lands at once, and the input is refused for lack of
  // room before any take, so the recovery's error leaves no returned input to wait for (`countAttemptIngots`).
  const result = await clock.settle(smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    {
      ...dependencies,
      openFurnace: async () => ({
        progress: 0.5,
        fuel: 0.5,
        inputItem: () => loaded ? { name: "raw_iron", count: 2, type: registry.itemsByName.raw_iron!.id, stackSize: 64 } : null,
        fuelItem: () => loaded ? { name: "coal", count: 1, type: registry.itemsByName.coal!.id, stackSize: 64 } : null,
        outputItem: () => loaded && !outputRemoved ? { name: "iron_ingot", count: 1, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
        // The loaded ore leaves the inventory, as the server's slot updates take it: no carried raw_iron stack is left
        // for the input to merge into, so the slot the output took was its only room.
        putInput: async (_type: number, _metadata: null, count: number) => adjust("raw_iron", -count),
        putFuel: async () => { loaded = true; throw new Error("fixture stops after loading"); },
        takeOutput: async () => null,
        takeInput: async () => { inputTakes += 1; return null; },
        takeFuel: async () => { fuelTakes += 1; return null; },
        close: () => undefined,
      }) as never,
    },
  ), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 0);
  assert.match(result.error, /No inventory room for furnace input raw_iron x2/);
  assert.equal(inputTakes, 0);
  assert.equal(fuelTakes, 0);
});

const BIG_SMELT = { itemName: "raw_iron", count: 64, fuelItemName: "coal", x: 2, y: 64, z: 0 } as const;

function carriedIngots(bot: Bot): number {
  return bot.inventory.items().find((item) => item.name === "iron_ingot")?.count ?? 0;
}

test("a 64-ingot smelt puts ingots in the inventory as they cook and counts each exactly once", async () => {
  // Run 15: ingots were only taken at the end, so the brain's 5-minute no-gain limit saw nothing for 640 s.
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 64, coal: 8 });
  const risesAt: number[] = [];
  let seen = 0;
  const pause = fixture.dependencies.pause;
  const dependencies: SmeltItemDependencies = {
    ...fixture.dependencies,
    pause: async (milliseconds, signal) => {
      await pause(milliseconds, signal);
      const carried = carriedIngots(fixture.bot);
      if (carried > seen) risesAt.push(fixture.now);
      seen = carried;
    },
  };
  const result = await clock.settle(smeltItem(fixture.bot, navigation, BIG_SMELT, {}, dependencies), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 64);
  assert.equal(carriedIngots(fixture.bot), 64);
  assert.equal(result.smelt.inputInventoryAfter, 0);
  const gaps = risesAt.map((at, index) => at - (risesAt[index - 1] ?? 0));
  assert(risesAt.length >= 8, `ingots rose ${risesAt.length} times`);
  assert(Math.max(...gaps) <= 80_000, `longest wait between rises ${Math.max(...gaps)} ms`);
});

test("a full inventory mid-cook leaves the output in the furnace and reports it without throwing", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 16, coal: 2, full: true });
  // Nothing here waits for the server's answer: with no inventory room nothing is taken, and the recovery's error leaves
  // no returned input to wait for (`countAttemptIngots`).
  const result = await clock.settle(
    smeltItem(fixture.bot, navigation, { ...BIG_SMELT, count: 16 }, {}, fixture.dependencies),
    ANSWERED_ATTEMPT_MS,
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /No inventory room for furnace output iron_ingot/);
  assert.equal(result.smelt.produced, 0);
  assert.equal(carriedIngots(fixture.bot), 0);
});

test("a cancel mid-cook keeps the ingots already taken and gives back the rest", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 64, coal: 8 });
  const controller = new AbortController();
  const pause = fixture.dependencies.pause;
  const dependencies: SmeltItemDependencies = {
    ...fixture.dependencies,
    pause: async (milliseconds, signal) => {
      await pause(milliseconds, signal);
      if (fixture.now >= 300_000) controller.abort(new Error("cancelled"));
    },
  };
  await assert.rejects(
    clock.settle(smeltItem(fixture.bot, navigation, BIG_SMELT, { signal: controller.signal }, dependencies), ANSWERED_ATTEMPT_MS),
    /cancelled/,
  );
  const raw = fixture.bot.inventory.items().find((item) => item.name === "raw_iron")?.count ?? 0;
  assert(carriedIngots(fixture.bot) >= 29, `ingots ${carriedIngots(fixture.bot)}`);
  assert.equal(carriedIngots(fixture.bot) + raw, 64);
});
