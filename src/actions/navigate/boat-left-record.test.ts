// A boat the crossing could not take back is said in words, recorded in the result, and taken back before the onward leg when she stands on it.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { boatsCarried, boatsInView, makeHitsMiss, seaHarness, settled, shoreSea, stallServerAtFirstHit } from "./boat-fixtures.test.js";
import { boatUnderFeet, crossByBoat } from "./boat-crossing.js";
import { retryBoatTakeBack } from "./boat-left-retry.js";
import { type BoatLeft, boatLeftAfter, describeBoatLeft, takeBoatBackReport } from "./boat-take-back.js";
import { createNavigateAction, formatNavigateResult, type NavigateDependencies } from "./navigate.js";
import type { NavigateResult } from "./contract.js";

const AHEAD = { x: 0, z: 1 };
const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
const SHIFT_RELEASE = 1;

/** A sea with the far land at z 40, one boat carried; the boat, once she is off it, floats where the ride stopped. */
const crossingWorld = (): FakeHarness => seaHarness({ landFromZ: 40 });

/** The crossing from the shore to the far land, run to its end on the fake clock. */
const crossed = (world: FakeHarness) => settled(world, crossByBoat(world.bot, AHEAD, undefined, 100));

/** When the shift of the get-off is released (she was put off the boat already), the boat is moved far from the ride's end (taken by someone, drifted off). */
function boatLeavesAtTheGetOff(world: FakeHarness): void {
  world.server.onPacket("entity_action", (data) => {
    if ((data as { actionId: number }).actionId === SHIFT_RELEASE) for (const boat of boatsInView(world)) boat.position = new Vec3(0.5, 62.5, 80.5);
  });
}

// Run 20: the take-back's outcome was dropped (`navigate` kept only the blocks of a crossing that succeeded), so Dirk's 41 minutes
// on a boat left no word of why. The record says which of the ways it failed.
test("a boat that stays under her for the whole time bound is recorded as still under her, with the hits and the time", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  makeHitsMiss(world);
  const result = await crossed(world);
  assert.equal(result.status, "crossed", result.detail);
  const left = result.boatLeft;
  assert.equal(left?.cause, "still_there");
  assert.equal(left.goneAfterHit, null);
  assert.match(left.reason, new RegExp(`^the boat is still under you after ${left.hits} hits in ${(left.elapsedMs / 1000).toFixed(1)} s$`, "u"));
  assert.match(result.detail, /; the boat was not picked back up: the boat is still under you after \d+ hits in \d+\.\d s/u);
});

test("a boat that is nowhere near where the ride stopped is recorded as not found, with no hit", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  boatLeavesAtTheGetOff(world);
  const result = await crossed(world);
  assert.equal(result.boatLeft?.cause, "not_found");
  assert.equal(result.boatLeft?.hits, 0);
  assert.equal(result.boatLeft?.reason, "the boat was not found within 6 blocks of where the ride stopped; it is lost");
});

// The broken boat's item: out of her reach (the item entity set 12 blocks off) or gone from her view (another player took it).
for (const [name, onItem, reason] of [
  ["out of reach", (_world: FakeHarness, entity: { position: Vec3 }) => void (entity.position = entity.position.offset(0, 0, -12)), /^the boat broke after hit \d+ but its item was not picked up \(an item 1[12] blocks off\): walk there to pick it up$/u],
  ["gone from her view", (world: FakeHarness, entity: { id: number }) => world.server.answer(() => world.entities.remove(entity.id)), /but its item was not picked up \(no item in view: it drifted off or someone else took it\)$/u],
] as const) {
  test(`a boat that broke with its item ${name} is recorded with the hit that broke it`, async () => {
    const world = crossingWorld();
    using _timers = world.clock.install();
    world.bot.on("entitySpawn", (entity) => {
      if (entity.name === "item") onItem(world, entity);
    });
    const left = (await crossed(world)).boatLeft;
    assert.equal(left?.cause, "item_not_picked_up");
    assert.equal(left.goneAfterHit, left.hits);
    assert.match(left.reason, reason);
  });
}

test("a boat taken back leaves no record", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  const result = await crossed(world);
  assert.equal(result.status, "crossed", result.detail);
  assert.equal(result.boatLeft, undefined);
  assert.doesNotMatch(result.detail, /not picked back up/u);
});

// A boat beside the bank she stands on is not under her feet: the next movement takes back only a boat under her, so the text must not promise it.
test("a boat left floating beside her is recorded as not under her, and the next movement sends no hit to it", async () => {
  const world = shoreSea({ feet: new Vec3(9.5, 63, 0.5), boat: new Vec3(10.6, 62.49, 0.5), mocked: true, waterDepth: 2 });
  using _timers = world.clock.install();
  stallServerAtFirstHit(world);
  const boat = world.bot.entities[7]!;
  const report = await settled(world, takeBoatBackReport(world.bot, boat, undefined, { settleMs: 0 }));
  const left = boatLeftAfter(world.bot, report, { boat, underFeet: boatUnderFeet(world.bot) !== null, cancelled: false });
  assert.equal(left.cause, "left_nearby");
  assert.match(left.reason, /^the boat is still floating 1 blocks away after \d+ hits in \d+\.\d s; it is not under you, so the next movement leaves it$/u);
  const hits = attackedIds(world.server).length;
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.equal(attackedIds(world.server).length, hits, "the next movement leaves it, as the text says");
});

