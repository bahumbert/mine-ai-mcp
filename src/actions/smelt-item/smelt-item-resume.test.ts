// A smelt request a reflex splits into attempts: the second smelts only what is left, with no effect doubled.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { RequestEvidence } from "../../session/request.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeClock } from "../../test-support/fake-bot/index.js";
import { ANSWERED_ATTEMPT_MS, observedFurnace } from "../../test-support/furnace.js";
import type { WorldBlock } from "../../world/placement.js";
import type { WorkstationOperations } from "../temporary-workstation.js";
import { beginSmeltItem, type SmeltItemDependencies } from "./index.js";

const navigation = {} as NavigationRuntime;
/** Sticks burn 0.5 item each, so fuel for 8 and fuel for 5 differ (16 and 10) where coal's 8 would hide a doubling. */
const SMELT_8 = { itemName: "raw_iron", count: 8, fuelItemName: "stick", x: 2, y: 64, z: 0 } as const;

type Fixture = ReturnType<typeof observedFurnace>;

/** A mocked clock the test installs: the attempts' waits for the server (world age, wall bound) run on it. */
const mockedClock = () => createFakeClock({ mode: "mocked" });

function sticksFurnace(clock: FakeClock): Fixture {
  return observedFurnace({ clock, cookMs: 10_000, raw: 8, coal: 40, fuel: "stick" });
}

function carried(fixture: Fixture, name: string): number {
  return fixture.bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

/** How many furnaces the bot carries, read and set in the harness's inventory window. */
const carriedFurnaces = (fixture: Fixture) => carriedCountField(fixture.harness, "furnace");

/** Record what each attempt puts in the furnace. */
function recordLoads(fixture: Fixture) {
  const loads = { inputs: [] as number[], fuels: [] as number[] };
  const { putInput, putFuel } = fixture.furnace;
  fixture.furnace.putInput = async (type, metadata, count) => {
    loads.inputs.push(count);
    return putInput(type, metadata, count);
  };
  fixture.furnace.putFuel = async (type, metadata, count) => {
    loads.fuels.push(count);
    return putFuel(type, metadata, count);
  };
  return loads;
}

/** The fixture's clock, with a reflex that aborts the attempt's signal once the clock passes `at`. */
function reflexAt(fixture: Fixture, attempts: readonly { readonly at: number; readonly signal: AbortController }[]): SmeltItemDependencies {
  return {
    ...fixture.dependencies,
    pause: async (milliseconds, signal) => {
      await fixture.dependencies.pause(milliseconds, signal);
      for (const { at, signal: controller } of attempts) if (fixture.now >= at) controller.abort(new Error("reflex took the body"));
    },
  };
}

const freshAttempt = () => ({ signal: new AbortController().signal });

test("an attempt aborted mid-cook leaves the next to smelt only what is left, with fuel for that", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // Run 15: 24 smelts ended by a reflex. Resumed naively, the second attempt smelts 8 again: 11 ingots, fuel for 8.
  const fixture = sticksFurnace(clock);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.equal(carried(fixture, "raw_iron"), 0);
  assert.deepEqual(loads.inputs, [8, 5]);
  assert.deepEqual(loads.fuels, [16, 10]);
  assert.equal(result.smelt.requested, 8);
  assert.equal(result.smelt.inputInventoryBefore, 8);
  assert.equal(result.smelt.inputInventoryAfter, 0);
  assert.equal(result.smelt.fuelInserted, 26);
});

test("an abort between loading the input and the fuel gives the input back and the next attempt loads once", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const putInput = fixture.furnace.putInput;
  fixture.furnace.putInput = async (type, metadata, count) => {
    await putInput(type, metadata, count);
    first.abort(new Error("reflex took the body"));
  };
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, fixture.dependencies, () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  assert.equal(carried(fixture, "raw_iron"), 8, "the unburnt input came back");
  assert.equal(loads.fuels.length, 0);
  fixture.furnace.putInput = putInput;
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.deepEqual(loads.fuels, [16], "fuel for 8 was inserted once");
});

test("two reflexes in a row make three attempts and one total", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  const loads = recordLoads(fixture);
  const [first, second] = [new AbortController(), new AbortController()];
  const run = beginSmeltItem(
    fixture.bot,
    navigation,
    SMELT_8,
    reflexAt(fixture, [{ at: 35_000, signal: first }, { at: 70_000, signal: second }]),
    () => {},
  );

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex/);
  await assert.rejects(clock.settle(run({ signal: second.signal }), ANSWERED_ATTEMPT_MS), /reflex/);
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.equal(loads.inputs.length, 3);
  assert(loads.inputs[2]! < loads.inputs[1]! && loads.inputs[1]! < loads.inputs[0]!, `loads ${loads.inputs}`);
});

