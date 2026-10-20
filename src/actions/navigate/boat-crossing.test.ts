import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { boatUnderFeetAtSea, carriesBoat, crossByBoat, deepWaterOnTheWay, lowBankAlong, takeBoatBack } from "./boat-crossing.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { leaveBoatSeat, prepareBotForMovement } from "../../session/prepare-body.js";
import { mountedBot, openSeaBot, shifts } from "../../test-support/boat-bot.js";
import { getOff } from "./boat-get-off.js";
import { freeHeldSeat, watchServerSeat } from "./server-seat-watch.js";
import { watchVehicle } from "./vehicle-sync.js";

/** Land (stone up to y 62) with a sea from x 10 to 40 (water y 50 to 62), as Mineflayer's `blockAt` reports it. */
function seaBot(items: { name: string; count: number }[] = []): Bot {
  const blockAt = (at: Vec3) => {
    if (Math.abs(at.x) > 200 || Math.abs(at.z) > 200) return null;
    const sea = at.x >= 10 && at.x <= 40;
    if (sea && at.y >= 50 && at.y <= 62) return { name: "water", boundingBox: "empty" };
    if (at.y <= 62) return { name: "stone", boundingBox: "block" };
    return { name: "air", boundingBox: "empty" };
  };
  return { blockAt, inventory: { items: () => items } } as unknown as Bot;
}

test("deep open water on the straight way is found with the shore before it and the far shore after", () => {
  const water = deepWaterOnTheWay(seaBot(), new Vec3(0.5, 63, 0.5), { x: 60, z: 0 });
  assert.ok(water);
  assert.deepEqual([water.shore?.x, water.start.x, water.start.y, water.farShore?.x, water.length], [9, 10, 62, 41, 31]);
});

test("no deep water on a way over land, or away from the sea", () => {
  assert.equal(deepWaterOnTheWay(seaBot(), new Vec3(0.5, 63, 0.5), { x: -60, z: 0 }), null);
  assert.equal(deepWaterOnTheWay(seaBot(), new Vec3(0.5, 63, 0.5), { x: 0.5, z: 80 }), null);
});

test("any boat counts as a boat", () => {
  assert.equal(carriesBoat(seaBot([{ name: "oak_boat", count: 1 }])), true);
  assert.equal(carriesBoat(seaBot([{ name: "bamboo_raft", count: 1 }])), true);
  assert.equal(carriesBoat(seaBot([{ name: "oak_planks", count: 5 }])), false);
});

/** Sea (water y 50 to 62) up to x 40; beyond it a bank two blocks above the water, low (one above) where z >= `lowFrom`. */
function farBankBot(lowFrom: number): Bot {
  const blockAt = (at: Vec3) => {
    if (Math.abs(at.x) > 200 || Math.abs(at.z) > 200) return null;
    if (at.x <= 40) return at.y >= 50 && at.y <= 62 ? { name: at.z % 3 === 0 && at.y === 62 ? "kelp" : "water", boundingBox: "empty" } : at.y < 50 ? { name: "stone", boundingBox: "block" } : { name: "air", boundingBox: "empty" };
    const top = at.z >= lowFrom ? 63 : 64;
    return at.y <= top ? { name: "dirt", boundingBox: "block" } : { name: "air", boundingBox: "empty" };
  };
  return { blockAt } as unknown as Bot;
}

test("the far shore is left where its bank is low enough to climb out of the water: the nearest along it, or none", () => {
  // Live 2026-10-04: a bank two blocks above the water held a swimmer in it; kelp at the surface is water.
  const east = { x: 1, z: 0 };
  assert.equal(lowBankAlong(farBankBot(-200), { x: 39.5, z: 0.5 }, east, 62), 0);
  // Heading east, the heading's left (+) is toward +z.
  assert.equal(lowBankAlong(farBankBot(6), { x: 39.5, z: 0.5 }, east, 62), 6);
  assert.equal(lowBankAlong(farBankBot(200), { x: 39.5, z: 0.5 }, east, 62), null);
});

