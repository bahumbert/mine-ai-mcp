import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import { boatUnderFeet, carriesBoat, crossByBoat, deepWaterOnTheWay, lowBankAlong, takeBoatBack } from "./boat-crossing.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { leaveBoatSeat, prepareBotForMovement } from "../../session/prepare-body.js";
import { attackedIds } from "../../test-support/combat.js";
import type { FakeHarness } from "../../test-support/fake-bot/index.js";
import { boatsCarried, farBankSea, mountedSea, seaHarness, settled, shifts, shoreSea, theBoat, vehicleMoves, wroteAShift } from "./boat-fixtures.test.js";
import { getOff } from "./boat-get-off.js";
import { freeHeldSeat, watchServerSeat } from "./server-seat-watch.js";
import { watchVehicle } from "./vehicle-sync.js";

const AHEAD = { x: 0, z: 1 };
const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;

/** The positions the server sent the client from now on. */
function recordPositions(world: FakeHarness): unknown[] {
  const positions: unknown[] = [];
  world.bot._client.on("position", (packet: unknown) => void positions.push(packet));
  return positions;
}

/** The boat that every hit of the client went to, once: the one she broke. */
const hitBoats = (world: FakeHarness) => [...new Set(attackedIds(world.server))];

test("deep open water on the straight way is found with the shore before it and the far shore after", () => {
  const water = deepWaterOnTheWay(shoreSea().bot, new Vec3(0.5, 63, 0.5), { x: 60, z: 0 });
  assert.ok(water);
  assert.deepEqual([water.shore?.x, water.start.x, water.start.y, water.farShore?.x, water.length], [9, 10, 62, 41, 31]);
});

test("no deep water on a way over land, or away from the sea", () => {
  assert.equal(deepWaterOnTheWay(shoreSea().bot, new Vec3(0.5, 63, 0.5), { x: -60, z: 0 }), null);
  assert.equal(deepWaterOnTheWay(shoreSea().bot, new Vec3(0.5, 63, 0.5), { x: 0.5, z: 80 }), null);
});

test("any boat counts as a boat", () => {
  assert.equal(carriesBoat(shoreSea({ carried: { oak_boat: 1 } }).bot), true);
  assert.equal(carriesBoat(shoreSea({ carried: { bamboo_raft: 1 } }).bot), true);
  assert.equal(carriesBoat(shoreSea({ carried: { oak_planks: 5 } }).bot), false);
});

test("the far shore is left where its bank is low enough to climb out of the water: the nearest along it, or none", () => {
  // Live 2026-10-04: a bank two blocks above the water held a swimmer in it; kelp at the surface is water.
  const east = { x: 1, z: 0 };
  assert.equal(lowBankAlong(farBankSea(-200).bot, { x: 39.5, z: 0.5 }, east, 62), 0);
  // Heading east, the heading's left (+) is toward +z.
  assert.equal(lowBankAlong(farBankSea(6).bot, { x: 39.5, z: 0.5 }, east, 62), 6);
  assert.equal(lowBankAlong(farBankSea(200).bot, { x: 39.5, z: 0.5 }, east, 62), null);
});

test("a boat she stands on out at sea is found, carried boats or not; not one she rides, stands beside or on land", () => {
  // Live 2026-10-10: Vex stood on his own boat at sea a whole run, every way refused "no boat is carried".
  const atSea = new Vec3(20.5, 62.49, 0.5);
  const standing = new Vec3(20.5, 63.05, 0.5);
  assert.equal(boatUnderFeet(shoreSea({ feet: standing, boat: atSea }).bot)?.id, 7);
  assert.equal(boatUnderFeet(shoreSea({ feet: standing, boat: atSea, carried: { oak_boat: 1 } }).bot)?.id, 7, "standing on one pins her whatever she carries (owner 2026-10-25)");
  const riding = shoreSea({ feet: standing, boat: atSea });
  riding.bot.entity.vehicle = riding.bot.entities[7]!;
  assert.equal(boatUnderFeet(riding.bot), null);
  assert.equal(boatUnderFeet(shoreSea({ feet: new Vec3(24.5, 63.05, 0.5), boat: atSea }).bot), null);
  assert.equal(boatUnderFeet(shoreSea({ feet: new Vec3(0.5, 63.05, 0.5), boat: new Vec3(0.5, 62.49, 0.5) }).bot), null);
});

