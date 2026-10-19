// A smelt request a reflex splits into attempts: the second smelts only what is left, with no effect doubled.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import type { RequestEvidence } from "../../session/request.js";
import { observedFurnace } from "../../test-support/furnace.js";
import type { WorldBlock } from "../../world/placement.js";
import type { WorkstationOperations } from "../temporary-workstation.js";
import { beginSmeltItem, type SmeltItemDependencies } from "./index.js";

const navigation = {} as NavigationRuntime;
/** Sticks burn 0.5 item each, so fuel for 8 and fuel for 5 differ (16 and 10) where coal's 8 would hide a doubling. */
const SMELT_8 = { itemName: "raw_iron", count: 8, fuelItemName: "stick", x: 2, y: 64, z: 0 } as const;

type Fixture = ReturnType<typeof observedFurnace>;

function sticksFurnace(): Fixture {
  return observedFurnace({ cookMs: 10_000, raw: 8, coal: 40, fuel: "stick" });
}

function carried(fixture: Fixture, name: string): number {
  return fixture.bot.inventory.items().find((item) => item.name === name)?.count ?? 0;
}

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
  // Run 15: 24 smelts ended by a reflex. Resumed naively, the second attempt smelts 8 again: 11 ingots, fuel for 8.
  const fixture = sticksFurnace();
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(run({ signal: first.signal }), /reflex took the body/);
  const result = await run(freshAttempt());

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
  const fixture = sticksFurnace();
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const putInput = fixture.furnace.putInput;
  fixture.furnace.putInput = async (type, metadata, count) => {
    await putInput(type, metadata, count);
    first.abort(new Error("reflex took the body"));
  };
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, fixture.dependencies, () => {});

  await assert.rejects(run({ signal: first.signal }), /reflex took the body/);
  assert.equal(carried(fixture, "raw_iron"), 8, "the unburnt input came back");
  assert.equal(loads.fuels.length, 0);
  fixture.furnace.putInput = putInput;
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.deepEqual(loads.fuels, [16], "fuel for 8 was inserted once");
});

test("two reflexes in a row make three attempts and one total", async () => {
  const fixture = sticksFurnace();
  const loads = recordLoads(fixture);
  const [first, second] = [new AbortController(), new AbortController()];
  const run = beginSmeltItem(
    fixture.bot,
    navigation,
    SMELT_8,
    reflexAt(fixture, [{ at: 35_000, signal: first }, { at: 70_000, signal: second }]),
    () => {},
  );

  await assert.rejects(run({ signal: first.signal }), /reflex/);
  await assert.rejects(run({ signal: second.signal }), /reflex/);
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.equal(carried(fixture, "iron_ingot"), 8);
  assert.equal(loads.inputs.length, 3);
  assert(loads.inputs[2]! < loads.inputs[1]! && loads.inputs[1]! < loads.inputs[0]!, `loads ${loads.inputs}`);
});

test("a request that already produced everything returns its success without opening the furnace again", async () => {
  const fixture = sticksFurnace();
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

  assert.equal((await run(freshAttempt())).status, "succeeded");
  const again = await run(freshAttempt());

  assert.equal(again.status, "succeeded");
  assert.equal(again.smelt.produced, 8);
  assert.equal(opens, 1);
  assert.deepEqual(loads.inputs, [8]);
});

test("a furnace broken between attempts ends the request partial with what was produced", async () => {
  const fixture = sticksFurnace();
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(run({ signal: first.signal }), /reflex/);
  fixture.bot.blockAt = (position) => ({ name: "air", position }) as WorldBlock;
  const result = await run(freshAttempt());

  assert.equal(result.status, "partial");
  assert.match(result.error, /FURNACE_NOT_PRESENT/);
  assert.equal(result.smelt.produced, 3);
  assert.equal(carried(fixture, "raw_iron"), 5);
});

