import assert from "node:assert/strict";
import test, { describe } from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { boatUnderFeetAtSea, carriesBoat, crossByBoat, deepWaterOnTheWay, lowBankAlong, takeBoatBack } from "./boat-crossing.js";
import { getOff } from "./boat-get-off.js";
import { EventEmitter } from "node:events";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { freeHeldSeat, watchServerSeat } from "./server-seat-watch.js";

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

type ServerClock = "ticking" | "frozen" | { readonly frozenMs: number } | { readonly burstOnPress: number };

/**
 * The world age the client reads: 20 ticks per 50 ms (a jump of 20, as a server catching up reports it); "frozen" never
 * moves, `frozenMs` stands still that long and then jumps 200, `burstOnPress` jumps that many ticks at the shift press
 * (a client whose event loop was blocked reads its queued packets late). The clock counts from the press.
 */
function worldClock(clock: ServerClock) {
  let startedAt = performance.now();
  let pressed = false;
  const time = {
    get age() {
      const elapsed = performance.now() - startedAt;
      if (clock === "frozen") return 1_000;
      if (clock === "ticking") return 1_000 + Math.floor(elapsed / 50) * 20;
      if ("burstOnPress" in clock) return 1_000 + (pressed ? clock.burstOnPress : 0) + Math.floor(elapsed / 50) * 20;
      return 1_000 + (elapsed < clock.frozenMs ? 0 : 200 + Math.floor((elapsed - clock.frozenMs) / 50) * 20);
    },
  };
  return { time, press: () => { startedAt = performance.now(); pressed = true; } };
}

/**
 * Whether a 1.21.4 server still has her seated. It reads the shift from entity_action only (player_input is for minecart
 * steering), and only at a server tick (50 ms): a press released within the same tick does nothing. It tells the rider
 * nothing. Breaking the boat she sits in ejects her. `ignoresShift` is a server that never reads it (a held seat).
 */
function seatOnTheServer(ignoresShift: boolean) {
  let seated = false;
  let pressedTick: number | null = null;
  const tick = () => Math.floor(performance.now() / 50);
  const heldATick = () => pressedTick !== null && tick() > pressedTick && !ignoresShift;
  return {
    mount: () => { seated = true; },
    press: () => { pressedTick = tick(); },
    release: () => {
      if (heldATick()) seated = false;
      pressedTick = null;
    },
    /** The boat she sits in broke: true when it was holding her. */
    eject: () => {
      const was = seated;
      seated = false;
      return was;
    },
    seated: () => seated && !heldATick(),
  };
}

/**
 * A bot at the edge of a flat open sea (water y 50 to 62, stone under it), with one boat carried; the server is played
 * by the mock: it puts the boat in the water when the item is used, follows `vehicle_move` and records every packet.
 */
function openSeaBot(options: { readonly loadedTo?: number; readonly answerShiftMs?: number; readonly serverClock?: ServerClock; readonly neverMounts?: boolean; readonly correctFromZ?: number; readonly boatsCarried?: number; readonly ignoresShift?: boolean } = {}) {
  const clock = worldClock(options.serverClock ?? "ticking");
  const seat = seatOnTheServer(options.ignoresShift === true);
  const carried = Array.from({ length: options.boatsCarried ?? 1 }, () => ({ name: "oak_boat", count: 1 }));
  const written: { name: string; packet: Record<string, unknown>; at: number }[] = [];
  const attacks: number[] = [];
  const self = { id: 1, position: new Vec3(0.5, 63, 0.5), yaw: 0, pitch: 0, onGround: false, vehicle: null as unknown };
  const entities: Record<number, unknown> = { 1: self };
  const client = Object.assign(new EventEmitter(), {
    write: (name: string, packet: Record<string, unknown>) => {
      written.push({ name, packet, at: performance.now() });
      const boat = entities[7] as { position: Vec3 } | undefined;
      if (name === "entity_action" && packet.actionId === 1) seat.release();
      if (name === "entity_action" && packet.actionId === 0) {
        seat.press();
        clock.press();
        if (options.answerShiftMs !== undefined && boat !== undefined) {
          setTimeout(() => client.emit("set_passengers", { entityId: 7, passengers: [] }), options.answerShiftMs);
        }
      }
      if (name === "vehicle_move" && boat !== undefined) boat.position = new Vec3(Number(packet.x), Number(packet.y), Number(packet.z));
      // The server puts the boat back when a move runs it into something.
      if (name === "vehicle_move" && options.correctFromZ !== undefined && Number(packet.z) > options.correctFromZ) {
        setImmediate(() => client.emit("vehicle_move", { x: Number(packet.x), y: Number(packet.y), z: options.correctFromZ }));
      }
    },
  });
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    entities,
    time: clock.time,
    vehicle: null as unknown,
    _client: client,
    inventory: { items: () => carried },
    blockAt: (at: Vec3) => {
      if (options.loadedTo !== undefined && at.z > options.loadedTo) return null;
      if (at.y < 50) return { name: "stone", boundingBox: "block" };
      if (at.y <= 62) return { name: "water", boundingBox: "empty" };
      return { name: "air", boundingBox: "empty" };
    },
    equip: async () => undefined,
    dig: async () => undefined,
    lookAt: async () => undefined,
    activateItem: () => {
      carried.shift();
      entities[7] = { id: 7, name: "oak_boat", position: new Vec3(0.5, 62.5, 3.5), passengers: [] };
    },
    deactivateItem: () => undefined,
    mount: (boat: unknown) => {
      bot.vehicle = boat;
      self.vehicle = boat;
      seat.mount();
      if (!options.neverMounts) setImmediate(() => bot.emit("mount"));
    },
    // Mineflayer emits no "dismount" for a passenger list that no longer names the bot.
    dismount: () => undefined,
    attack: (target: { id: number }) => {
      attacks.push(target.id);
      const top = (entities[target.id] as { position: Vec3 }).position;
      delete entities[target.id];
      carried.push({ name: "oak_boat", count: 1 });
      // The server brings the ejected rider a position.
      if (seat.eject()) setImmediate(() => client.emit("position", { x: top.x, y: top.y + 0.5, z: top.z, yaw: 0, pitch: 0, flags: { x: false, y: false, z: false, yaw: false, pitch: false }, teleportId: 5 }));
    },
    clearControlStates: () => undefined,
    closeWindow: () => undefined,
    currentWindow: null,
    isSleeping: false,
    version: "1.21.4",
  });
  return { bot: bot as unknown as Bot, raw: bot, written, attacks, entities, client, carried, serverSeated: seat.seated };
}