test("a boat taken back is broken by hand and its item picked up", async () => {
  const world = shoreSea({ feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(20.5, 62.49, 0.5), mocked: true, physics: true });
  using _timers = world.clock.install();
  assert.equal(await settled(world, takeBoatBack(world.bot, world.bot.entities[7]!, undefined, 0)), true);
  assert.equal(world.bot.entities[7], undefined);
  assert.equal(boatsCarried(world), 1);
});

test("a ride over open sea with no land stops at the distance asked for and stays mounted there: no ride back, the boat not broken", async () => {
  // Live 2026-10-16 (run 13): Vex explored 4 chunks north, rode 103 blocks, then back to where the boat went in.
  const world = seaHarness();
  using _timers = world.clock.install();
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
  assert.equal(result.status, "failed");
  assert.equal(result.atSea, true);
  assert.equal(result.blocks, 10, "stops at the distance asked for, not past it");
  assert.match(result.detail, /at sea in its boat at 0 1[0-9]\b/u);
  assert.match(result.detail, /no land within 10 blocks that way/u);
  assert.doesNotMatch(result.detail, /rode back/u);
  // Still in the boat: no get-off packets, nothing broken, the boat still in the water where it stopped.
  assert.equal(world.bot.vehicle, theBoat(world));
  assert.deepEqual(shifts(world), []);
  assert.deepEqual(attackedIds(world.server), []);
  const moves = vehicleMoves(world);
  const last = moves[moves.length - 1]!;
  // The distance is counted from where she stood (z 0.5), not from where the boat went in (3.5).
  assert.ok(Number(last.z) > 10 && Number(last.z) < 11.5, `the boat ended ${String(last.z)}: ten blocks from where she stood, not back at 3.5`);
});

test("the next movement from a bot mounted at sea takes the boat back, so the route goes in where she floats", async () => {
  const world = seaHarness();
  using _timers = world.clock.install();
  await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
  const boat = theBoat(world);
  assert.equal(carriesBoat(world.bot), false);
  // The server answers the shift with a position (contract check boat-get-off-by-shift): Mineflayer's physics, off since the mount, is switched on by it.
  const positions = recordPositions(world);
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.deepEqual(shifts(world), [true, false], "shift is pressed then released to get off a boat; a jump input does not");
  assert.equal(positions.length, 1, "physics is switched back on where she stands");
  assert.deepEqual(hitBoats(world), [boat.id], "the boat she rode is broken by hand");
  assert.equal(carriesBoat(world.bot), true);
  assert.equal(world.bot.vehicle, null);
  assert.equal(world.bot.entity.vehicle, null);
});

// Run 14b: a ride that ended this way (Theo: "rode back to where the boat went in") left physics off; his next navigate
// never got a tick. The server let him off and told his client nothing; physics, off since the mount, stayed off.
test("a ride that ends on the water gets off with shift held until the server lets her off, and physics comes back", async () => {
  // A server behind by 600 ms on every answer: the shift is read after it has been down that long.
  const world = seaHarness({ loadedTo: 12, lagMs: 600 });
  using _timers = world.clock.install();
  const order: string[] = [];
  world.bot._client.on("set_passengers", (packet: { passengers: number[] }) => {
    if (!packet.passengers.includes(world.bot.entity.id)) order.push("let off");
  });
  const positions = recordPositions(world);
  const writes = world.bot._client.write;
  world.bot._client.write = (name: string, packet: Record<string, unknown>) => {
    if (name === "entity_action") order.push(packet.actionId === 0 ? "shift down" : "shift up");
    writes(name, packet);
  };
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 40));
  assert.equal(result.status, "failed");
  assert.match(result.detail, /rode back to where the boat went in/u);
  assert.deepEqual(order, ["shift down", "let off", "shift up"], "shift stays down until the server answers: a lagging server reads both at once");
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.equal(world.bot.vehicle, null);
  assert.equal(world.bot.entity.vehicle, null);
  assert.ok(vehicleMoves(world).length > 0);
});

