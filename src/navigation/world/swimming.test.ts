import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { MemoryWorld } from "./memory-world.js";

const { bot: registryBot } = createFakeBot();
import { admitsDive, diveOrigin, holdSwimDepth, openWaterSurface, swimAscent, swimBreathPath, swimExitPath, swimTravelTicks } from "./swimming.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { WELL_FED, planningStart } from "../../test-support/navigation.js";

function pool() {
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 58; y <= 65; y++)
    world.load({ x, y, z }, y === 58 ? { stateId: 1 } : y <= 63
      ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } }
      : { stateId: 0 });
  return world;
}

test("open-water admission accounts for the slow descent, work and escape; a roof/current is not a surface", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const feet = { x: 0, y: 61, z: 0 };
  // Priced from the surface (0.5, 64, 0.5) with a jump at 64.4: a goal 5 down, (0, 59, 0), is 11.31 across, 220 down,
  // 8 to set off, 48 back up from the goal, and the 65 reserve: 352.31, refused at 300 and 352, admitted at 353.
  const deep = { x: 0, y: 59, z: 0 };
  const jumping = { x: 0.5, y: 64.4, z: 0.5 };
  assert.equal(admitsDive(read, deep, { origin: jumping, airTicks: 300 }), false);
  assert.equal(admitsDive(read, deep, { origin: jumping, airTicks: 352 }), false, "352 is short of 352.31");
  assert.ok(admitsDive(read, deep, { origin: jumping, airTicks: 353 }), "353 covers 352.31");
  assert.deepEqual(openWaterSurface(read, feet), { x: 0, y: 63, z: 0 });
  assert.ok(admitsDive(read, feet, { origin: { ...feet, y: 63 }, airTicks: 300 }, 75));
  assert.equal(admitsDive(read, feet, { origin: { ...feet, y: 63 }, airTicks: 120 }, 75), false);
  assert.equal(admitsDive(read, { ...feet, y: 59 }, { origin: { ...feet, y: 63 }, airTicks: 300 }, 75), false);
  world.load({ x: 0, y: 64, z: 0 }, { stateId: 1 });
  assert.equal(openWaterSurface(read, feet), null);
  world.load({ x: 0, y: 64, z: 0 }, { stateId: 0 });
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 3, traits: { empty: true, liquid: "water", liquidSource: false } });
  assert.equal(openWaterSurface(read, feet), null);
  assert.equal(openWaterSurface(read, { x: 12, y: 61, z: 0 }), null);
});

test("a return to air admits a cell while its way up fits the air left, without the dive's reserve", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const feet = { x: 0, y: 61, z: 0 };
  // From the stop's own cell: 8 ticks to set off plus 28 up to the surface at y 63 (two strokes up and the start).
  const wayUp = swimTravelTicks(feet, feet) + swimAscent(read, feet)!.ticks;
  assert.ok(admitsDive(read, feet, { origin: feet, airTicks: wayUp, toAir: true }));
  assert.equal(admitsDive(read, feet, { origin: feet, airTicks: wayUp - 1, toAir: true }), false);
  assert.equal(admitsDive(read, feet, { origin: feet, airTicks: wayUp }), false, "the dive keeps its reserve");
});

test("a body in a thin flowing stream with its head in air is no swim from a breath, and may still dive", () => {
  // One cell of flowing water over a stone floor, air above: no source column to the surface, but the head is dry.
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 60; y <= 64; y++)
    world.load({ x, y, z }, y === 60 ? { stateId: 1 } : y === 61
      ? { stateId: 3, traits: { empty: true, liquid: "water", liquidSource: false } }
      : { stateId: 0 });
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const feet = { x: 0, y: 61, z: 0 };
  assert.deepEqual(swimAscent(read, feet), { surface: feet, ticks: 0 });
  assert.ok(admitsDive(read, feet, { origin: feet, airTicks: 300 }));
});

test("vertical water edges require scoped air admission and retain asymmetric travel cost", () => {
  const world = pool();
  const feet = { x: 0, y: 62, z: 0 };
  const generate = (air?: number) => createMovementCatalogue().generate(planningStart(feet), {
    world, player: WELL_FED, policy: createMovementPolicy({
      allowDigging: false, allowPlacing: false,
      ...(air === undefined ? {} : { dive: { origin: feet, airTicks: air } }),
    }),
  }, { submergedAtEyes: true, onGround: false, aquaAffinity: false, effects: {} }).toArray();
  assert.equal(generate().some(({ to }) => to.y === 61), false);
  const edges = generate(300);
  const down = edges.find(({ to }) => to.x === 0 && to.y === 61 && to.z === 0);
  const up = edges.find(({ to }) => to.x === 0 && to.y === 63 && to.z === 0);
  assert.ok(down && up);
  assert.ok(down.cost > up.cost);
  assert.equal(generate(30).some(({ to }) => to.y === 61), false);
  assert.equal(edges.some(({ step }) => step.kind === "drop"), false, "liquid descent must not use a land-priced fall");
});