test("a request that already produced everything returns its success without opening the furnace again", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  let opens = 0;
  const openFurnace = fixture.dependencies.openFurnace;
  const dependencies: SmeltItemDependencies = {
    ...fixture.dependencies,
    openFurnace: async (bot, block) => {
      opens += 1;
      return openFurnace(bot, block);
    },
  };
  const loads = recordLoads(fixture);
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, dependencies, () => {});

  assert.equal((await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS)).status, "succeeded");
  const again = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(again.status, "succeeded");
  assert.equal(again.smelt.produced, 8);
  assert.equal(opens, 1);
  assert.deepEqual(loads.inputs, [8]);
});

test("a furnace broken between attempts ends the request partial with what was produced", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex/);
  fixture.bot.blockAt = (position) => ({ name: "air", position }) as WorldBlock;
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.match(result.error, /FURNACE_NOT_PRESENT/);
  assert.equal(result.smelt.produced, 3);
  assert.equal(carried(fixture, "raw_iron"), 5);
});

test("another bot's contents in the furnace between attempts are never touched: occupied", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex/);
  fixture.furnace.inputItem = () => ({ name: "sand", count: 4 }) as never;
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.match(result.error, /FURNACE_NOT_EMPTY/);
  assert.deepEqual(loads.inputs, [8], "nothing was loaded over a stranger's input");
});

test("input left in the furnace by an attempt cut off while loading is taken back and smelted", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // putInput's window closed under it (the reflex moved the bot): the slot holds the input, ownsSlots was never set.
  const fixture = sticksFurnace(clock);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const putInput = fixture.furnace.putInput;
  fixture.furnace.putInput = async (type, metadata, count) => {
    await putInput(type, metadata, count);
    first.abort(new Error("reflex took the body"));
    throw new Error("window closed");
  };
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, fixture.dependencies, () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  assert.equal(carried(fixture, "raw_iron"), 0, "the input is still in the furnace");
  fixture.furnace.putInput = putInput;
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.deepEqual(loads.fuels, [16]);
});

test("the progress read by the runner covers the whole request after an attempt is cut", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  let read: (() => RequestEvidence) | undefined;
  let observed = 0;
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), (reader) => {
    observed += 1;
    read = reader;
  });

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex/);

  assert.equal(observed, 1, "begin observes once, not once per attempt");
  assert.deepEqual(read?.().baseline, { input: 8, fuel: 40 });
  assert.equal((read?.().checkpoint as { produced: number }).produced, 3);
  assert.equal(read?.().completion.observed, false);
});

/** A temporary furnace that stands in the world between attempts, with the operations a bot has for it. */
function furnaceOperations(fixture: Fixture, calls: string[]): WorkstationOperations {
  const position = { x: 2, y: 64, z: 0 };
  const block: WorldBlock = fixture.bot.blockAt(new Vec3(2, 64, 0))!;
  const furnaces = carriedFurnaces(fixture);
  return {
    place: async (_name, _signal, onPlacementSent) => {
      calls.push("place");
      onPlacementSent?.([block.position]); // the real placement calls it right before the packet
      furnaces.count = 0;
      return { kind: "placed", block, position: block.position };
    },
    moveToOpenGround: async () => false,
    collect: async () => {
      calls.push("collect");
      fixture.harness.world.setCell(new Vec3(position.x, position.y, position.z), "air");
      furnaces.count = 1;
      return { status: "succeeded" };
    },
  };
}

test("a temporary furnace placed by an aborted attempt is reused, never placed twice, and recovered once", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = sticksFurnace(clock);
  carriedFurnaces(fixture).count = 1;
  const calls: string[] = [];
  const first = new AbortController();
  const run = beginSmeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 8, fuelItemName: "stick", temporaryWorkstation: true },
    reflexAt(fixture, [{ at: 35_000, signal: first }]),
    () => {},
    furnaceOperations(fixture, calls),
  );

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex/);
  assert.deepEqual(calls, ["place"], "an aborted attempt leaves the furnace standing");
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.deepEqual(calls, ["place", "collect"]);
  assert.equal(result.workstation?.recovered, true);
  assert.equal(carried(fixture, "furnace"), 1);
});

// busy-smelt-interrupted: a lit coal leaves the fuel slot and burns on in the furnace, so a resume that carries no more coal
// still has fuel. The request, not the carried count, decides whether the rest of the cook is fuelled.
const SMELT_3_COAL = { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 } as const;

test("a resumed attempt counts the fuel still burning in the furnace and loads no more", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 3, coal: 1, fuel: "coal", reportsBurnTime: true });
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_3_COAL, reflexAt(fixture, [{ at: 12_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  assert.equal(carried(fixture, "coal"), 0, "the one coal is burning in the furnace, none is carried");
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 3);
  assert.deepEqual(loads.fuels, [1], "the coal was loaded once");
  assert.equal(result.smelt.fuelInserted, 1);
});

