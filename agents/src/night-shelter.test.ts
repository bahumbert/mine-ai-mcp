import assert from "node:assert/strict";
import test from "node:test";
import { coverOver, roofBlock, shelterBox, shelterSpot } from "./night-shelter.ts";
import { areaKey, type BlockArea, type ProtectedArea } from "./runtime-client.ts";

const KINDS = {
  air: { tool: null, solid: false, harvest: null },
  short_grass: { tool: null, solid: false, harvest: null },
  water: { tool: null, solid: false, harvest: null },
  grass_block: { tool: "shovel" as const, solid: true, harvest: null },
  dirt: { tool: "shovel" as const, solid: true, harvest: null },
  stone: { tool: "pickaxe" as const, solid: true, harvest: ["wooden_pickaxe"] },
  bedrock: { tool: null, solid: true, harvest: null },
};

/** Flat ground: grass at y 63, dirt to 60, stone under; air above. `change` edits single cells. */
function ground(change: Record<string, string> = {}): BlockArea {
  const blocks = new Map<string, string>();
  const box = shelterBox({ x: 0, y: 64, z: 0 });
  for (let x = box.min.x - 4; x <= box.max.x + 4; x += 1) {
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      for (let z = box.min.z - 4; z <= box.max.z + 4; z += 1) {
        blocks.set(areaKey(x, y, z), y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
      }
    }
  }
  for (const [key, name] of Object.entries(change)) blocks.set(key, name);
  return { blocks, kinds: KINDS };
}

test("on flat ground the hole is dug where she stands, roofed against the ground beside it", () => {
  assert.deepEqual(shelterSpot(ground(), { x: 0.5, y: 64, z: 0.5 }, []), { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west" });
});

test("a cave under her, an opening beside the hole, bedrock or a protected area move the hole aside", () => {
  // A cave cell right under the hole's floor: the hole would open into it.
  const cave = shelterSpot(ground({ [areaKey(0, 60, 0)]: "air" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.ok(cave !== null);
  assert.notDeepEqual([cave.x, cave.z], [0, 0]);
  // Water beside where she would stand in the hole.
  const wet = shelterSpot(ground({ [areaKey(1, 61, 0)]: "water" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.notDeepEqual([wet?.x, wet?.z], [0, 0]);
  const hard = shelterSpot(ground({ [areaKey(0, 62, 0)]: "bedrock" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.notDeepEqual([hard?.x, hard?.z], [0, 0]);
  const house: ProtectedArea = { regionId: 1, label: "house", owner: "Ayla", min: { x: -1, y: 60, z: -1 }, max: { x: 1, y: 70, z: 1 } };
  const spot = shelterSpot(ground(), { x: 0.5, y: 64, z: 0.5 }, [house]);
  assert.ok(spot !== null && (Math.abs(spot.x) > 1 || Math.abs(spot.z) > 1));
});

test("no hole anywhere near on open water", () => {
  const sea: Record<string, string> = {};
  const box = shelterBox({ x: 0, y: 64, z: 0 });
  for (let x = box.min.x; x <= box.max.x; x += 1) for (let z = box.min.z; z <= box.max.z; z += 1) for (let y = 58; y <= 63; y += 1) sea[areaKey(x, y, z)] = "water";
  assert.equal(shelterSpot(ground(sea), { x: 0.5, y: 64, z: 0.5 }, []), null);
});

test("rock or a roof over her head is cover, open sky or leaves are not", () => {
  const at = { x: 0.5, y: 64, z: 0.5 };
  const kinds = { ...KINDS, oak_leaves: { tool: null, solid: true, harvest: null } };
  const column = (names: Record<number, string>): ReturnType<typeof ground> => ({ blocks: new Map(Object.entries(names).map(([y, name]) => [areaKey(0, Number(y), 0), name])), kinds });
  assert.equal(coverOver(column({ 66: "air", 70: "air" }), at), false);
  assert.equal(coverOver(column({ 66: "air", 72: "oak_leaves" }), at), false);
  assert.equal(coverOver(column({ 66: "air", 80: "stone" }), at), true);
  // Higher than 24 blocks over her head: open sky as far as the night goes.
  assert.equal(coverOver(column({ 95: "stone" }), at), false);
});

test("the roof is a common carried block, else planks or a log, never sand", () => {
  assert.equal(roofBlock([{ name: "sand" }, { name: "oak_planks" }, { name: "cobblestone" }]), "cobblestone");
  assert.equal(roofBlock([{ name: "sand" }, { name: "spruce_log" }]), "spruce_log");
  assert.equal(roofBlock([{ name: "sand" }, { name: "gravel" }]), null);
});
