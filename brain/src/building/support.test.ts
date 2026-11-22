import assert from "node:assert/strict";
import test from "node:test";
import { buildBatches, MAX_BATCH_CELLS, placeBlueprint, type Blueprint, type Role, type Variants, type WorldCell } from "./blueprint.ts";
import minecraftData from "minecraft-data";
import { clingsBehindFacing, faceFits, fullCube, placeAgainst, supportGroups, TEMPLATE_REGISTRY_VERSION, validateBlueprint, withStatesItHas } from "./support.ts";
import { faceFits as runtimeFaceFits } from "#src/navigation/processes/building/build-cell.ts";

const BLOCKS: Partial<Record<Role, string>> = { foundation: "cobblestone", floor: "oak_planks", wall: "oak_planks", pillar: "oak_log", roof: "spruce_planks", accent: "ladder", door: "oak_door" };

/** A cell as the engine sees it: role gives the block unless one is named. */
function cell(x: number, y: number, z: number, role: Role, extra: Partial<WorldCell> = {}): WorldCell {
  return { x, y, z, role, block: role === "air" ? "air" : (BLOCKS[role] ?? "oak_planks"), ...extra };
}

const at = (groups: ReturnType<typeof supportGroups>["groups"], x: number, y: number, z: number) => groups.get(`${x},${y},${z}`);

test("a floor rests on the ground", () => {
  const { groups, unsupported } = supportGroups([cell(0, 0, 0, "floor"), cell(1, 0, 0, "floor"), cell(0, 0, 1, "floor")]);
  assert.deepEqual(unsupported, []);
  for (const [x, z] of [[0, 0], [1, 0], [0, 1]] as const) assert.equal(at(groups, x, 0, z)?.group, 0);
});

test("an unlisted ground cell holds its neighbour", () => {
  // The gap at 1,0,0 is leveled terrain: the wall above it rests on it, which nothing else holds.
  const { groups, unsupported } = supportGroups([cell(0, 0, 0, "floor"), cell(2, 0, 0, "floor"), cell(1, 1, 0, "wall")]);
  assert.deepEqual(unsupported, []);
  assert.equal(at(groups, 1, 1, 0)?.group, 1);
});

test("an eave rests beside its wall in the same call", () => {
  const { groups, unsupported } = supportGroups([cell(0, 0, 0, "floor"), cell(0, 1, 0, "wall"), cell(0, 2, 0, "wall"), cell(1, 2, 0, "roof")]);
  assert.deepEqual(unsupported, []);
  assert.equal(at(groups, 1, 2, 0)?.group, 2);
  assert.ok(at(groups, 1, 2, 0)!.round > at(groups, 0, 2, 0)!.round);
});

test("a hanging cell goes in its support's call", () => {
  const pillar = (x: number) => [0, 1, 2, 3].map((y) => cell(x, y, 0, "pillar", { axis: "y" }));
  const { groups, unsupported } = supportGroups([
    ...pillar(0),
    cell(1, 3, 0, "wall"), cell(1, 3, 1, "wall"), // a beam off the pillar
    cell(1, 2, 1, "accent", { block: "lantern" }), // hangs under its end
  ]);
  assert.deepEqual(unsupported, []);
  assert.equal(at(groups, 1, 2, 1)?.group, 3);
  assert.ok(at(groups, 1, 2, 1)!.round > at(groups, 1, 3, 1)!.round);
});

test("a top-half stair never rests on the block below", () => {
  const stair = (x: number) => cell(x, 1, 0, "roof", { block: "spruce_stairs", half: "top", facing: "east" });
  assert.deepEqual(supportGroups([cell(0, 0, 0, "floor"), stair(0)]).unsupported.map((c) => c.block), ["spruce_stairs"]);
  // The same stair beside a wall is held from the side.
  const beside = supportGroups([cell(0, 0, 0, "floor"), cell(1, 0, 0, "floor"), cell(1, 1, 0, "wall"), stair(0)]);
  assert.deepEqual(beside.unsupported, []);
  assert.equal(at(beside.groups, 0, 1, 0)?.group, 1);
});

test("a log beam needs a face along its axis", () => {
  const beam = cell(0, 1, 0, "pillar", { axis: "x", block: "oak_log" });
  assert.equal(supportGroups([cell(0, 0, 0, "floor"), beam]).unsupported.length, 1);
  const held = supportGroups([cell(0, 0, 0, "floor"), cell(1, 0, 0, "floor"), cell(1, 1, 0, "wall"), beam]);
  assert.deepEqual(held.unsupported, []);
});

