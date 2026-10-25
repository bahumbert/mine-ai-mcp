// The boat she stands on is found wherever it floats: shallows, carried boats, a carpet; not one a block or a rider holds.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { boatsCarried, settled, shoreSea } from "./boat-fixtures.test.js";
import { boatUnderFeet } from "./boat-crossing.js";
import { watchVehicle } from "./vehicle-sync.js";

const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
/** A boat 7 floating over water two deep by the shore, and the feet the server stands her at on top of it. */
const SHALLOW_BOAT = new Vec3(20.5, 62.52, 0.5);
const ON_SHALLOW_BOAT = new Vec3(20.5, 63.05, 0.5);

/** The server's passenger list for boat 7, as it reaches the client. */
const listPassengers = (world: FakeHarness, passengers: number[]) => world.bot._client.emit("set_passengers", { entityId: 7, passengers });

// Run 20: Dirk stood on his boat by a shore for 41 min and Vex for 19 min; run 17c: Theo over water two deep. The old
// reading wanted deep open water and no boat carried, so every movement's preparation refused the boat and pinned her.
test("a boat she stands on is found over water two deep by the shore, at the feet the server sets her at", () => {
  const options = { boat: SHALLOW_BOAT, waterDepth: 2 };
  assert.equal(boatUnderFeet(shoreSea({ ...options, feet: ON_SHALLOW_BOAT }).bot)?.id, 7);
  assert.equal(boatUnderFeet(shoreSea({ ...options, feet: new Vec3(20.5, 62.61, 0.5) }).bot)?.id, 7);
  assert.equal(boatUnderFeet(shoreSea({ ...options, feet: ON_SHALLOW_BOAT, carried: { oak_boat: 1 } }).bot)?.id, 7, "whatever she carries: standing on one pins her (owner 2026-10-25)");
});

// Owner 2026-10-25: a boat she STANDS ON. A boat beside her is somebody's: a bot mid-jump on the bank, or swimming past one.
test("a boat beside her, not under her footprint, is left alone: mid-jump on the bank, swimming past it", () => {
  const jumping = shoreSea({ feet: new Vec3(9.8, 63.5, 0.5), boat: new Vec3(11.2, 62.52, 0.5) });
  assert.equal(boatUnderFeet(jumping.bot), null, "mid-jump on the bank, 1.4 off the boat's centre: no block holds her at this instant");
  const swimming = shoreSea({ feet: new Vec3(21.6, 62.6, 0.5), boat: SHALLOW_BOAT, waterDepth: 2, carried: { oak_boat: 1 } });
  assert.equal(boatUnderFeet(swimming.bot), null, "swimming 1.1 blocks off a boat's centre");
  const edge = shoreSea({ feet: new Vec3(21.4, 63.05, 0.5), boat: SHALLOW_BOAT, waterDepth: 2 });
  assert.equal(boatUnderFeet(edge.bot)?.id, 7, "on the boat's edge: her footprint overlaps its 1.375 width");
});

test("a boat resting on a carpet on land is found when its top holds her up and no block does", () => {
  const world = shoreSea({ feet: new Vec3(0.5, 63.62, 0.5), boat: new Vec3(0.5, 63.07, 0.5), cells: { "0,63,0": "white_carpet" } });
  assert.equal(boatUnderFeet(world.bot)?.id, 7);
});

test("a boat is left alone when she is seated, when a block holds her up beside it, when a cell under her is unknown", () => {
  const seated = shoreSea({ boat: SHALLOW_BOAT, waterDepth: 2, feet: ON_SHALLOW_BOAT });
  seated.bot.entity.vehicle = seated.bot.entities[7]!;
  assert.equal(boatUnderFeet(seated.bot), null, "seated: the get-off comes first");
  const bank = shoreSea({ feet: new Vec3(9.8, 63, 0.5), boat: new Vec3(10.5, 62.52, 0.5) });
  assert.equal(boatUnderFeet(bank.bot), null, "the bank holds her up; the boat beside it, over deep water, is somebody's");
  const land = shoreSea({ feet: new Vec3(0.5, 63.05, 0.5), boat: new Vec3(0.5, 62.49, 0.5) });
  assert.equal(boatUnderFeet(land.bot), null, "on land over a boat");
  const unknown = shoreSea({ boat: SHALLOW_BOAT, feet: ON_SHALLOW_BOAT, cells: { "20,62,0": "void", "20,61,0": "void" } });
  assert.equal(boatUnderFeet(unknown.bot), null, "nothing known is broken");
});

// Mineflayer never drops a rider a list leaves out, so the riders are the server's last list (vehicle-sync `ridersOf`).
test("a boat with another rider in it is left alone; one the rider left is found", () => {
  const world = shoreSea({ boat: SHALLOW_BOAT, waterDepth: 2, feet: ON_SHALLOW_BOAT });
  const stop = watchVehicle(world.bot);
  listPassengers(world, [world.bot.entity.id, 31]);
  assert.equal(boatUnderFeet(world.bot), null, "another entity sits in it");
  listPassengers(world, [31]);
  assert.equal(boatUnderFeet(world.bot), null, "the list names only the other");
  listPassengers(world, []);
  assert.equal(boatUnderFeet(world.bot)?.id, 7, "a later list that leaves it out");
  listPassengers(world, [world.bot.entity.id]);
  assert.equal(boatUnderFeet(world.bot)?.id, 7, "the list that still names only her (the one that seated her)");
  stop();
});

test("the next movement from a boat she stands on over water two deep, nothing carried, takes it back", async () => {
  const world = shoreSea({ boat: SHALLOW_BOAT, waterDepth: 2, feet: ON_SHALLOW_BOAT, mocked: true, physics: true });
  using _timers = world.clock.install();
  assert.equal(boatsCarried(world), 0);
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.deepEqual([...new Set(attackedIds(world.server))], [7], "the boat under her is hit until it breaks");
  assert.equal(boatsCarried(world), 1, "one boat is carried");
  assert.equal(boatUnderFeet(world.bot), null, "nothing is left under her");
});

test("the next movement leaves a boat floating beside the bank she stands on", async () => {
  const world = shoreSea({ feet: new Vec3(9.8, 63, 0.5), boat: new Vec3(10.5, 62.52, 0.5), mocked: true, physics: true });
  using _timers = world.clock.install();
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.deepEqual(attackedIds(world.server), [], "somebody's boat is not broken");
  assert.equal(world.bot.entities[7] !== undefined, true);
});
