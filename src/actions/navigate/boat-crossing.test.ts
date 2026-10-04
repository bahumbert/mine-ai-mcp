import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { carriesBoat, deepWaterOnTheWay, lowBankAlong } from "./boat-crossing.js";

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