test("a newly dug pickup hole retains its verified ascent as air becomes flowing water", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const hole = { x: 0, y: 59, z: 0 };
  world.load(hole, { stateId: 0 });
  assert.deepEqual(openWaterSurface(read, hole), { x: 0, y: 63, z: 0 });
  world.load(hole, { stateId: 3, traits: { empty: true, liquid: "water", liquidSource: false } });
  assert.deepEqual(openWaterSurface(read, hole), { x: 0, y: 63, z: 0 });
  loadNamedBlock(world, registryBot, hole, "bubble_column");
  assert.equal(openWaterSurface(read, hole), null, "a bubble column is not the transient air in a pickup hole");
});

test("depth holding arrests inherited momentum and stays in a band under pinned liquid physics", () => {
  assert.equal(holdSwimDepth(60, -0.025, 60), true);
  assert.equal(holdSwimDepth(60, 0.15, 60), false);
  let y = 60.2;
  let velocity = -0.025;
  let min = y, max = y;
  for (let tick = 0; tick < 200; tick++) {
    if (holdSwimDepth(y, velocity, 60.2)) velocity += 0.04;
    y += velocity;
    velocity = velocity * 0.8 - 0.005;
    min = Math.min(min, y); max = Math.max(max, y);
  }
  assert.ok(max - min < 0.18, `hold varied from ${min} to ${max}`);
  assert.ok(swimTravelTicks({ x: 0, y: 63, z: 0 }, { x: 0, y: 61, z: 0 }) >
    swimTravelTicks({ x: 0, y: 61, z: 0 }, { x: 0, y: 63, z: 0 }));
});

/** Rows of text over a flat slice: `~` water, `.` air, `#` solid. Row 0 is the highest layer. */
function slice(layers: string[]): (x: number, y: number, z: number) => "water" | "air" | "solid" | "unknown" {
  return (x, y, z) => {
    const row = layers[layers.length - 1 - y];
    if (z !== 0 || row === undefined) return y >= layers.length ? "air" : "solid";
    const ch = row[x];
    return ch === "~" ? "water" : ch === "." ? "air" : ch === "#" ? "solid" : "unknown";
  };
}

// An overhang at y 3 over x 0..3, the swimmer under it at x 1, y 2; the sea floor is y 0.
const overhang = [
  "~~~~~~~~~~",
  "####~~~~~~",
  "~~~~~~~~~~",
  "~~~~~~~~~~",
  "##########",
];

test("an exit path swims round an overhang to the nearest open column", () => {
  const path = swimExitPath(slice(overhang), { x: 1, y: 2, z: 0 });
  assert.ok(path && path.length > 0);
  assert.equal(path.at(-1)?.x, 4, "the nearest column with no roof is the first past the overhang");
});

test("an open column straight up is its own exit, and a sealed pocket has none", () => {
  const open = slice(["~~~", "~~~", "~~~", "###"]);
  assert.deepEqual(swimExitPath(open, { x: 1, y: 1, z: 0 }), []);
  const sealed = slice(["#####", "#~~~#", "#~~~#", "#####"]);
  assert.equal(swimExitPath(sealed, { x: 2, y: 1, z: 0 }), null);
});

test("an exit farther than the radius is not found, and a blocked column is crossed but not chosen", () => {
  const sea = slice(overhang);
  assert.equal(swimExitPath(sea, { x: 1, y: 2, z: 0 }, [], 2), null);
  assert.equal(swimExitPath(sea, { x: 1, y: 2, z: 0 }, [{ x: 4, z: 0 }])?.at(-1)?.x, 5);
});

test("a flooded roofed cell reaches the one-cell air pocket in reach, and breath is free once the head is dry", () => {
  // Flooded and roofed all over; the swimmer on the floor at x 1, an air pocket one cell wide and high at x 4, y 3.
  const pocket = slice(["#########", "~~~~.~~~~".replace("~~~~.~~~~", "####.####"), "~~~~~~~~~", "~~~~~~~~~", "#########"]);
  const path = swimBreathPath(pocket, { x: 1, y: 1, z: 0 });
  assert.ok(path && path.length > 0, "the pocket is a breathing cell");
  assert.deepEqual(path.at(-1), { x: 4, y: 2, z: 0 }, "feet in water under the pocket, head in its air");
  assert.deepEqual(swimBreathPath(pocket, { x: 4, y: 2, z: 0 }), [], "head already dry: nothing to swim");
  const sealed = slice(["#####", "#~~~#", "#~~~#", "#####"]);
  assert.equal(swimBreathPath(sealed, { x: 2, y: 1, z: 0 }), null, "no air in reach, no breathing cell");
});

test("an ascent column through kelp reaches the surface", () => {
  const world = new MemoryWorld();
  loadNamedBlock(world, registryBot, { x: 0, y: 59, z: 0 }, "dirt");
  const cells = ["kelp_plant", "kelp_plant", "kelp_plant", "kelp"];
  for (let y = 60; y <= 75; y++) loadNamedBlock(world, registryBot, { x: 0, y, z: 0 }, cells[y - 60] ?? "air");
  assert.deepEqual(openWaterSurface((x, y, z) => world.blockAt(x, y, z), { x: 0, y: 60, z: 0 }), { x: 0, y: 63, z: 0 });
});