// The vanilla 1.21.4 case: the server never reads the shift (stopped, or behind by more than the wait): the wait ends on the wall clock.
test("a ride end the server does not answer releases shift after the wait, forgets the boat and still turns physics back on", async () => {
  const world = seaHarness({ loadedTo: 12 });
  using _timers = world.clock.install();
  world.bot.once("mount", () => world.server.stop());
  const positions = recordPositions(world);
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 40));
  assert.match(result.detail, /rode back to where the boat went in/u);
  assert.deepEqual(shifts(world), [true, false]);
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.equal(world.bot.vehicle, null);
});

test("a ride whose get-off went unanswered says she may still be seated", async () => {
  const world = seaHarness({ loadedTo: 12 });
  using _timers = world.clock.install();
  world.bot.once("mount", () => world.server.stop());
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 40, { getOffWallMs: 200 }));
  assert.match(result.detail, /may still be seated/u);
});

test("a boat she could not get into is left with no listener behind and taken back", async () => {
  const world = seaHarness({ physics: true });
  using _timers = world.clock.install();
  // The boat is full when she tries (two other riders: the server refuses with silence, contract check boat-mount-refused).
  world.bot.on("entitySpawn", (entity) => {
    if (entity.name !== "oak_boat") return;
    world.server.seatRider(entity.id, 9_001);
    world.server.seatRider(entity.id, 9_002);
  });
  const mountListeners = world.bot.listenerCount("mount");
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10, { mountWallMs: 200 }));
  assert.equal(result.status, "failed");
  assert.match(result.detail, /could not get into the boat/u);
  assert.equal(world.bot.listenerCount("mount"), mountListeners);
  assert.equal(hitBoats(world).length, 1, "the launched boat is broken and picked up");
  assert.equal(carriesBoat(world.bot), true);
});

test("a ride stops where the server put the boat back, as a leg does", async () => {
  // A block over the water from z 7 on: the boat runs into it, and the server puts the boat back.
  const world = seaHarness({ barrierFromZ: 7 });
  using _timers = world.clock.install();
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 30));
  assert.ok(result.blocks < 15, `rode ${String(result.blocks)} blocks past the correction at 7`);
});

// The late seat the server really shows (the old mock's "vehicle shown, mount event late" never happens: entities.js:808-811).
test("a seat the server gives after the wait gave up: the boat she sits in is taken back and broken, and the vehicle watch lets her off with physics running", async () => {
  // A server 400 ms behind answers the mount after the 100 ms wait: the crossing has given up and takes the boat back.
  const world = seaHarness({ lagMs: 400, physics: true });
  using _timers = world.clock.install();
  const stopWatch = watchVehicle(world.bot);
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10, { mountWallMs: 100 }));
  assert.match(result.detail, /could not get into the boat/u);
  assert.equal(world.bot.vehicle, null, "the boat broke under her and the watch forgot it");
  let ticks = 0;
  world.bot.on("physicsTick", () => void (ticks += 1));
  await world.clock.advance(1_000);
  assert.ok(ticks >= 10, `${ticks} physics ticks in a second after the boat broke`);
  assert.equal(carriesBoat(world.bot), true);
  stopWatch();
});

// B4: with a second boat carried nothing broke the boat she left, and the server kept her seated while her client walked.
test("the next movement after a stay at sea with two boats carried gets her off and takes back the boat she left", async () => {
  const world = seaHarness({ boatsCarried: 2 });
  using _timers = world.clock.install();
  await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
  const boat = theBoat(world);
  assert.equal(boatsCarried(world), 1, "one of the two boats is the one she sits in");
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.deepEqual(hitBoats(world), [boat.id], "the boat she left is hit until it breaks, though another boat is carried");
  assert.equal(boatsCarried(world), 2);
  assert.equal(world.bot.vehicle, null);
});

