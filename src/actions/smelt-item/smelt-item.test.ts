import type { NavigationRuntime } from "../../navigation/index.js";
import type { Bot } from "mineflayer";
const navigation = {} as NavigationRuntime;
import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { ANSWERED_ATTEMPT_MS, answeredAttemptMs, furnaceWindow, observedFurnace } from "../../test-support/furnace.js";
import { watch } from "../../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { beginSmeltItem, createSmeltItemAction, parseSmeltItemRequest, smeltItem, type SmeltItemDependencies } from "./index.js";

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

test("a temporary furnace is refused by the smelt caller when no harvest tool is carried", async () => {
  const { bot, dependencies, adjust } = smeltingBot();
  adjust("furnace", 1);
  const request = parseSmeltItemRequest({ item_name: "raw_iron", count: 3, fuel_item_name: "coal", temporary_workstation: true });
  const result = await smeltItem(bot, navigation, request, {}, dependencies);
  assert.equal(result.status, "failed");
  assert.match(result.error, /WORKSTATION_NO_HARVEST_TOOL.*furnace/);
  assert.equal(result.smelt.furnace, null);
  assert.equal(result.smelt.inputInventoryAfter, 3);
});

const registry = minecraftData("1.21.4");

test("a non-smeltable input is refused before any insert and an output names its inputs", async () => {
  for (const itemName of ["stick", "iron_ingot"]) {
    const { bot, dependencies } = smeltingBot();
    let opened = false;
    const result = await smeltItem(bot, navigation, { itemName, count: 1, fuelItemName: "coal", x: 2, y: 64, z: 0 }, {}, {
      ...dependencies, openFurnace: async (...args) => { opened = true; return dependencies.openFurnace(...args); },
    });
    assert.notEqual(result.status, "succeeded");
    if (result.status === "succeeded") throw new Error("expected refusal");
    assert.match(result.error ?? "", /SMELT_NOT_SMELTABLE/);
    if (itemName === "iron_ingot") assert.match(result.error ?? "", /raw_iron/);
    assert.equal(opened, false);
  }
});

/** A mocked clock the test installs: the smelt's waits for the server (world age, wall bound) run on it. */
const mockedClock = () => createFakeClock({ mode: "mocked" });

/** `clock`: a mocked one the test installs, for a test whose waits run on it. */
function smeltingBot({ clock, ticksPerSecond = 20 }: { readonly clock?: FakeClock; readonly ticksPerSecond?: number } = {}) {
  const harness = createFakeBot({ clock, server: { ticksPerSecond }, version: "1.21.4", carried: { raw_iron: 3, coal: 1 }, cells: { "2,64,0": "furnace" } });
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
  const furnace = furnaceWindow(harness.bot, {
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
  });
  const { bot } = harness;
  bot.clickWindow = async (slot) => {
    if (slot !== 2 || !output) return;
    adjust(output.name, output.count);
    output = null;
  };
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    openFurnace: async () => { bot.currentWindow = furnace as never; return furnace as never; },
    now: () => performance.now(),
    pause: async () => undefined,
  };
  return { bot, dependencies, adjust, server: harness.server };
}