test("a cell resting on nothing is reported", () => {
  const floating = cell(5, 3, 5, "wall");
  const { groups, unsupported } = supportGroups([cell(0, 0, 0, "floor"), floating]);
  assert.deepEqual(unsupported, [floating]);
  assert.equal(at(groups, 5, 3, 5), undefined);
});

test("air cells keep their layer, a door goes with its support", () => {
  const { groups } = supportGroups([cell(0, 0, 0, "foundation"), cell(0, 1, 0, "door"), cell(1, 2, 0, "air")]);
  assert.equal(at(groups, 1, 2, 0)?.group, 2);
  assert.equal(at(groups, 0, 1, 0)?.group, at(groups, 0, 0, 0)?.group);
});

test("placeAgainst follows the bounding box, fullCube the shape", () => {
  for (const block of ["oak_fence", "oak_slab", "lantern"]) {
    assert.equal(placeAgainst(block), true, block);
    assert.equal(fullCube(block), false, block);
  }
  for (const block of ["oak_planks", "hay_block", "glass"]) {
    assert.equal(placeAgainst(block), true, block);
    assert.equal(fullCube(block), true, block);
  }
  assert.equal(placeAgainst("torch"), false);
  assert.equal(fullCube("torch"), false);
  assert.equal(placeAgainst("not_a_block"), false);
  assert.equal(fullCube("not_a_block"), false);
});

test("a 300-cell chain keeps its order across calls", () => {
  // Listed far end first: the order of the list must not be what keeps each cell after its support.
  const chain = Array.from({ length: 300 }, (_, x) => cell(x, 2, 0, "wall")).reverse();
  const cells = [cell(0, 0, 0, "pillar"), cell(0, 1, 0, "pillar"), ...chain];
  const batches = buildBatches(cells);
  assert.ok(batches.every((batch) => batch.length <= MAX_BATCH_CELLS));
  const callOf = new Map(batches.flatMap((batch, index) => batch.map((c): [string, number] => [`${c.x},${c.y},${c.z}`, index])));
  for (let x = 1; x < 300; x += 1) {
    assert.ok(callOf.get(`${x},2,0`)! >= callOf.get(`${x - 1},2,0`)!, `cell ${x} is placed in an earlier call than its support`);
  }
  assert.ok(callOf.get("299,2,0")! > callOf.get("0,2,0")!, "the chain is split across calls");
});

test("a ladder keeps its facing", () => {
  const blueprint: Blueprint = {
    name: "ladder test",
    size: { x: 2, y: 2, z: 1 },
    cells: [{ x: 0, y: 1, z: 0, role: "door" }, { x: 1, y: 1, z: 0, role: "accent", facing: "south" }],
  };
  const palette = { foundation: "cobblestone", floor: "oak_planks", wall: "oak_planks", pillar: "oak_log", trim: "oak_log", roof: "spruce_planks", window: "glass_pane", door: "oak_door", accent: "ladder" };
  const [, ladder] = placeBlueprint(blueprint, palette, { x: 0, y: 64, z: 0 }, "east");
  assert.equal(ladder?.block, "ladder");
  // South in the blueprint frame is west once the front faces east.
  assert.equal(ladder?.facing, "west");
});

// Task review: the facing and half branches of the state filter (the axis one is held by plan.test.ts).
test("a cell keeps the states its block has and loses the ones it lacks", () => {
  const asked = { facing: "east", half: "top", axis: "x" } as const;
  const kept = (block: string) => { const { x, y, z, role, ...states } = withStatesItHas(cell(0, 0, 0, "wall", { block, ...asked })); void [x, y, z, role]; return states; };
  assert.deepEqual(kept("spruce_stairs"), { block: "spruce_stairs", facing: "east", half: "top" });
  assert.deepEqual(kept("spruce_slab"), { block: "spruce_slab", half: "top" }, "a slab's half is its `type`");
  assert.deepEqual(kept("oak_log"), { block: "oak_log", axis: "x" });
  assert.deepEqual(kept("dark_oak_planks"), { block: "dark_oak_planks" });
});

