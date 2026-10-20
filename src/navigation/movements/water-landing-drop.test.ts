import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { MemoryWorld } from "../world/memory-world.js";
import { createMovementCatalogue } from "./catalogue.js";
import { createMovementPolicy } from "./policy.js";
import { WELL_FED, planningStart } from "../../test-support/navigation.js";

const SOLID = { stateId: 1 } as const;
const AIR = { stateId: 0 } as const;
const WATER = {
  stateId: 10,
  collisionShapes: [],
  traits: { empty: true, liquid: "water" as const, liquidSource: true, safeToBreak: false },
};

/** A pillar top at `top` with a pool east of it: `depth` water blocks over a stone floor at y 0, air above. */
function pillarOverPool(top: number, depth: number): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -2; x <= 3; x += 1)
    for (let z = -2; z <= 2; z += 1)
      for (let y = 0; y <= top + 3; y += 1) {
        const pillar = x === 0 && z === 0 && y <= top - 1;
        const pool = x >= 1 && y >= 1 && y <= depth;
        world.load({ x, y, z }, y === 0 || pillar ? SOLID : pool ? WATER : AIR);
      }
  return world;
}

function dropsEast(world: MemoryWorld, top: number): Array<{ y: number; kind: string }> {
  return createMovementCatalogue()
    .generate(
      planningStart({ x: 0, y: top, z: 0 }),
      { world, policy: createMovementPolicy({ allowDigging: false, allowPlacing: false }), player: WELL_FED },
      { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} },
    )
    .toArray()
    .filter((m) => m.to.x === 1 && m.to.z === 0 && (m.step.kind === "drop" || m.step.kind === "bucket_drop"))
    .map((m) => ({ y: m.to.y, kind: m.step.kind }));
}

test("a 25-block fall into three-deep water is planned, landing in the water", () => {
  assert.deepEqual(dropsEast(pillarOverPool(30, 3), 30), [{ y: 3, kind: "drop" }]);
});

test("a fall into one-deep water is refused", () => {
  assert.deepEqual(dropsEast(pillarOverPool(30, 1), 30), []);
});

test("a dry fall of five is still refused", () => {
  assert.deepEqual(dropsEast(pillarOverPool(6, 0), 6), []);
});

const registryBot = { registry: minecraftData("1.21.4") } as Pick<Bot, "registry">;

/** As {@link pillarOverPool}, the pool filled with kelp: kelp plant cells topped by a kelp cell, on the stone floor. */
function pillarOverKelpPool(top: number, depth: number): MemoryWorld {
  const world = pillarOverPool(top, 0);
  for (let x = 1; x <= 3; x += 1)
    for (let z = -2; z <= 2; z += 1)
      for (let y = 1; y <= depth; y += 1) loadNamedBlock(world, registryBot, { x, y, z }, y === depth ? "kelp" : "kelp_plant");
  return world;
}

test("a perch over a kelp-filled pool plans a water landing in the kelp, not a fall to the seabed", () => {
  assert.deepEqual(dropsEast(pillarOverKelpPool(30, 3), 30), [{ y: 3, kind: "drop" }]);
});