for (const stopped of [false, true]) {
  test(`an injected smelt output inventory deficit ${stopped ? "stays unconfirmed after 20 s of still world age" : "is confirmed at age +40 at 5 tps"}`, async () => {
    const clock = mockedClock();
    using _installed = clock.install();
    const { bot, dependencies, adjust, server } = smeltingBot({ clock, ticksPerSecond: 5 });
    let closed = false;
    const openFurnace = dependencies.openFurnace;
    const receiptDependencies: SmeltItemDependencies = {
      ...dependencies,
      openFurnace: async (actor, block) => {
        const furnace = await openFurnace(actor, block);
        const close = furnace.close;
        furnace.close = () => {
          void close();
          closed = true;
          // Stopgap: neither 16a nor B1 measured a post-close correction (furnace-take-corrected.md, 2026-11-15).
          adjust("iron_ingot", -3);
          const sentAt = bot.time.age;
          if (stopped) server.stop();
          else {
            const stop = server.onTimePacket(() => {
              if (bot.time.age - sentAt < 40) return;
              adjust("iron_ingot", 3);
              stop();
            });
          }
          return Promise.resolve();
        };
        return furnace;
      },
    };
    const pending = smeltItem(bot, navigation,
      { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 }, {}, receiptDependencies);
    const seen = watch(pending);
    const answerMs = stopped ? SERVER_CLOCK_STOPPED_MS : 8_000;
    await clock.advance(8_000);
    assert.equal(closed, true);
    await clock.advance(answerMs - 50);
    assert.equal(seen.over, false, "the output receipt must wait for the server answer or stopped-clock bound");
    const result = await clock.settle(pending, 50);

    assert.equal(result.smelt.produced, 3);
    assert.equal(result.status, stopped ? "partial" : "succeeded");
    assert.equal(carriedIngots(bot), stopped ? 0 : 3);
    if (result.status !== "succeeded") assert.match(result.error, /Player inventory did not confirm furnace output iron_ingot x3 after close/u);
  });
}


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
  ), answeredAttemptMs(2));

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
  ), answeredAttemptMs(2));

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
  ), answeredAttemptMs(1));

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
  // the take ends once the clock moved the world age 40 ticks past it, not on the wall bound.
  const result = await clock.settle(smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  ), answeredAttemptMs(2));

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
      ), answeredAttemptMs(1)),
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

    await assert.rejects(clock.settle(pending, answeredAttemptMs(1)), /clock test cancelled/);
  } finally {
    Date.now = clockDateNow;
  }
});

test("a click that throws on the output take keeps its error, closes the window, and sends no input or fuel click", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 2_000, stopAfter: 1 });
  const clicks: number[] = [];
  let closed = false;
  const close = fixture.furnace.close;
  fixture.furnace.close = () => { closed = true; close(); };
  fixture.bot.clickWindow = async (slot) => { clicks.push(slot); throw new Error("output click failed"); };
  const result = await clock.settle(smeltItem(fixture.bot, navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 }, {}, fixture.dependencies), answeredAttemptMs(0));
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /output click failed/);
  assert.equal(closed, true);
  assert.deepEqual(clicks, [2]);
  assert.equal(fixture.furnace.inputItem()?.count, 2);
});

