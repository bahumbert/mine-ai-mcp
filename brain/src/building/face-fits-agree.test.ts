import assert from "node:assert/strict";
import test from "node:test";
import { faceFits as runtimeFaceFits, type BuildCell } from "#src/navigation/processes/building/build-process.ts";
import minecraftData from "minecraft-data";
import { clingsBehindFacing as runtimeClings } from "#src/world/block-states.ts";
import { clingsBehindFacing, faceFits } from "./support.ts";

const FACES = [
  { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
  { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
] as const;
const HALVES = [undefined, "top", "bottom"] as const;
const AXES = [undefined, "x", "y", "z"] as const;

const registry = minecraftData("1.21.4");

test("the brain's clinging rule agrees with the runtime's on every block of the registry, and a clinging block takes its facing's face only", () => {
  for (const block of registry.blocksArray) assert.equal(clingsBehindFacing(block.name), runtimeClings(registry, block.name), block.name);
  assert.deepEqual(registry.blocksArray.map((block) => block.name).filter(clingsBehindFacing), ["ladder"], "in 1.21.4 only the ladder has a collision that clings");
  const ladder: BuildCell = { position: { x: 0, y: 0, z: 0 }, blockName: "ladder", facing: "east" };
  for (const face of FACES) {
    const clings = faceFits(face, { facing: "east" }, true);
    assert.equal(clings, face.x === 1, `face ${JSON.stringify(face)}`);
    assert.equal(clings, runtimeFaceFits(face, ladder, true), `face ${JSON.stringify(face)} (runtime)`);
  }
});

// The brain imports no src/ module in production, so support.ts keeps a copy of the runtime's rule; this keeps them one.
test("the brain's faceFits agrees with the runtime's on every face, half and axis", () => {
  for (const face of FACES) {
    for (const half of HALVES) {
      for (const axis of AXES) {
        const runtimeCell: BuildCell = { position: { x: 0, y: 0, z: 0 }, blockName: "oak_log", ...(half !== undefined && { half }), ...(axis !== undefined && { axis }) };
        assert.equal(faceFits(face, { half, axis }), runtimeFaceFits(face, runtimeCell), `face ${JSON.stringify(face)} half ${half} axis ${axis}`);
      }
    }
  }
});