test("another bot's contents in the furnace between attempts are never touched: occupied", async () => {
  const fixture = sticksFurnace();
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), () => {});

  await assert.rejects(run({ signal: first.signal }), /reflex/);
  fixture.furnace.inputItem = () => ({ name: "sand", count: 4 }) as never;
  const result = await run(freshAttempt());

  assert.equal(result.status, "partial");
  assert.match(result.error, /FURNACE_NOT_EMPTY/);
  assert.deepEqual(loads.inputs, [8], "nothing was loaded over a stranger's input");
});

test("input left in the furnace by an attempt cut off while loading is taken back and smelted", async () => {
  // putInput's window closed under it (the reflex moved the bot): the slot holds the input, ownsSlots was never set.
  const fixture = sticksFurnace();
  const loads = recordLoads(fixture);
  const first = new AbortController();
  const putInput = fixture.furnace.putInput;
  fixture.furnace.putInput = async (type, metadata, count) => {
    await putInput(type, metadata, count);
    first.abort(new Error("reflex took the body"));
    throw new Error("window closed");
  };
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, fixture.dependencies, () => {});

  await assert.rejects(run({ signal: first.signal }), /reflex took the body/);
  assert.equal(carried(fixture, "raw_iron"), 0, "the input is still in the furnace");
  fixture.furnace.putInput = putInput;
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.deepEqual(loads.fuels, [16]);
});

test("the progress read by the runner covers the whole request after an attempt is cut", async () => {
  const fixture = sticksFurnace();
  let read: (() => RequestEvidence) | undefined;
  let observed = 0;
  const first = new AbortController();
  const run = beginSmeltItem(fixture.bot, navigation, SMELT_8, reflexAt(fixture, [{ at: 35_000, signal: first }]), (reader) => {
    observed += 1;
    read = reader;
  });

  await assert.rejects(run({ signal: first.signal }), /reflex/);

  assert.equal(observed, 1, "begin observes once, not once per attempt");
  assert.deepEqual(read?.().baseline, { input: 8, fuel: 40 });
  assert.equal((read?.().checkpoint as { produced: number }).produced, 3);
  assert.equal(read?.().completion.observed, false);
});

/** A temporary furnace that stands in the world between attempts, with the operations a bot has for it. */
function furnaceOperations(fixture: Fixture, calls: string[]): WorkstationOperations {
  const position = { x: 2, y: 64, z: 0 };
  const block = fixture.bot.blockAt(new Vec3(2, 64, 0)) as WorldBlock;
  const standing = fixture.bot.blockAt;
  const items = fixture.bot.inventory.items() as { name: string; count: number }[];
  return {
    place: async () => {
      calls.push("place");
      items.splice(items.findIndex((item) => item.name === "furnace"), 1);
      return { kind: "placed", block, position: block.position };
    },
    moveToOpenGround: async () => false,
    collect: async () => {
      calls.push("collect");
      fixture.bot.blockAt = (cell) => (cell.x === position.x && cell.y === position.y && cell.z === position.z ? ({ name: "air", position: cell } as WorldBlock) : standing(cell));
      items.push({ name: "furnace", count: 1, type: fixture.bot.registry.itemsByName.furnace!.id } as never);
      return { status: "succeeded" };
    },
  };
}

test("a temporary furnace placed by an aborted attempt is reused, never placed twice, and recovered once", async () => {
  const fixture = sticksFurnace();
  (fixture.bot.inventory.items() as { name: string; count: number; type?: number }[]).push({
    name: "furnace",
    count: 1,
    type: fixture.bot.registry.itemsByName.furnace!.id,
  });
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

  await assert.rejects(run({ signal: first.signal }), /reflex/);
  assert.deepEqual(calls, ["place"], "an aborted attempt leaves the furnace standing");
  const result = await run(freshAttempt());

  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.smelt.produced, 8);
  assert.deepEqual(calls, ["place", "collect"]);
  assert.equal(result.workstation?.recovered, true);
  assert.equal(carried(fixture, "furnace"), 1);
});
