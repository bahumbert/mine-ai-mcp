import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { boatUnderFeetAtSea, carriesBoat, crossByBoat, deepWaterOnTheWay, lowBankAlong, takeBoatBack } from "./boat-crossing.js";
import { EventEmitter } from "node:events";
import type { NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";

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

/**
 * A bot at the edge of a flat open sea (water y 50 to 62, stone under it), with one boat carried; the server is played
 * by the mock: it puts the boat in the water when the item is used, follows `vehicle_move` and records every packet.
 */
function openSeaBot(options: { readonly loadedTo?: number; readonly answerShiftMs?: number } = {}) {
  const carried = [{ name: "oak_boat", count: 1 }];
  const written: { name: string; packet: Record<string, unknown> }[] = [];
  const attacks: number[] = [];
  const self = { id: 1, position: new Vec3(0.5, 63, 0.5), yaw: 0, pitch: 0, onGround: false, vehicle: null as unknown };
  const entities: Record<number, unknown> = { 1: self };
  const client = Object.assign(new EventEmitter(), {
    write: (name: string, packet: Record<string, unknown>) => {
      written.push({ name, packet });
      const boat = entities[7] as { position: Vec3 } | undefined;
      // A server that answers the get-off (vanilla 1.21.4 does not): a passenger list for the boat without her.
      const shift = name === "player_input" && (packet.inputs as { shift: boolean }).shift;
      if (shift && options.answerShiftMs !== undefined && boat !== undefined) {
        setTimeout(() => client.emit("set_passengers", { entityId: 7, passengers: [] }), options.answerShiftMs);
      }
      if (name === "vehicle_move" && boat !== undefined) boat.position = new Vec3(Number(packet.x), Number(packet.y), Number(packet.z));
    },
  });
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    entities,
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
      carried.length = 0;
      entities[7] = { id: 7, name: "oak_boat", position: new Vec3(0.5, 62.5, 3.5), passengers: [] };
    },
    deactivateItem: () => undefined,
    mount: (boat: unknown) => {
      bot.vehicle = boat;
      self.vehicle = boat;
      setImmediate(() => bot.emit("mount"));
    },
    // Mineflayer emits no "dismount" for a passenger list that no longer names the bot.
    dismount: () => undefined,
    attack: (target: { id: number }) => {
      attacks.push(target.id);
      delete entities[target.id];
      carried.push({ name: "oak_boat", count: 1 });
    },
    clearControlStates: () => undefined,
    closeWindow: () => undefined,
    currentWindow: null,
    isSleeping: false,
    supportFeature: (feature: string) => feature === "newPlayerInputPacket",
  });
  return { bot: bot as unknown as Bot, raw: bot, written, attacks, entities, client };
}

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
  const inputs = written.filter((entry) => entry.name === "player_input").map((entry) => (entry.packet.inputs as { shift: boolean }).shift);
  assert.deepEqual(inputs, [true, false], "shift is pressed then released to get off a boat; a jump input does not");
  assert.equal(positions.length, 1, "physics is switched back on where she stands");
  assert.deepEqual(attacks, [7], "the boat she rode is broken by hand");
  assert.equal(carriesBoat(bot), true);
  assert.equal(raw.vehicle, null);
  assert.equal(raw.entity.vehicle, null);
});

// Run 14b: a ride that ended this way (Theo: "rode back to where the boat went in") left physics off; his next navigate
// never got a tick. The server let him off and told his client nothing; physics, off since the mount, stayed off.
test("a ride that ends on the water gets off with shift held until the server lets her off, and physics comes back", { timeout: 30_000 }, async () => {
  const { bot, raw, written, client } = openSeaBot({ loadedTo: 12, answerShiftMs: 600 });
  const order: string[] = [];
  client.on("set_passengers", () => order.push("let off"));
  const positions: unknown[] = [];
  client.on("position", (packet: unknown) => positions.push(packet));
  const writes = raw._client.write;
  raw._client.write = (name: string, packet: Record<string, unknown>) => {
    if (name === "player_input") order.push((packet.inputs as { shift: boolean }).shift ? "shift down" : "shift up");
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
  const inputs = written.filter((entry) => entry.name === "player_input").map((entry) => (entry.packet.inputs as { shift: boolean }).shift);
  assert.deepEqual(inputs, [true, false]);
  assert.equal(positions.length, 1, "physics is switched back on where she is");
  assert.equal(raw.vehicle, null);
});