describe("a seat the server still holds", () => {
  /**
   * She rode 10 blocks and was let off by a server that read the press and the release of the shift in one tick (a server
   * behind: contract check boat-shift-within-one-tick); her client then walked 60 blocks on.
   */
  async function heldAfterAStay(world: FakeHarness) {
    const watch = watchServerSeat(world.bot);
    await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
    const boat = theBoat(world);
    world.server.stop();
    await settled(world, getOff(world.bot, { wallMs: 400 }));
    world.server.resume();
    await world.clock.advance(200);
    world.bot.entity.position = new Vec3(0.5, 63, 70.5);
    return { watch, boat };
  }

  test("a held seat is freed by breaking the boat, then navigate goes on", async () => {
    const world = seaHarness();
    using _timers = world.clock.install();
    const { watch, boat } = await heldAfterAStay(world);
    assert.notEqual(watch.heldAt(), null, "her client is 60 blocks from where the server holds her");
    await settled(world, prepareBotForMovement(world.bot, navigation));
    assert.deepEqual(hitBoats(world), [boat.id], "the boat is hit from the seat the server holds, until it breaks");
    assert.equal(watch.heldAt(), null, "the server answered with a position");
    assert.equal(boatsCarried(world), 1, "the boat is carried again");
    assert.equal(world.bot.vehicle, null);
    assert.deepEqual(shifts(world).slice(-2), [true, false], "shift is held while the boat is hit and released after");
    watch.stop();
  });

  test("a seat the server never frees fails the preparation with where it holds her, and records nothing shared", async () => {
    const world = seaHarness();
    using _timers = world.clock.install();
    const { watch } = await heldAfterAStay(world);
    world.server.stop();
    await assert.rejects(
      settled(world, freeHeldSeat(world.bot, { wallMs: 300 })),
      /\[SERVER_HELD_POSITION\] The server still holds you at -?\d+ -?\d+ -?\d+ \(seated in a boat there\); movement was stopped\./u,
    );
    watch.stop();
  });
});