test("an accepted take keeps its prediction and confirms the receipt after close without a correction", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 100 });
  const counts = new CarriedCounts(fixture.harness.inventory, fixture.bot.registry);
  counts.set(fixture.bot.registry.itemsByName.iron_ingot!.id, 2);
  const sentAtAge = fixture.bot.time.age;
  const pending = smeltItem(fixture.bot, navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 }, {}, fixture.dependencies);
  const seen = watch(pending);
  // At 20 tps, +40 world ticks arrive 1-2 s after a send; this fixture sends on a packet boundary.
  await clock.advance(950);
  assert.equal(seen.over, false);
  const result = await clock.settle(pending, 1_100);
  assert.equal(fixture.bot.time.age - sentAtAge, 40);
  assert.equal(result.status, "succeeded");
  assert.equal(result.smelt.outputItem, "iron_ingot");
  assert.equal(result.smelt.produced, 3);
  assert.equal(result.smelt.inputInventoryAfter, 0);
  assert.equal(result.smelt.fuelInventoryAfter, 0);
  assert.equal(carriedIngots(fixture.bot), 5);
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
      openFurnace: async () => furnaceWindow(bot, {
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
  // The output waits for its answer; the input is then refused for lack of room, so there is no returned-input wait.
  const result = await clock.settle(smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    {
      ...dependencies,
      openFurnace: async () => furnaceWindow(bot, {
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
  ), answeredAttemptMs(1));

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
  const result = await clock.settle(smeltItem(fixture.bot, navigation, BIG_SMELT, {}, dependencies), answeredAttemptMs(22));

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
    answeredAttemptMs(0),
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
    clock.settle(smeltItem(fixture.bot, navigation, BIG_SMELT, { signal: controller.signal }, dependencies), answeredAttemptMs(11)),
    /cancelled/,
  );
  const raw = fixture.bot.inventory.items().find((item) => item.name === "raw_iron")?.count ?? 0;
  assert(carriedIngots(fixture.bot) >= 29, `ingots ${carriedIngots(fixture.bot)}`);
  assert.equal(carriedIngots(fixture.bot) + raw, 64);
});

// The furnace window must be closed on every way out of an attempt before the cook is handed over: an open window
// blocks the hostile reflex's shield (`hostile-respond.ts:22`, `hostile-sense.ts:74` read `bot.currentWindow`).
const WINDOW_SMELT = { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 } as const;

type WindowFixture = ReturnType<typeof observedFurnace>;

/**
 * The fixture's furnace as Mineflayer hands a window out: opening it sets `bot.currentWindow`, and `close` clears it and
 * emits `close` on the window and `windowClose` on the bot (`inventory.js:377-382`, `:445-452`).
 */
function trackWindow(fixture: WindowFixture) {
  const { bot, furnace } = fixture;
  const tracking = { closes: 0 };
  furnace.close = () => {
    tracking.closes += 1;
    bot.currentWindow = null;
    bot.emit("windowClose", furnace as never);
    furnace.emit("close");
  };
  const openFurnace = fixture.dependencies.openFurnace;
  const dependencies: SmeltItemDependencies = {
    ...fixture.dependencies,
    openFurnace: async (actor, block) => {
      const window = await openFurnace(actor, block);
      bot.currentWindow = window as never;
      return window;
    },
  };
  return { tracking, dependencies };
}

/** A request a reflex splits: the first attempt is aborted mid-cook, so the second finds fuel already inserted. */
async function firstAttemptAborted(fixture: WindowFixture, clock: FakeClock) {
  const first = new AbortController();
  const second = new AbortController();
  const { tracking, dependencies } = trackWindow(fixture);
  let resumed = false;
  const resumable: SmeltItemDependencies = {
    ...dependencies,
    pause: async (milliseconds, signal) => {
      // The reflex takes the body at the second attempt's first wait, whichever wait that is.
      if (resumed) second.abort(new Error("reflex took the body"));
      await dependencies.pause(milliseconds, signal);
      if (fixture.now >= 15_000 && !resumed) first.abort(new Error("reflex took the body"));
    },
  };
  const run = beginSmeltItem(fixture.bot, navigation, WINDOW_SMELT, resumable, () => {});
  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  assert.equal(tracking.closes, 1, "the aborted cook closed its window");
  resumed = true;
  return { run, second, tracking };
}

test("an abort inside settleBurnReport closes the furnace window", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, reportsBurnTime: true });
  const { run, second, tracking } = await firstAttemptAborted(fixture, clock);
  // The reopened window has not said what is burning yet, so the attempt waits for the report.
  fixture.furnace.properties = (() => null) as never;

  await assert.rejects(clock.settle(run({ signal: second.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);

  assert.equal(tracking.closes, 2, "the second attempt's window was closed too");
  assert.equal(fixture.bot.currentWindow, null, "no window left: the hostile reflex can raise the shield");
});

test("a throw in the second supplies check closes the furnace window", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, reportsBurnTime: true });
  const { run, tracking } = await firstAttemptAborted(fixture, clock);
  // The burn report settles on the first read; the supplies check then reads the burn time again and the window breaks.
  const report = fixture.furnace.properties!;
  let reads = 0;
  fixture.furnace.properties = () => {
    reads += 1;
    if (reads > 1) throw new Error("window broke under the read");
    return report();
  };

  await assert.rejects(clock.settle(run({ signal: new AbortController().signal }), ANSWERED_ATTEMPT_MS), /window broke under the read/);

  assert.equal(reads, 2);
  assert.equal(tracking.closes, 2);
  assert.equal(fixture.bot.currentWindow, null, "no window left: the hostile reflex can raise the shield");
});

test("a throw while clearing the furnace closes the window and removes the property listener", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000 });
  const { tracking } = trackWindow(fixture);
  fixture.bot.openFurnace = async () => {
    fixture.bot.currentWindow = fixture.furnace as never;
    return fixture.furnace as never;
  };
  fixture.furnace.inputItem = () => {
    throw new Error("window broke under the read");
  };
  const run = createSmeltItemAction(fixture.bot, navigation).begin(WINDOW_SMELT, new AbortController().signal, () => {});

  await assert.rejects(clock.settle(run({ signal: new AbortController().signal }), ANSWERED_ATTEMPT_MS), /window broke under the read/);

  assert.equal(tracking.closes, 1);
  assert.equal(fixture.bot.currentWindow, null, "no window left: the hostile reflex can raise the shield");
  assert.equal(fixture.bot._client.listenerCount("craft_progress_bar"), 0);
});