/**
 * underwater-breathing-stop.yaml's geometry (pond, walls, siphons) with its roof left out: the world the red trial's
 * resumed leg was planned in (its goal's column is open to the sky; with the roof the leg is over 300 from any origin).
 */
function breathingStopPond(): MemoryWorld {
  const world = new MemoryWorld();
  const fill = (stateId: number, from: [number, number, number], to: [number, number, number], traits?: object) => {
    for (let x = from[0]; x <= to[0]; x++) for (let y = from[1]; y <= to[1]; y++) for (let z = from[2]; z <= to[2]; z++)
      world.load({ x, y, z }, { stateId, ...(traits ? { traits } : {}) });
  };
  const water = { empty: true, liquid: "water", liquidSource: true };
  fill(0, [-6, -55, -6], [10, -45, 5]);
  fill(1, [-5, -60, -5], [9, -55, 4]);
  fill(0, [-4, -56, -4], [8, -55, 3]);
  fill(2, [-4, -59, -4], [8, -57, 3], water);
  fill(1, [4, -59, -4], [4, -55, 3]);
  fill(2, [4, -59, -4], [4, -58, -4], water);
  fill(1, [-1, -59, -4], [-1, -55, 3]);
  fill(2, [-1, -59, -1], [-1, -58, -1], water);
  return world;
}

test("the breathing stop's resumed leg from its jump peak is priced from the pond's surface, which admits it", () => {
  const world = breathingStopPond();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const goal = { x: 1, y: -59, z: -2 };
  // Red trial (red-phase3, 20 tps): the leg from y -55.41 totals 302.8 ticks (refused at 300: 209.8 travel, 28 up,
  // 65 reserve), from y -55.69 290.5 (passed). The surface is y -56, so the leg totals 276.8 and is admitted.
  const jumpPeak = { x: -1.3, y: -55.41, z: -0.51 };
  const surface = { x: -1.3, y: -56, z: -0.51 };
  assert.equal(swimAscent(read, goal)?.ticks, 28);
  assert.ok(admitsDive(read, goal, { origin: jumpPeak, airTicks: 300 }), "from the jump peak");
  assert.equal(admitsDive(read, goal, { origin: surface, airTicks: 276 }), false, "from the surface, 276 is short of 276.8");
  assert.ok(admitsDive(read, goal, { origin: surface, airTicks: 277 }), "from the surface, 277 covers 276.8");
});

test("a dive origin in the air over water is priced from the water surface only within a jump, and kept otherwise", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const at = (x: number, y: number, z: number) => ({ x, y, z });
  assert.deepEqual(diveOrigin(read, at(0.5, 62.5, 0.5)), at(0.5, 62.5, 0.5), "feet in water: unchanged");
  assert.deepEqual(diveOrigin(read, at(0.5, 64.4, 0.5)), at(0.5, 64, 0.5), "0.4 over the surface: the surface");
  assert.deepEqual(diveOrigin(read, at(0.5, 65.4, 0.5)), at(0.5, 64, 0.5), "1.4 over: the surface, read two cells down");
  world.load({ x: 0, y: 66, z: 0 }, { stateId: 0 });
  assert.deepEqual(diveOrigin(read, at(0.5, 66.4, 0.5)), at(0.5, 66.4, 0.5),
    "beyond the two cells of reach (water 3 cells down): unchanged");
  world.load({ x: 1, y: 63, z: 1 }, { stateId: 1 });
  assert.deepEqual(diveOrigin(read, at(1.5, 64.4, 1.5)), at(1.5, 64.4, 1.5), "dry stone where the water was: unchanged");
  assert.deepEqual(diveOrigin(read, at(10.5, 64.4, 10.5)), at(10.5, 64.4, 10.5), "an unloaded cell below: unchanged");
  world.load({ x: -2, y: 64, z: -2 }, { stateId: 1 });
  assert.deepEqual(diveOrigin(read, at(-1.5, 65.4, -1.5)), at(-1.5, 65.4, -1.5), "a solid cell between the body and the water: unchanged");
  // Water 1 below the feet (y 63), air at 62 and 61, water 4 below (y 60): the upper pool is the one read.
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 0 });
  world.load({ x: 0, y: 61, z: 0 }, { stateId: 0 });
  assert.deepEqual(diveOrigin(read, at(0.5, 64.4, 0.5)), at(0.5, 64, 0.5), "the upper of two stacked pools");
  const creek = new MemoryWorld();
  creek.load({ x: -1, y: 63, z: -3 }, { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } });
  creek.load({ x: -1, y: 64, z: -3 }, { stateId: 0 });
  assert.deepEqual(diveOrigin((x, y, z) => creek.blockAt(x, y, z), at(-0.3, 64.4, -2.5)), at(-0.3, 64, -2.5),
    "a negative fractional x and z read in the column they floor to: (-1, -3)");
});