// Task 7b bug 1 (scenarios pagoda-house, adobe-pueblo, saltbox): the engine took the floor as a ladder's support; the
// server refuses a ladder placed on a floor face, it clings to the wall behind its facing.
test("a block that clings to the face behind its facing is read from the game's collision shapes, not from a list of names", () => {
  // (that the ladder is the one block that clings in 1.21.4 is held by the registry-wide assert in "faceFits is the runtime's, and only a ladder clings")
  for (const block of ["oak_stairs", "oak_door", "oak_trapdoor", "oak_fence_gate", "furnace", "lantern", "cobblestone", "oak_log", "spruce_slab"]) {
    assert.equal(clingsBehindFacing(block), false, block);
  }
  assert.equal(clingsBehindFacing("no_such_block"), false);
});

test("a ladder goes after the wall behind its facing, never against the floor under it", () => {
  const ladder = (y: number) => cell(1, y, 0, "accent", { facing: "east" });
  const base = [cell(0, 0, 0, "floor"), cell(1, 0, 0, "floor")];
  // Wall behind (x = 0) listed in the same layer: the ladder is in a later round than its wall.
  const held = supportGroups([...base, cell(0, 1, 0, "wall"), ladder(1)]);
  assert.deepEqual(held.unsupported, []);
  assert.equal(at(held.groups, 1, 1, 0)?.group, at(held.groups, 0, 1, 0)?.group);
  assert.ok(at(held.groups, 1, 1, 0)!.round > at(held.groups, 0, 1, 0)!.round, "the ladder waits for its wall");
  // No wall behind it: the floor under it is no support for a ladder.
  assert.deepEqual(supportGroups([...base, ladder(1)]).unsupported.map((c) => c.block), ["ladder"]);
  // A wall on another side is none either.
  assert.equal(supportGroups([...base, cell(1, 1, 1, "wall"), cell(2, 1, 0, "wall"), ladder(1)]).unsupported.length, 1);
});