/** The sea bot standing at `feet`, with a boat entity at `boat` (none when null). */
function standingBot(feet: Vec3, boat: Vec3 | null, items: { name: string; count: number }[] = [], vehicle: unknown = null): Bot {
  const bot = seaBot(items) as unknown as Record<string, unknown>;
  const self = { id: 1, position: feet, vehicle };
  bot.entity = self;
  bot.entities = boat === null ? { 1: self } : { 1: self, 7: { id: 7, name: "oak_boat", position: boat } };
  return bot as unknown as Bot;
}

test("a boat she stands on out at sea, none carried, is found; not one she carries, rides, stands beside or on land", () => {
  // Live 2026-10-10: Vex stood on his own boat at sea a whole run, every way refused "no boat is carried".
  const atSea = new Vec3(20.5, 62.49, 0.5);
  assert.equal(boatUnderFeetAtSea(standingBot(new Vec3(20.5, 63.05, 0.5), atSea))?.id, 7);
  assert.equal(boatUnderFeetAtSea(standingBot(new Vec3(20.5, 63.05, 0.5), atSea, [{ name: "oak_boat", count: 1 }])), null);
  assert.equal(boatUnderFeetAtSea(standingBot(new Vec3(20.5, 63.05, 0.5), atSea, [], {})), null);
  assert.equal(boatUnderFeetAtSea(standingBot(new Vec3(24.5, 63.05, 0.5), atSea)), null);
  assert.equal(boatUnderFeetAtSea(standingBot(new Vec3(0.5, 63.05, 0.5), new Vec3(0.5, 62.49, 0.5))), null);
});

test("a boat taken back is broken by hand and its item picked up", async () => {
  const items: { name: string; count: number }[] = [];
  const boat = { id: 7, name: "oak_boat", position: new Vec3(20.5, 62.49, 0.5) };
  const bot = standingBot(new Vec3(20.5, 63.05, 0.5), boat.position, items) as unknown as Record<string, unknown>;
  const entities = bot.entities as Record<number, unknown>;
  bot.lookAt = async () => undefined;
  bot.attack = () => {
    delete entities[7];
    items.push({ name: "oak_boat", count: 1 });
  };
  assert.equal(await takeBoatBack(bot as unknown as Bot, boat as never, undefined, 0), true);
  assert.equal(entities[7], undefined);
});


test("a ride over open sea with no land stops at the distance asked for and stays mounted there: no ride back, the boat not broken", async () => {
  // Live 2026-10-16 (run 13): Vex explored 4 chunks north, rode 103 blocks, then back to where the boat went in.
  const { bot, raw, written, attacks, entities } = openSeaBot();
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 10);
  assert.equal(result.status, "failed");
  assert.equal(result.atSea, true);
  assert.equal(result.blocks, 10, "stops at the distance asked for, not past it");
  assert.match(result.detail, /at sea in its boat at 0 1[0-9]\b/u);
  assert.match(result.detail, /no land within 10 blocks that way/u);
  assert.doesNotMatch(result.detail, /rode back/u);
  // Still in the boat: no get-off packets, nothing broken, the boat still in the water where it stopped.
  assert.equal(raw.vehicle, entities[7]);
  assert.deepEqual(written.filter((entry) => entry.name === "entity_action"), []);
  assert.deepEqual(attacks, []);
  const moves = written.filter((entry) => entry.name === "vehicle_move");
  const last = moves[moves.length - 1]!.packet;
  // The distance is counted from where she stood (z 0.5), not from where the boat went in (3.5).
  assert.ok(Number(last.z) > 10 && Number(last.z) < 11.5, `the boat ended ${String(last.z)}: ten blocks from where she stood, not back at 3.5`);
});

test("the next movement from a bot mounted at sea takes the boat back, so the route goes in where she floats", { timeout: 30_000 }, async () => {
  const { bot, raw, attacks, written, client } = openSeaBot();
  await crossByBoat(bot, { x: 0, z: 1 }, undefined, 10);
  assert.equal(carriesBoat(bot), false);
  // The server never answers the shift (run 14): Mineflayer's physics, off since the mount, is switched on by a position.
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  await prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(shifts(written), [true, false], "shift is pressed then released to get off a boat; a jump input does not");
  assert.equal(positions.length, 1, "physics is switched back on where she stands");
  assert.deepEqual(attacks, [7], "the boat she rode is broken by hand");
  assert.equal(carriesBoat(bot), true);
  assert.equal(raw.vehicle, null);
  assert.equal(raw.entity.vehicle, null);
});

