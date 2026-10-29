import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import {
  horizontalOffset,
  offsetBlocks,
  placeShapes,
  vanillaPositionSeed,
  type OffsetRegistry,
} from "./block-offset.js";

const require = createRequire(import.meta.url);
const minecraftData = require("minecraft-data") as (version: string) => OffsetRegistry & {
  readonly blocksByStateId: Record<number, { readonly name: string }>;
};

const nibble = (n: number): number => (Math.fround(n / 15) - 0.5) * 0.5;
const close = (actual: number, expected: number, epsilon = 1e-9): void =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} vs ${expected}`);

test("the position seed of the origin is zero and depends on y", () => {
  assert.equal(vanillaPositionSeed(0, 0, 0), 0n);
  assert.notEqual(vanillaPositionSeed(191, 78, 292), vanillaPositionSeed(191, 0, 292));
});

test("bamboo offsets match vanilla's XZ function (Java arithmetic)", () => {
  const rows: readonly (readonly [number, number, number, number])[] = [
    [0, 0, -0.25, -0.25],
    [191, 292, nibble(14), nibble(12)],
    [191, 292, 0.216667, 0.15],
    [188, 292, 0.15, -0.05],
    [194, 292, 0.05, -0.183333],
    [191, 289, -0.116667, 0.183333],
    [191, 295, 0.25, -0.116667],
    [-1, -1, -0.083333, -0.083333],
    [-700, -700, -0.05, 0.083333],
    [-697, -700, 0.25, 0.116667],
    [-700, -697, -0.05, 0.25],
    [1000, 5, 0.183333, -0.05],
  ];
  for (const [x, z, dx, dz] of rows) {
    const offset = horizontalOffset(0.25, x, z);
    assert.ok(Math.abs(offset.x - dx) < 1e-6, `bamboo ${x},${z} x ${offset.x} vs ${dx}`);
    assert.ok(Math.abs(offset.z - dz) < 1e-6, `bamboo ${x},${z} z ${offset.z} vs ${dz}`);
  }
});

test("pointed dripstone offsets clamp to its smaller maximum on both signs", () => {
  const rows: readonly (readonly [number, number, number, number])[] = [
    [0, 0, -0.125, -0.125],
    [191, 292, 0.125, 0.125],
    [-694, -700, -0.116667, -0.016667],
    [-700, -694, -0.016667, 0.125],
    [-691, -700, -0.016667, -0.125],
    [1000, 5, 0.125, -0.05],
  ];
  for (const [x, z, dx, dz] of rows) {
    const offset = horizontalOffset(0.125, x, z);
    assert.ok(Math.abs(offset.x - dx) < 1e-6, `dripstone ${x},${z} x ${offset.x} vs ${dx}`);
    assert.ok(Math.abs(offset.z - dz) < 1e-6, `dripstone ${x},${z} z ${offset.z} vs ${dz}`);
  }
});

test("the offset takes no y: the whole column shares it", () => {
  assert.equal(horizontalOffset.length, 3);
});

test("every nibble value is reached on both axes and the result stays within the maximum", () => {
  const seenX = new Set<number>();
  const seenZ = new Set<number>();
  for (let x = -32; x < 32; x += 1) {
    for (let z = -32; z < 32; z += 1) {
      const offset = horizontalOffset(0.25, x, z);
      assert.ok(Math.abs(offset.x) <= 0.25 && Math.abs(offset.z) <= 0.25);
      seenX.add(Math.round((offset.x / 0.5 + 0.5) * 15));
      seenZ.add(Math.round((offset.z / 0.5 + 0.5) * 15));
    }
  }
  assert.equal(seenX.size, 16);
  assert.equal(seenZ.size, 16);
});

const VERSIONS = ["1.20.4", "1.21.1", "1.21.4", "1.21.5", "1.21.8", "1.21.11"] as const;

test("the game data names exactly bamboo and pointed dripstone as offset blocks in every version", () => {
  for (const version of VERSIONS) {
    const found = Object.fromEntries(offsetBlocks(minecraftData(version)));
    assert.deepEqual(found, { bamboo: 0.25, pointed_dripstone: 0.125 }, `${version}: found ${Object.keys(found).join(", ")}`);
  }
});

const fakeRegistry = (blocks: Record<string, number | number[]>, shapes: Record<string, number[][]>): OffsetRegistry => ({
  blockCollisionShapes: { blocks, shapes },
});

test("a block with one state shifted on x only is not an offset block", () => {
  const registry = fakeRegistry({ odd: 1 }, { 1: [[0.1, 0, 0.3, 0.4, 1, 0.7]] });
  assert.equal(offsetBlocks(registry).size, 0);
});

test("a block whose states are shifted by different amounts is not an offset block", () => {
  const registry = fakeRegistry(
    { odd: [1, 2] },
    { 1: [[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]], 2: [[0.3125, 0, 0.3125, 0.5, 1, 0.5]] },
  );
  assert.equal(offsetBlocks(registry).size, 0);
});

test("a block with only empty states is not an offset block", () => {
  assert.equal(offsetBlocks(fakeRegistry({ air: 0 }, { 0: [] })).size, 0);
});

test("a registry without collision data gives an empty map, the same one each time", () => {
  const registry: OffsetRegistry = {};
  assert.equal(offsetBlocks(registry).size, 0);
  assert.equal(offsetBlocks(registry), offsetBlocks(registry));
});

test("the same registry object gives the same map object", () => {
  const registry = minecraftData("1.21.4");
  assert.equal(offsetBlocks(registry), offsetBlocks(registry));
});

test("placing bamboo's data box at Ayla's cell gives the server's box and leaves the input alone", () => {
  const data = [[0.15625, 0, 0.15625, 0.34375, 1, 0.34375]];
  const copy = structuredClone(data);
  const placed = placeShapes(data, 0.25, 191, 292);
  const expected = [0.15625 + 0.25 + nibble(14), 0, 0.15625 + 0.25 + nibble(12), 0.34375 + 0.25 + nibble(14), 1, 0.34375 + 0.25 + nibble(12)];
  placed[0]!.forEach((value, index) => close(value, expected[index]!));
  assert.ok(Math.abs(placed[0]![0]! - 0.622917) < 1e-6 && Math.abs(placed[0]![2]! - 0.55625) < 1e-6);
  assert.deepEqual(data, copy);
  assert.notEqual(placed[0], data[0]);
});

test("every pointed dripstone state moves by the same clamped offset at -700,-694", () => {
  const registry = minecraftData("1.21.4");
  const collision = registry.blockCollisionShapes!;
  const ids = collision.blocks["pointed_dripstone"];
  const shapeIds = new Set(Array.isArray(ids) ? ids : [ids!]);
  assert.equal(shapeIds.size > 0, true);
  let boxes = 0;
  for (const id of shapeIds) {
    const data = collision.shapes[id]!;
    const placed = placeShapes(data, 0.125, -700, -694);
    data.forEach((box, index) => {
      boxes += 1;
      close(placed[index]![0]! - box[0]!, 0.125 - 0.016667, 1e-5);
      close(placed[index]![2]! - box[2]!, 0.125 + 0.125);
    });
  }
  assert.ok(boxes > 0);
});