/** The shift presses (true) and releases (false) written, in order: a 1.21.4 server reads them from entity_action. */
const shifts = (written: readonly { name: string; packet: Record<string, unknown> }[]): boolean[] => written.filter((entry) => entry.name === "entity_action").map((entry) => entry.packet.actionId === 0);

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

/** Mounted in the mock's boat, as a ride leaves her. */
async function mountedBot(options: Parameters<typeof openSeaBot>[0] = {}) {
  const world = openSeaBot(options);
  const boat = { id: 7, name: "oak_boat", position: new Vec3(0.5, 62.5, 3.5), passengers: [] };
  world.entities[7] = boat;
  world.raw.mount(boat);
  await new Promise((resolve) => setImmediate(resolve));
  return world;
}

// Review focus 4 (run 15 L): the server seconds behind.
test("a get-off holds shift while the world age stands still, and lets go only once it moved 40 ticks", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: { frozenMs: 800 } });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const startedAt = performance.now();
  const result = await getOff(bot);
  assert.ok(performance.now() - startedAt >= 700, "shift stayed down while the server clock was stopped");
  assert.equal(result.answered, true, "the server clock moved past the send: it handled the shift");
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 1);
  assert.equal(raw.vehicle, null);
});

test("a get-off the server clock never answers fails on the wall clock, with shift released and physics on", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: "frozen" });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const result = await getOff(bot, { wallMs: 300 });
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 1, "physics is back on");
  assert.equal(raw.vehicle, null, "the vehicle is forgotten");
  assert.equal(raw.entity.vehicle, null);
});

test("a death during the get-off ends it at once, shift released, nothing resumed", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = await mountedBot({ serverClock: "frozen" });
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  setTimeout(() => raw.emit("death"), 50);
  const startedAt = performance.now();
  const result = await getOff(bot, { wallMs: 5_000 });
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(result.answered, false);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(positions.length, 0);
  assert.equal(raw.listenerCount("dismount") + raw.listenerCount("death") + raw.listenerCount("respawn") + raw.listenerCount("forcedMove"), 0, "no listener is left");
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

// Backlog 76 (Cleo, run 16): a 1.21.4 server reads the shift from entity_action, never from player_input.
test("a get-off on 1.21.4 holds entity_action shift until the server lets her off, and writes no player_input", { timeout: 30_000 }, async () => {
  const { bot, written, serverSeated } = await mountedBot();
  assert.equal(serverSeated(), true);
  const result = await getOff(bot);
  assert.deepEqual(shifts(written), [true, false]);
  assert.equal(written.some((entry) => entry.name === "player_input"), false);
  assert.equal(serverSeated(), false, "the server read the held shift at one of its ticks");
  assert.equal(result.answered, true);
  assert.equal(result.ended, "world_age");
});

test("a press and release read in one server tick do not let her off: the release waits for the world age", { timeout: 30_000 }, async () => {
  const { bot, written, serverSeated } = await mountedBot({ serverClock: { frozenMs: 800 } });
  await getOff(bot);
  const [down, up] = written.filter((entry) => entry.name === "entity_action");
  assert.ok(up!.at - down!.at >= 700, `shift was released ${String(up!.at - down!.at)} ms after the press, before the server clock moved`);
  assert.equal(serverSeated(), false);
});

test("a world age that jumps 40 in the first 250 ms after the press is not the server's answer", { timeout: 30_000 }, async () => {
  // Run 16: the server ran ~30 % behind and Cleo's get-off "answered" in ~1.1 s: a client whose event loop was blocked
  // reads its queued time packets after the press, so the age it sees jump says nothing about the server reading the shift.
  const { bot, written, serverSeated } = await mountedBot({ serverClock: { burstOnPress: 40 } });
  await getOff(bot);
  const [down, up] = written.filter((entry) => entry.name === "entity_action");
  assert.ok(up!.at - down!.at >= 300, `shift was released ${String(up!.at - down!.at)} ms after the press: the burst counted as 40 server ticks`);
  assert.equal(serverSeated(), false);
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