// Run 14b: a ride that ended this way (Theo: "rode back to where the boat went in") left physics off; his next navigate
// never got a tick. The server let him off and told his client nothing; physics, off since the mount, stayed off.
test("a ride that ends on the water gets off with shift held until the server lets her off, and physics comes back", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = openSeaBot({ loadedTo: 12, answerShiftMs: 600, serverClock: { frozenMs: 1_500 } });
  const order: string[] = [];
  client.on("set_passengers", () => order.push("let off"));
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const writes = raw._client.write;
  raw._client.write = (name: string, packet: Record<string, unknown>) => {
    if (name === "entity_action") order.push(packet.actionId === 0 ? "shift down" : "shift up");
    writes(name, packet);
  };
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 40);
  assert.equal(result.status, "failed");
  assert.match(result.detail, /rode back to where the boat went in/u);
  assert.deepEqual(order, ["shift down", "let off", "shift up"], "shift stays down until the server answers: a lagging server reads both at once");
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.equal(raw.vehicle, null);
  assert.equal(raw.entity.vehicle, null);
  assert.ok(written.some((entry) => entry.name === "vehicle_move"));
});

// The vanilla 1.21.4 case (Mine Labs 2026-10-17): the server lets her off and sends her nothing.
test("a ride end the server does not answer releases shift after the wait, forgets the boat and still turns physics back on", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = openSeaBot({ loadedTo: 12 });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 40);
  assert.match(result.detail, /rode back to where the boat went in/u);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.equal(raw.vehicle, null);
});


test("a ride whose get-off went unanswered says she may still be seated", { timeout: 30_000 }, async () => {
  const { bot } = openSeaBot({ loadedTo: 12, serverClock: "frozen" });
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 40, { getOffWallMs: 200 });
  assert.match(result.detail, /may still be seated/u);
});

test("a boat she could not get into is left with no listener behind and taken back", { timeout: 30_000 }, async () => {
  const { bot, raw, attacks } = openSeaBot({ neverMounts: true, serverClock: "frozen" });
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 10, { mountWallMs: 200 });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /could not get into the boat/u);
  assert.equal(raw.listenerCount("mount"), 0);
  assert.deepEqual(attacks, [7], "the launched boat is broken and picked up");
  assert.equal(carriesBoat(bot), true);
});

test("a ride stops where the server put the boat back, as a leg does", { timeout: 30_000 }, async () => {
  const { bot } = openSeaBot({ correctFromZ: 6 });
  const result = await crossByBoat(bot, { x: 0, z: 1 }, undefined, 30);
  assert.ok(result.blocks < 15, `rode ${String(result.blocks)} blocks past the correction at 6`);
});

// B4: with a second boat carried nothing broke the boat she left, and the server kept her seated while her client walked.
test("the next movement after a stay at sea with two boats carried gets her off and takes back the boat she left", { timeout: 30_000 }, async () => {
  const world = openSeaBot({ boatsCarried: 2 });
  await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 10);
  assert.equal(world.carried.length, 1, "one of the two boats is the one she sits in");
  await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(world.attacks, [7], "the boat she left is hit until it breaks, though another boat is carried");
  assert.equal(world.carried.length, 2);
  assert.equal(world.raw.vehicle, null);
});