test("a resumed attempt does not count on a flame shorter than one item, and says the fuel is missing", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // Eight items on one coal burn exactly 80 s; at 75 s seven are done and 5 s of flame is left for the eighth (10 s).
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 8, coal: 1, fuel: "coal", reportsBurnTime: true });
  const first = new AbortController();
  const request = { ...SMELT_3_COAL, count: 8 };
  const run = beginSmeltItem(fixture.bot, navigation, request, reflexAt(fixture, [{ at: 75_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.match(result.status === "partial" ? result.error : "", /SMELT_FUEL_MISSING/);
});

// smelt-resumes-after-hunger (3 of 6 runs red, 2026-10-20): the furnace window is one ingot behind the server in the tick
// an item finishes, so a take counted from its deltas misses that ingot. An attempt counts what it cooked from the input
// it loaded and the input that came back to the inventory; the window's deltas are kept only when the recovery failed.

function laggingFurnace(clock: FakeClock): Fixture {
  return observedFurnace({ clock, cookMs: 10_000, raw: 8, coal: 40, fuel: "stick", windowLagsCompletion: true });
}

for (const { at, inputs, window } of [
  // The 30 s take moves 3 ingots while the window shows 2; the abort gives the 5 uncooked raw back.
  { at: 35_000, inputs: [8, 5], window: "a mid-cook take" },
  // The 5th item has just finished: the window shows 1 ingot (2 there) and 4 raw (3 there); the takes move 2 and 3.
  { at: 50_000, inputs: [8, 3], window: "the tick an item finishes" },
]) {
  test(`an attempt aborted after the window under-counted ${window} resumes with what is really left`, async () => {
    const clock = mockedClock();
    using _installed = clock.install();
    const fixture = laggingFurnace(clock);
    const loads = recordLoads(fixture);
    const first = new AbortController();
    const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at, signal: first }]), () => {});

    await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
    const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

    assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
    assert.deepEqual(loads.inputs, inputs);
    assert.equal(result.smelt.produced, 8);
    assert.equal(carried(fixture, "iron_ingot"), 8);
    assert.equal(carried(fixture, "raw_iron"), 0);
  });
}

test("a recovery that leaves input in the slot does not count it as cooked, and the next attempt smelts it once", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // The first recovery takes back 2 of the 5 raw (the inventory had room for no more); the clear of the next attempt takes 3.
  // The fake reads `recoverInputCount` at each take, so the test lifts the limit for the next attempt.
  const options = { clock, cookMs: 10_000, raw: 8, coal: 40, fuel: "stick", windowLagsCompletion: true, recoverInputCount: 2 as number | undefined };
  const fixture = observedFurnace(options);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  assert.equal(carried(fixture, "raw_iron"), 2);
  options.recoverInputCount = undefined;
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(loads.inputs, [8, 5]);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.equal(carried(fixture, "raw_iron"), 0);
});

test("ingots the furnace cooks from input left in its slot while the bot is away are counted by the next attempt", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // The lit furnace keeps cooking the 3 raw the recovery left: 2 more ingots in the 20 s the reflex takes.
  const options = { clock, cookMs: 10_000, raw: 8, coal: 40, fuel: "stick", recoverInputCount: 2 as number | undefined };
  const fixture = observedFurnace(options);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  options.recoverInputCount = undefined;
  for (const ms of [10_000, 10_000, 1]) await fixture.dependencies.pause(ms);
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(loads.inputs, [8, 3]);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
});

test("an ingot the window hid at the abort is taken by the next attempt's clear and counted once", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // At 40 s the 4th item has just finished: the window shows no ingot (1 there) and 5 raw (4 there), so the recovery
  // takes no output; the input count makes it 4 ingots, and the reopened window shows the hidden one to the clear.
  const fixture = laggingFurnace(clock);
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 40_000, signal: first }]), () => {});

  await assert.rejects(clock.settle(run({ signal: first.signal }), ANSWERED_ATTEMPT_MS), /reflex took the body/);
  const result = await clock.settle(run(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.deepEqual(loads.inputs, [8, 4]);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
});

test("with a recovery error the attempt keeps the window's count and reports the error", async () => {
  const clock = mockedClock();
  using _installed = clock.install();
  // The takes at 30 s and 60 s move 3 each; the final take of the last 2 fails, so they stay in the furnace, uncounted.
  const fixture = observedFurnace({ clock, cookMs: 10_000, raw: 8, coal: 40, fuel: "stick", outputClickFailsAt: 3 });
  const result = await clock.settle(beginSmeltItem(fixture.bot, navigation, SMELT_8, fixture.dependencies, () => {})(freshAttempt()), ANSWERED_ATTEMPT_MS);

  assert.equal(result.status, "partial");
  assert.match(result.status === "partial" ? result.error : "", /window closed under the take/);
  assert.equal(result.smelt.produced, 6);
  assert.equal(carried(fixture, "iron_ingot"), 6);
});