describe("a ride that is interrupted stays seated (ACT-01)", () => {
  /** Aborts the controller once `count` vehicle_move packets were written (a ride cancelled mid-water). */
  function abortAfterMoves(world: FakeHarness, count: number, reason: Error): AbortController {
    const controller = new AbortController();
    const write = world.bot._client.write;
    let moves = 0;
    world.bot._client.write = (name: string, packet: Record<string, unknown>) => {
      write(name, packet);
      if (name === "vehicle_move" && (moves += 1) === count) controller.abort(reason);
    };
    return controller;
  }
  const stillSeated = (world: FakeHarness) => {
    assert.equal(world.bot.vehicle, theBoat(world), "still in the boat");
    assert.equal(wroteAShift(world), false, "no shift");
    assert.deepEqual(attackedIds(world.server), [], "the boat is not hit");
    const moves = vehicleMoves(world).map((packet) => JSON.stringify(packet));
    assert.equal(new Set(moves.slice(-4)).size, 1, "the last 4 moves are the same stopped place");
  };

  test("a ride cancelled over deep water stops the boat and stays seated: no shift, no hit, the boat where it stopped", async () => {
    const world = seaHarness();
    using _timers = world.clock.install();
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    const result = await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 100));
    assert.equal(result.status, "failed");
    assert.equal(result.atSea, true);
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat at -?\d+ -?\d+/u);
    assert.match(result.detail, /cancelled by the brain/u);
    stillSeated(world);
  });

  test("a ride cancelled in shallows stays seated too", async () => {
    const world = seaHarness({ waterDepth: 2 });
    using _timers = world.clock.install();
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    const result = await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 100));
    assert.equal(result.status, "failed");
    assert.equal(result.atSea, false);
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat at -?\d+ -?\d+/u);
    stillSeated(world);
  });

  test("a cancel during the ride back still stays seated", async () => {
    const world = seaHarness({ loadedTo: 12 });
    using _timers = world.clock.install();
    // The water ahead is not loaded at z 9: about 17 moves out, then the ride turns back; the 25th move is on the way back.
    const controller = abortAfterMoves(world, 25, new Error("cancelled by the brain"));
    const result = await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 40));
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat/u);
    stillSeated(world);
  });

  test("a death during the ride ends it at once: no stop moves for a boat she left, no get-off", async () => {
    const world = seaHarness();
    using _timers = world.clock.install();
    const write = world.bot._client.write;
    const deathListeners = world.bot.listenerCount("death");
    let moves = 0;
    let movesAtDeath = -1;
    world.bot._client.write = (name: string, packet: Record<string, unknown>) => {
      write(name, packet);
      if (name === "vehicle_move" && (moves += 1) === 10) {
        movesAtDeath = vehicleMoves(world).length;
        world.bot.emit("death");
      }
    };
    const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 100));
    assert.equal(result.status, "failed");
    assert.match(result.detail, /died during the ride/u);
    assert.equal(vehicleMoves(world).length, movesAtDeath, "no move after the death");
    assert.equal(wroteAShift(world), false);
    assert.equal(world.bot.listenerCount("death"), deathListeners, "no death listener is left");
    assert.equal(world.bot._client.listenerCount("vehicle_move"), 0);
  });

  test("the next movement takes back the boat she just left, in shallows too", async () => {
    const world = seaHarness({ waterDepth: 2 });
    using _timers = world.clock.install();
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 100));
    const boat = theBoat(world);
    assert.deepEqual(shifts(world), [], "a cancelled ride does not get off");
    await settled(world, prepareBotForMovement(world.bot, navigation));
    assert.deepEqual(shifts(world), [true, false], "the preparation gets off with shift");
    assert.deepEqual(hitBoats(world), [boat.id]);
    assert.equal(carriesBoat(world.bot), true);
    assert.equal(world.bot.vehicle, null);
  });

  test("after a cancelled ride at sea, prepareBotForMovement then a crossing reaches the far side", async () => {
    const world = seaHarness({ landFromZ: 40 });
    using _timers = world.clock.install();
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    await settled(world, crossByBoat(world.bot, AHEAD, controller.signal, 100));
    await settled(world, prepareBotForMovement(world.bot, navigation));
    assert.equal(carriesBoat(world.bot), true);
    const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 100));
    assert.equal(result.status, "crossed", result.detail);
  });

  test("a preparation cancelled between hits stops hitting: the boat stays, the result says so", async () => {
    const world = shoreSea({ feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(20.5, 62.49, 0.5), mocked: true });
    using _timers = world.clock.install();
    const controller = new AbortController();
    // A boat takes many hits: the first one cancels the preparation.
    const hit = world.bot.attack.bind(world.bot);
    world.bot.attack = (target: Entity) => {
      hit(target);
      controller.abort(new Error("cancelled"));
    };
    const startedAt = performance.now();
    assert.equal(await settled(world, takeBoatBack(world.bot, world.bot.entities[7]!, controller.signal, 0)), false);
    assert.deepEqual(attackedIds(world.server), [7], "one hit, then it stops");
    assert.ok(performance.now() - startedAt < 1_000, "no more hits and no swim after the cancel");
  });
});