describe("a seat the server still holds", () => {
  /** She rode 10 blocks and was let off by a server that ignores the shift; her client then walked 60 blocks on. */
  async function heldAfterAStay(options: { readonly neverFreed?: boolean } = {}) {
    const world = openSeaBot({ ignoresShift: true });
    const watch = watchServerSeat(world.bot);
    await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 10);
    await getOff(world.bot, { wallMs: 400 });
    world.raw.entity.position = new Vec3(0.5, 63, 70.5);
    // The boat breaks but the server sends nothing back.
    if (options.neverFreed) world.raw.attack = () => { world.attacks.push(7); delete world.entities[7]; world.carried.push({ name: "oak_boat", count: 1 }); };
    return { ...world, watch };
  }

  test("a held seat is freed by breaking the boat, then navigate goes on", { timeout: 30_000 }, async () => {
    const { bot, raw, attacks, written, watch, carried } = await heldAfterAStay();
    assert.notEqual(watch.heldAt(), null, "her client is 60 blocks from where the server holds her");
    await prepareBotForMovement(bot, { cancel: () => undefined } as unknown as NavigationRuntime);
    assert.deepEqual(attacks, [7], "breaking the boat ejects its rider on the server");
    assert.equal(watch.heldAt(), null, "the server answered with a position");
    assert.equal(carried.length, 1, "the boat is carried again");
    assert.equal(raw.vehicle, null);
    assert.deepEqual(shifts(written).slice(-2), [true, false], "shift is held while the boat is hit and released after");
    watch.stop();
  });

  test("a seat the server never frees fails the preparation with where it holds her, and records nothing shared", { timeout: 30_000 }, async () => {
    const { bot, watch } = await heldAfterAStay({ neverFreed: true });
    await assert.rejects(
      freeHeldSeat(bot, { wallMs: 300 }),
      /\[SERVER_HELD_POSITION\] The server still holds you at -?\d+ -?\d+ -?\d+ \(seated in a boat there\); movement was stopped\./u,
    );
    watch.stop();
  });
});