// What the model reads in a navigate result, by cause: only a boat under her promises the next movement takes it back.
for (const [cause, reason, promises] of [
  ["still_there", "the boat is still under you after 34 hits in 10.2 s", true],
  ["left_nearby", "the boat is still floating 2 blocks away after 34 hits in 10.2 s; it is not under you, so the next movement leaves it", false],
  ["not_found", "the boat was not found within 6 blocks of where the ride stopped; it is lost", false],
  ["item_not_picked_up", "the boat broke after hit 9 but its item was not picked up (an item 12 blocks off): walk there to pick it up", false],
] as const) {
  test(`the navigate result says why a boat was left (${cause})`, () => {
    const left: BoatLeft = { cause, reason, hits: 9, elapsedMs: 2400, goneAfterHit: null };
    const line = describeBoatLeft(left);
    assert.ok(line.startsWith(`- The boat was not picked back up: ${reason}`));
    assert.equal(line.includes("The next movement tries to take it back again."), promises);
  });
}

/** Navigates to the far land, the first route stopped by the sea; `onward` runs when the leg after the crossing begins. */
async function navigateAcrossTheSea(world: FakeHarness, onward: () => void): Promise<NavigateResult> {
  let legs = 0;
  const dependencies: NavigateDependencies = {
    createMovements: (() => ({ name: "standard" })) as never,
    navigate: async () => {
      legs += 1;
      if (legs === 1) return { status: "stopped", reason: "no path found", elapsedMs: 5 };
      onward();
      return { status: "completed", elapsedMs: 5 };
    },
  };
  const { result } = await settled(world, new ActionRunner().run(createNavigateAction(world.bot, navigation, dependencies), { x: 0, y: 63, z: 41, range: 5 }), 300_000);
  return result as NavigateResult;
}

const boatLeftOf = (result: NavigateResult) => ("navigation" in result ? result.navigation.boatLeft : undefined);

// She stands on the boat the take-back could not break; the onward leg would route from on top of it (Dirk's "succeeded" with a distance of 1).
test("a boat still under her after the crossing is taken back before the onward leg, and the result has no boat left", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  makeHitsMiss(world, 15_000);
  let carriedAtOnwardLeg = -1;
  const result = await navigateAcrossTheSea(world, () => void (carriedAtOnwardLeg = boatsCarried(world)));
  assert.equal(result.status, "succeeded");
  assert.equal(carriedAtOnwardLeg, 1, "the boat was taken back before the onward leg began");
  assert.equal(boatLeftOf(result), undefined);
  assert.equal(boatUnderFeet(world.bot), null);
});

test("a boat that stays under her through the retry is in the result, and the next movement takes it back", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  const landAgain = makeHitsMiss(world);
  const result = await navigateAcrossTheSea(world, landAgain);
  assert.equal(result.status, "succeeded");
  assert.equal(boatLeftOf(result)?.cause, "still_there");
  assert.equal(boatsCarried(world), 0, "the retry did not break it either");
  assert.ok(attackedIds(world.server).length > 60, "two take-backs of 10 s each hit it: the crossing's and the retry's");
  assert.ok(boatUnderFeet(world.bot) !== null, "she stands on it");
  assert.match(formatNavigateResult(result), /- The boat was not picked back up: the boat is still under you after \d+ hits in \d+\.\d s\. The next movement tries to take it back again\./u);
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.equal(boatsCarried(world), 1, "the next movement, with the hits landing, takes it back");
});

// The record is told from the last take-back: a retry that breaks the boat with its item out of reach must not say "still under you".
test("a retry that breaks the boat but cannot reach its item records the item, not the boat under her", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  makeHitsMiss(world, 12_000);
  world.bot.on("entitySpawn", (entity) => {
    if (entity.name === "item") entity.position = entity.position.offset(0, 0, -12);
  });
  const result = await navigateAcrossTheSea(world, () => undefined);
  assert.equal(boatLeftOf(result)?.cause, "item_not_picked_up");
  assert.match(formatNavigateResult(result), /- The boat was not picked back up: the boat broke after hit \d+ but its item was not picked up \(an item 1[12] blocks off\): walk there to pick it up\n/u);
});

test("a boat left with no boat under her is not retried: the result says where it is lost", async () => {
  const world = crossingWorld();
  using _timers = world.clock.install();
  boatLeavesAtTheGetOff(world);
  const result = await navigateAcrossTheSea(world, () => undefined);
  assert.equal(boatLeftOf(result)?.cause, "not_found");
  assert.match(formatNavigateResult(result), /- The boat was not picked back up: the boat was not found within 6 blocks of where the ride stopped; it is lost\n/u);
});

test("a cancel during the retry before the onward leg ends it with the cancel", async () => {
  const world = seaHarness({ boatsCarried: 0, waterDepth: 2, entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 62.49, 0.5) } } });
  world.bot.entity.position = new Vec3(0.5, 63.05, 0.5);
  using _timers = world.clock.install();
  const controller = new AbortController();
  const hit = world.bot.attack.bind(world.bot);
  world.bot.attack = (target) => {
    hit(target);
    controller.abort(new Error("cancelled by the test"));
  };
  const left = { cause: "still_there", reason: "the boat is still under you", hits: 34, elapsedMs: 10_000, goneAfterHit: null } as const;
  await assert.rejects(settled(world, retryBoatTakeBack(world.bot, { status: "crossed", blocks: 30, detail: "", boatLeft: left }, controller.signal)), /cancelled by the test/u);
  assert.equal(world.bot.entities[7] !== undefined, true, "one hit sent, no more");
});