test("a cancel during the swim after the boat item ends it within 200 ms", async () => {
  // The boat broke and its item floated off: swum after, up to 15 s; a cancel ends the swim at its next look.
  const world = shoreSea({ feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(25.5, 62.49, 0.5), mocked: true, physics: true });
  using _timers = world.clock.install();
  const controller = new AbortController();
  let cancelledAt = 0;
  const setControl = world.bot.setControlState.bind(world.bot);
  world.bot.setControlState = (control, state) => {
    setControl(control, state);
    if (control === "forward" && state && cancelledAt === 0) {
      cancelledAt = performance.now();
      controller.abort(new Error("cancelled"));
    }
  };
  assert.equal(await settled(world, takeBoatBack(world.bot, world.bot.entities[7]!, controller.signal, 0)), false);
  assert.ok(cancelledAt > 0, "the item was swum after");
  assert.ok(performance.now() - cancelledAt < 200, `the swim ended ${String(Math.round(performance.now() - cancelledAt))} ms after the cancel`);
});

test("the next preparation after a respawn sends no shift", async () => {
  const world = seaHarness();
  using _timers = world.clock.install();
  const stop = watchVehicle(world.bot);
  await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
  assert.equal(world.bot.vehicle, theBoat(world), "seated at sea");
  world.bot.emit("death");
  world.bot.emit("respawn");
  await settled(world, prepareBotForMovement(world.bot, navigation));
  assert.deepEqual(shifts(world), [], "she rides nothing: no get-off, no shift");
  stop();
});

describe("navigate rides on from the seat (B5)", () => {
  test("a crossing that starts seated rides on: no launch, no mount, no hit", async () => {
    const world = await mountedSea();
    using _timers = world.clock.install();
    const placed = boatsCarried(world);
    const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 10));
    assert.equal(result.atSea, true, "the ride went on and stayed at sea");
    assert.equal(boatsCarried(world), placed, "no second boat was launched");
    assert.equal(world.bot.vehicle, theBoat(world), "the same boat");
    assert.deepEqual(attackedIds(world.server), []);
    assert.deepEqual(shifts(world), []);
    assert.ok(vehicleMoves(world).length > 0);
  });

  test("prepareBotForMovement with keepBoatSeat stays seated: no shift", async () => {
    const world = await mountedSea();
    using _timers = world.clock.install();
    await settled(world, prepareBotForMovement(world.bot, navigation, undefined, { keepBoatSeat: true }));
    assert.equal(world.bot.vehicle, theBoat(world));
    assert.deepEqual(shifts(world), []);
    assert.deepEqual(attackedIds(world.server), []);
  });

  test("leaveBoatSeat in shallows takes back the boat just left", async () => {
    const world = await mountedSea({ waterDepth: 2 });
    using _timers = world.clock.install();
    const boat = theBoat(world);
    await settled(world, leaveBoatSeat(world.bot));
    assert.deepEqual(shifts(world), [true, false]);
    assert.deepEqual(hitBoats(world), [boat.id]);
    assert.equal(world.bot.vehicle, null);
    assert.equal(boatsCarried(world), 2, "the boat she carried and the one taken back");
  });
});

test("a crossing that starts seated and reaches the far bank takes the same boat back", async () => {
  const world = await mountedSea({ landFromZ: 40 });
  using _timers = world.clock.install();
  const boat = theBoat(world);
  const result = await settled(world, crossByBoat(world.bot, AHEAD, undefined, 100));
  assert.equal(result.status, "crossed", result.detail);
  assert.deepEqual(hitBoats(world), [boat.id], "the boat she rode is broken at the bank");
  assert.equal(boatsCarried(world), 2, "the boat she carried and the one she rode");
  assert.equal(world.bot.vehicle, null);
});

test("a boat taken back is swum after when its item floated off, though another boat is carried", async () => {
  // Live 2026-10-20 (boat-at-sea-two-boats scenario): with a second boat carried, "no boat carried" never held, so the
  // item that drifted off the bank was never swum after and the ridden boat was lost.
  const world = shoreSea({ feet: new Vec3(20.5, 63.05, 0.5), boat: new Vec3(24.5, 62.49, 0.5), carried: { oak_boat: 1 }, mocked: true, physics: true });
  using _timers = world.clock.install();
  assert.equal(await settled(world, takeBoatBack(world.bot, world.bot.entities[7]!, undefined, 0)), true);
  assert.equal(boatsCarried(world), 2, "the item was swum after and picked up");
});