describe("a ride that is interrupted stays seated (ACT-01)", () => {
  /** Aborts `controller` once `count` vehicle_move packets were written (a ride cancelled mid-water). */
  function abortAfterMoves(world: ReturnType<typeof openSeaBot>, count: number, reason: Error): AbortController {
    const controller = new AbortController();
    const write = world.client.write;
    let moves = 0;
    world.client.write = (name: string, packet: Record<string, unknown>) => {
      write(name, packet);
      if (name === "vehicle_move" && (moves += 1) === count) controller.abort(reason);
    };
    return controller;
  }
  const stillSeated = (world: ReturnType<typeof openSeaBot>) => {
    assert.equal(world.raw.vehicle, world.entities[7], "still in the boat");
    assert.equal(world.written.some((entry) => entry.name === "player_input" || entry.name === "entity_action"), false, "no shift");
    assert.deepEqual(world.attacks, [], "the boat is not hit");
    const moves = world.written.filter((entry) => entry.name === "vehicle_move").map((entry) => JSON.stringify(entry.packet));
    assert.equal(new Set(moves.slice(-4)).size, 1, "the last 4 moves are the same stopped place");
  };

  test("a ride cancelled over deep water stops the boat and stays seated: no shift, no hit, the boat where it stopped", { timeout: 30_000 }, async () => {
    const world = openSeaBot();
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, controller.signal, 100);
    assert.equal(result.status, "failed");
    assert.equal(result.atSea, true);
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat at -?\d+ -?\d+/u);
    assert.match(result.detail, /cancelled by the brain/u);
    stillSeated(world);
  });

  test("a ride cancelled in shallows stays seated too", { timeout: 30_000 }, async () => {
    const world = openSeaBot({ waterDepth: 2 });
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, controller.signal, 100);
    assert.equal(result.status, "failed");
    assert.equal(result.atSea, false);
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat at -?\d+ -?\d+/u);
    stillSeated(world);
  });

  test("a cancel during the ride back still stays seated", { timeout: 30_000 }, async () => {
    const world = openSeaBot({ loadedTo: 12 });
    // The water ahead is not loaded at z 9: about 17 moves out, then the ride turns back; the 25th move is on the way back.
    const controller = abortAfterMoves(world, 25, new Error("cancelled by the brain"));
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, controller.signal, 40);
    assert.equal(result.interrupted, true);
    assert.match(result.detail, /still seated in its boat/u);
    stillSeated(world);
  });

  test("a death during the ride ends it at once: no stop moves for a boat she left, no get-off", { timeout: 30_000 }, async () => {
    const world = openSeaBot();
    const write = world.client.write;
    let moves = 0;
    let movesAtDeath = -1;
    world.client.write = (name: string, packet: Record<string, unknown>) => {
      write(name, packet);
      if (name === "vehicle_move" && (moves += 1) === 10) {
        movesAtDeath = world.written.filter((entry) => entry.name === "vehicle_move").length;
        world.raw.emit("death");
      }
    };
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 100);
    assert.equal(result.status, "failed");
    assert.match(result.detail, /died during the ride/u);
    assert.equal(world.written.filter((entry) => entry.name === "vehicle_move").length, movesAtDeath, "no move after the death");
    assert.equal(world.written.some((entry) => entry.name === "player_input" || entry.name === "entity_action"), false);
    assert.equal(world.raw.listenerCount("death"), 0, "no death listener is left");
    assert.equal(world.client.listenerCount("vehicle_move"), 0);
  });

  test("a seat the vehicle shows after the wait gave up is still a ride, never hit", { timeout: 30_000 }, async () => {
    // The server seated her (bot.vehicle shows it) but the `mount` event only came after the 100 ms wait.
    const world = openSeaBot({ mountEventAfterMs: 400 });
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 10, { mountWallMs: 100 });
    assert.equal(result.atSea, true, "the ride went on and stayed at sea");
    assert.deepEqual(world.attacks, [], "the boat she sits in is not hit");
    assert.equal(world.raw.vehicle, world.entities[7]);
  });

  test("the next movement takes back the boat she just left, in shallows too", { timeout: 30_000 }, async () => {
    const world = openSeaBot({ waterDepth: 2 });
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    await crossByBoat(world.bot, { x: 0, z: 1 }, controller.signal, 100);
    assert.deepEqual(shifts(world.written), [], "a cancelled ride does not get off");
    await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime);
    assert.deepEqual(shifts(world.written), [true, false], "the preparation gets off with shift");
    assert.deepEqual(world.attacks, [7]);
    assert.equal(carriesBoat(world.bot), true);
    assert.equal(world.raw.vehicle, null);
  });

  test("after a cancelled ride at sea, prepareBotForMovement then a crossing reaches the far side", { timeout: 60_000 }, async () => {
    const world = openSeaBot({ landFromZ: 40 });
    const controller = abortAfterMoves(world, 20, new Error("cancelled by the brain"));
    await crossByBoat(world.bot, { x: 0, z: 1 }, controller.signal, 100);
    await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime);
    assert.equal(carriesBoat(world.bot), true);
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 100);
    assert.equal(result.status, "crossed", result.detail);
  });

  test("a preparation cancelled between hits stops hitting: the boat stays, the result says so", { timeout: 30_000 }, async () => {
    const controller = new AbortController();
    const boat = { id: 7, name: "oak_boat", position: new Vec3(20.5, 62.49, 0.5) };
    const bot = standingBot(new Vec3(20.5, 63.05, 0.5), boat.position) as unknown as Record<string, unknown>;
    const attacks: number[] = [];
    bot.lookAt = async () => undefined;
    // A boat that takes many hits: the first one cancels the preparation.
    bot.attack = (target: { id: number }) => {
      attacks.push(target.id);
      controller.abort(new Error("cancelled"));
    };
    const startedAt = performance.now();
    assert.equal(await takeBoatBack(bot as unknown as Bot, boat as never, controller.signal, 0), false);
    assert.deepEqual(attacks, [7], "one hit, then it stops");
    assert.ok(performance.now() - startedAt < 1_000, "no more hits and no swim after the cancel");
  });
});

test("a cancel during the swim after the boat item ends it within 200 ms", { timeout: 30_000 }, async () => {
  // The boat broke and its item floated off: swum after, up to 15 s; a cancel ends the swim at its next look.
  const controller = new AbortController();
  const boat = { id: 7, name: "oak_boat", position: new Vec3(20.5, 62.49, 0.5) };
  const bot = standingBot(new Vec3(20.5, 63.05, 0.5), boat.position) as unknown as Record<string, unknown>;
  const entities = bot.entities as Record<number, unknown>;
  bot.lookAt = async () => undefined;
  bot.setControlState = () => undefined;
  bot.clearControlStates = () => undefined;
  bot.attack = () => {
    delete entities[7];
    entities[9] = { id: 9, name: "item", position: new Vec3(24.5, 62.5, 0.5), getDroppedItem: () => ({ name: "oak_boat" }) };
  };
  // The one hit and its 300 ms pause come first: the cancel lands while the swim is on.
  setTimeout(() => controller.abort(new Error("cancelled")), 500);
  const startedAt = performance.now();
  assert.equal(await takeBoatBack(bot as unknown as Bot, boat as never, controller.signal, 0), false);
  assert.ok(performance.now() - startedAt < 700, `the swim ended ${String(Math.round(performance.now() - startedAt - 500))} ms after the cancel`);
});