// ---- validateBlueprint: a 5x5 hut behind a one-row yard, layers[y][z] rows, x along the row ----
type Key = Readonly<Record<string, { role: Role; shape?: "stairs" | "slab"; half?: "top" | "bottom" }>>;
const KEY: Key = { f: { role: "foundation" }, F: { role: "floor" }, w: { role: "wall" }, r: { role: "roof" }, D: { role: "door" }, _: { role: "air" } };
const PALETTE = { foundation: "cobblestone", floor: "oak_planks", wall: "oak_planks", pillar: "oak_log", trim: "oak_log", roof: "spruce_planks", window: "glass_pane", door: "oak_door" } as const;
const HUT: readonly (readonly string[])[] = [
  [".....", "fffff", "fFFFf", "fFFFf", "fFFFf", "fffff"],
  [".....", "wwDww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "ww.ww", "w___w", "w___w", "w___w", "wwwww"],
  [".....", "rrrrr", "rrrrr", "rrrrr", "rrrrr", "rrrrr"],
];

/** The blueprint a layers grid writes: every character but `.` is a cell of its key. */
function blueprintOf(layers: readonly (readonly string[])[], key: Key = KEY): Blueprint {
  const cells = layers.flatMap((rows, y) => rows.flatMap((row, z) => [...row].flatMap((char, x) => (char === "." ? [] : [{ x, y, z, ...key[char]! }]))));
  return { name: "test hut", size: { x: layers[0]![0]!.length, y: layers.length, z: layers[0]!.length }, cells };
}
const withRow = (y: number, z: number, row: string) => HUT.map((rows, layer) => rows.map((old, index) => (layer === y && index === z ? row : old)));
const problems = (blueprint: Blueprint, palette: Partial<Record<Role, string>> = PALETTE, variants: Variants = {}) => validateBlueprint(blueprint, palette, variants);

test("a hut with a door, a room and a roof is valid", () => {
  assert.deepEqual(problems(blueprintOf(HUT)), []);
});

test("a floating cell is invalid", () => {
  const empty = [".....", ".....", ".....", ".....", ".....", "....."];
  const messages = problems(blueprintOf([...HUT, empty, [".....", "w....", ".....", ".....", ".....", "....."]]));
  assert.ok(messages.some((message) => message.includes("0,5,1") && /rests on nothing/u.test(message)), messages.join("; "));
});

test("a door on a slab is invalid", () => {
  const layers = withRow(0, 1, "ffsff");
  const messages = problems(blueprintOf(layers, { ...KEY, s: { role: "foundation", shape: "slab", half: "bottom" } }), PALETTE, { foundation: { slab: "cobblestone_slab" } });
  assert.ok(messages.some((message) => message.includes("door") && message.includes("2,0,1") && /full block/u.test(message)), messages.join("; "));
});

test("a listed cell above the door is invalid", () => {
  const messages = problems(blueprintOf(withRow(2, 1, "wwwww")));
  assert.ok(messages.some((message) => message.includes("2,2,1") && /above the door/u.test(message)), messages.join("; "));
});

test("a door facing a wall is invalid", () => {
  const messages = problems(blueprintOf(withRow(1, 0, "..w..")));
  assert.ok(messages.some((message) => message.includes("2,1,0") && /in front of the door/u.test(message)), messages.join("; "));
});

test("a cell shutting the second row of the doorstep is invalid", () => {
  const messages = problems(blueprintOf(withRow(2, 0, "..w..")));
  assert.ok(messages.some((message) => message.includes("2,2,0") && /in front of the door/u.test(message)), messages.join("; "));
});

test("a floor left as the leveled ground is a place to walk", () => {
  assert.deepEqual(problems(blueprintOf(HUT.map((rows, y) => (y === 0 ? rows.map((row, z) => (z >= 2 && z <= 4 ? "f...f" : row)) : rows)))), []);
});

test("a room the door does not reach is invalid", () => {
  const messages = problems(blueprintOf(withRow(1, 2, "wwwww")));
  assert.ok(messages.some((message) => message.includes("2,1,2") && /door/u.test(message) && /walk/u.test(message)), messages.join("; "));
});

test("an unknown block id is invalid", () => {
  const messages = problems(blueprintOf(HUT), { ...PALETTE, wall: "not_a_block" });
  assert.ok(messages.some((message) => message.includes("wall") && message.includes("not_a_block")), messages.join("; "));
  const variant = problems(blueprintOf(HUT), PALETTE, { roof: { stairs: "spruce_stairz" } });
  assert.ok(variant.some((message) => message.includes("roof") && message.includes("spruce_stairz")), variant.join("; "));
});

test("wall: oak_fence is invalid (a structural role needs a full block)", () => {
  const messages = problems(blueprintOf(HUT), { ...PALETTE, wall: "oak_fence" });
  assert.ok(messages.some((message) => message.includes("wall") && message.includes("oak_fence") && /full block/u.test(message)), messages.join("; "));
});

test("door: oak_planks is invalid (a door block has a hinge state)", () => {
  const messages = problems(blueprintOf(HUT), { ...PALETTE, door: "oak_planks" });
  assert.ok(messages.some((message) => message.includes("door") && message.includes("oak_planks") && /hinge/u.test(message)), messages.join("; "));
});

test("a role a cell uses must have a block in the palette", () => {
  const { wall: _wall, ...without } = PALETTE;
  const messages = problems(blueprintOf(HUT), without);
  assert.ok(messages.some((message) => message.includes("wall") && /palette/u.test(message)), messages.join("; "));
});

test("over 2048 cells is invalid", () => {
  const filled = blueprintOf(HUT);
  const extra = Array.from({ length: 2100 }, (_, index) => ({ x: index % 30, y: 4 + Math.floor(index / 900), z: Math.floor(index / 30) % 30, role: "roof" as const }));
  const messages = problems({ ...filled, size: { x: 30, y: 7, z: 30 }, cells: [...filled.cells, ...extra] });
  assert.ok(messages.some((message) => /2048/u.test(message)), messages.join("; "));
});

test("18 layers is invalid", () => {
  const messages = problems({ ...blueprintOf(HUT), size: { x: 5, y: 18, z: 6 } });
  assert.ok(messages.some((message) => /17 layers/u.test(message)), messages.join("; "));
});

// The runtime's face rule and clinging rule are the brain's too: one function, no copy (moved from face-fits-agree.test.ts,
// which kept the two equal with a case per face, half and axis).
test("faceFits is the runtime's, and only a ladder clings", () => {
  assert.equal(faceFits, runtimeFaceFits);
  assert.equal(clingsBehindFacing("ladder"), true);
  assert.equal(clingsBehindFacing("oak_planks"), false);
  const registry = minecraftData(TEMPLATE_REGISTRY_VERSION);
  assert.deepEqual(registry.blocksArray.map((block) => block.name).filter(clingsBehindFacing), ["ladder"]);
});

test("31 wide is invalid", () => {
  const messages = problems({ ...blueprintOf(HUT), size: { x: 31, y: 4, z: 6 } });
  assert.ok(messages.some((message) => /30 x 30/u.test(message)), messages.join("; "));
});