test("the next preparation after a respawn sends no shift", { timeout: 30_000 }, async () => {
  const world = openSeaBot();
  const stop = watchVehicle(world.bot);
  await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 10);
  assert.equal(world.raw.vehicle, world.entities[7], "seated at sea");
  world.raw.emit("death");
  world.raw.emit("respawn");
  await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime);
  assert.deepEqual(shifts(world.written), [], "she rides nothing: no get-off, no shift");
  stop();
});

describe("navigate rides on from the seat (B5)", () => {
  test("a crossing that starts seated rides on: no launch, no mount, no hit", { timeout: 30_000 }, async () => {
    const world = await mountedBot();
    const placed = world.carried.length;
    const result = await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 10);
    assert.equal(result.atSea, true, "the ride went on and stayed at sea");
    assert.equal(world.carried.length, placed, "no second boat was launched");
    assert.equal(world.raw.vehicle, world.entities[7], "the same boat");
    assert.deepEqual(world.attacks, []);
    assert.deepEqual(shifts(world.written), []);
    assert.ok(world.written.some((entry) => entry.name === "vehicle_move"));
  });

  test("prepareBotForMovement with keepBoatSeat stays seated: no shift", { timeout: 30_000 }, async () => {
    const world = await mountedBot();
    await prepareBotForMovement(world.bot, { cancel: () => undefined } as unknown as NavigationRuntime, undefined, { keepBoatSeat: true });
    assert.equal(world.raw.vehicle, world.entities[7]);
    assert.deepEqual(shifts(world.written), []);
    assert.deepEqual(world.attacks, []);
  });

  test("leaveBoatSeat in shallows takes back the boat just left", { timeout: 30_000 }, async () => {
    const world = await mountedBot({ waterDepth: 2 });
    await leaveBoatSeat(world.bot);
    assert.deepEqual(shifts(world.written), [true, false]);
    assert.deepEqual(world.attacks, [7]);
    assert.equal(world.raw.vehicle, null);
    assert.equal(world.carried.length, 2, "the boat she carried and the one taken back");
  });
});

test("a crossing that starts seated and reaches the far bank takes the same boat back", { timeout: 60_000 }, async () => {
  const world = await mountedBot({ landFromZ: 40 });
  const result = await crossByBoat(world.bot, { x: 0, z: 1 }, undefined, 100);
  assert.equal(result.status, "crossed", result.detail);
  assert.deepEqual(world.attacks, [7], "the boat she rode is broken at the bank");
  assert.equal(world.carried.length, 2, "the boat she carried and the one she rode");
  assert.equal(world.raw.vehicle, null);
});

test("a boat taken back is swum after when its item floated off, though another boat is carried", { timeout: 30_000 }, async () => {
  // Live 2026-10-20 (boat-at-sea-two-boats scenario): with a second boat carried, "no boat carried" never held, so the
  // item that drifted off the bank was never swum after and the ridden boat was lost.
  const items = [{ name: "oak_boat", count: 1 }];
  const boat = { id: 7, name: "oak_boat", position: new Vec3(20.5, 62.49, 0.5) };
  const bot = standingBot(new Vec3(20.5, 63.05, 0.5), boat.position, items) as unknown as Record<string, unknown>;
  const entities = bot.entities as Record<number, unknown>;
  bot.lookAt = async () => undefined;
  bot.clearControlStates = () => undefined;
  bot.attack = () => {
    delete entities[7];
    entities[9] = { id: 9, name: "item", position: new Vec3(24.5, 62.5, 0.5), getDroppedItem: () => ({ name: "oak_boat" }) };
  };
  // Swimming toward the item picks it up.
  bot.setControlState = (control: string, state: boolean) => {
    if (control === "forward" && state && entities[9] !== undefined) {
      delete entities[9];
      items.push({ name: "oak_boat", count: 1 });
    }
  };
  assert.equal(await takeBoatBack(bot as unknown as Bot, boat as never, undefined, 0), true);
  assert.equal(items.length, 2, "the item was swum after and picked up");
});
