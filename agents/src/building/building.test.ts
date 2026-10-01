import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { batchCells, billOfMaterials, buildBatches, FACING_VECTOR, MAX_BATCH_CELLS, placeBlueprint, shortfall, type Blueprint, type Facing, type WorldCell } from "./blueprint.ts";
import { house, HOUSE_SIZES, type HouseSize } from "./house.ts";
import { chooseSite, planHouse } from "./plan.ts";
import { STYLES } from "./styles.ts";

const FACINGS: readonly Facing[] = ["north", "south", "east", "west"];
const SIZES = Object.keys(HOUSE_SIZES) as HouseSize[];

function blueprints(): [string, Blueprint][] {
  return [...STYLES.values()].flatMap((style) => SIZES.map((size): [string, Blueprint] => [`${size} ${style.id}`, house({ ...HOUSE_SIZES[size], ...style.house })]));
}

const key = (cell: { x: number; y: number; z: number }) => `${cell.x},${cell.y},${cell.z}`;

test("every style is shipped with blocks that exist in 1.21.4 and are placed from an item of the same id", () => {
  const data = minecraftData("1.21.4");
  assert.deepEqual([...STYLES.keys()].sort(), ["japanese", "medieval", "rustic"]);
  for (const style of STYLES.values()) {
    for (const [role, block] of Object.entries(style.palette)) {
      assert.ok(data.blocksByName[block], `${style.id} ${role}: ${block} is not a block`);
      assert.ok(data.itemsByName[block], `${style.id} ${role}: ${block} has no item`);
    }
    for (const [role, shapes] of Object.entries(style.variants ?? {})) {
      for (const [shape, block] of Object.entries(shapes)) {
        assert.ok(data.blocksByName[block]?.name.endsWith(shape === "stairs" ? "_stairs" : "_slab"), `${style.id} ${role} ${shape}: ${block}`);
        assert.ok(data.itemsByName[block], `${style.id} ${role} ${shape}: ${block} has no item`);
      }
    }
    assert.ok(style.variants?.roof?.stairs && style.variants.roof.slab, `${style.id} has a stair roof`);
  }
});

test("a small medieval house has the expected bill of materials", () => {
  const plan = planHouse(STYLES.get("medieval")!, "small", chooseSite({ x: 0, y: 64, z: 0 }, null));
  assert.deepEqual(plan.bill, [
    { item: "spruce_stairs", count: 42 },
    { item: "oak_planks", count: 36 },
    { item: "oak_log", count: 24 },
    { item: "cobblestone", count: 16 },
    { item: "spruce_slab", count: 7 },
    { item: "oak_fence", count: 3 },
    { item: "oak_door", count: 1 },
  ]);
});

test("houses are symmetric about the door, roofed over every floor cell, and buildable from the ground up", () => {
  for (const [name, blueprint] of blueprints()) {
    const door = blueprint.cells.find((cell) => cell.role === "door")!;
    const roles = new Map(blueprint.cells.map((cell) => [key(cell), cell.role]));
    for (const cell of blueprint.cells) {
      assert.equal(roles.get(key({ ...cell, x: 2 * door.x - cell.x })), cell.role, `${name}: ${key(cell)} has no mirror`);
    }

    const solid = blueprint.cells.filter((cell) => cell.role !== "air");
    for (const floor of solid.filter((cell) => cell.role === "floor")) {
      assert.ok(solid.some((cell) => cell.x === floor.x && cell.z === floor.z && cell.y > 1), `${name}: floor ${key(floor)} has no roof`);
    }

    // Placement needs a face to click: the ground layer rests on the ground, every other block on a placed one.
    const placed = new Set(solid.filter((cell) => cell.y === 0).map(key));
    let grew = true;
    while (grew) {
      grew = false;
      for (const cell of solid) {
        if (placed.has(key(cell))) continue;
        const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
        if (neighbours.some(([dx, dy, dz]) => placed.has(key({ x: cell.x + dx!, y: cell.y + dy!, z: cell.z + dz! })))) {
          placed.add(key(cell));
          grew = true;
        }
      }
    }
    assert.deepEqual(solid.filter((cell) => !placed.has(key(cell))).map(key), [], `${name}: floating blocks`);
  }
});

test("a placed house keeps its door on the site, its doorstep in front and its rooms behind, whatever the facing", () => {
  const style = STYLES.get("japanese")!;
  const blueprint = house({ ...HOUSE_SIZES.medium, ...style.house });
  const door = { x: 100, y: 64, z: -40 };
  for (const facing of FACINGS) {
    const cells = placeBlueprint(blueprint, style.palette, door, facing);
    const [fx, fz] = FACING_VECTOR[facing];
    assert.deepEqual(cells.filter((cell) => cell.role === "door").map(key), [key(door)]);
    assert.deepEqual(cells.filter((cell) => cell.role === "air" && (cell.x - door.x) * fx + (cell.z - door.z) * fz === 1).map(key).sort(),
      [key({ x: door.x + fx, y: 64, z: door.z + fz }), key({ x: door.x + fx, y: 65, z: door.z + fz })].sort());
    for (const cell of cells.filter((cell) => cell.role === "floor" || cell.role === "foundation")) {
      assert.ok((cell.x - door.x) * fx + (cell.z - door.z) * fz <= 0, `${facing}: floor ${key(cell)} in front of the door`);
    }
    assert.equal(new Set(cells.map(key)).size, cells.length);
    assert.deepEqual(billOfMaterials(cells), billOfMaterials(placeBlueprint(blueprint, style.palette, door, "north")));
  }
});

test("the site is behind the bot, the door facing the requester, and the bot stands outside every cell", () => {
  const bot = { x: 10.5, y: 64, z: 10.5 };
  assert.deepEqual(chooseSite(bot, { x: 20, y: 64, z: 12 }), { door: { x: 8, y: 64, z: 10 }, facing: "east" });
  assert.deepEqual(chooseSite(bot, { x: 9, y: 64, z: 2 }), { door: { x: 10, y: 64, z: 12 }, facing: "north" });
  assert.deepEqual(chooseSite(bot, null), { door: { x: 10, y: 64, z: 12 }, facing: "north" });
  for (const toward of [{ x: 20, y: 64, z: 10 }, { x: 0, y: 64, z: 10 }, { x: 10, y: 64, z: 20 }, { x: 10, y: 64, z: 0 }]) {
    for (const style of STYLES.values()) {
      const plan = planHouse(style, "medium", chooseSite(bot, toward));
      const feet = [key({ x: 10, y: 64, z: 10 }), key({ x: 10, y: 65, z: 10 })];
      assert.ok(plan.cells.every((cell) => !feet.includes(key(cell))), `${style.id} toward ${key(toward)} covers the bot`);
    }
  }
});

test("batches go one layer at a time bottom up within the runtime limit, then clear every air cell again, then hang the door", () => {
  const plan = planHouse(STYLES.get("medieval")!, "medium", chooseSite({ x: 0, y: 64, z: 0 }, null));
  const { batches } = plan;
  assert.ok(batches.length >= 3);
  assert.ok(batches.every((batch) => batch.length <= MAX_BATCH_CELLS));
  const body = batches.slice(0, -2);
  assert.ok(body.every((batch) => batch.every((cell) => cell.y === batch[0]!.y)), "one layer per batch");
  assert.deepEqual(body.map((batch) => batch[0]!.y), [...new Set(plan.cells.map((cell) => cell.y))].sort((a, b) => a - b));
  const last = batches.at(-1)!;
  assert.deepEqual(last.map((cell) => cell.role), ["foundation", "door"], "the door is hung with the block it stands on");
  const door = last[1]!;
  assert.deepEqual(key(last[0]!), key({ ...door, y: door.y - 1 }));
  const structure = body.flat();
  assert.equal(structure.length + 1, plan.cells.length + 2);
  const doorway = [key(door), key({ ...door, y: door.y + 1 })];
  for (const cell of doorway) assert.ok(structure.some((entry) => entry.block === "air" && key(entry) === cell));
  const clearing = batches.at(-2)!;
  assert.ok(clearing.every((cell) => cell.block === "air"));
  assert.deepEqual(
    clearing.map(key).sort(),
    plan.cells.filter((cell) => cell.role === "air").map(key).sort(),
    "the clearing pass re-digs the room and the doorstep, not the doorway a finished door stands in",
  );

  const cell = (y: number): WorldCell => ({ x: 0, y, z: 0, block: "stone", role: "wall" });
  const layers = [...Array(3).fill(cell(0)), ...Array(4).fill(cell(1)), ...Array(12).fill(cell(2))];
  assert.deepEqual(batchCells(layers).map((batch) => batch.map((entry) => entry.y).join("")), ["000", "1111", "222222222222"]);
  assert.deepEqual(batchCells(layers, 5).map((batch) => batch.map((entry) => entry.y).join("")), ["000", "1111", "22222", "22222", "22"]);
  assert.equal(buildBatches(layers, 5).length, 5, "no air, no door: the layers only");
});

test("the shortfall counts what the inventory lacks, across stacks", () => {
  const bill = [{ item: "oak_planks", count: 70 }, { item: "cobblestone", count: 16 }, { item: "oak_door", count: 1 }];
  const inventory = [{ name: "oak_planks", count: 64 }, { name: "oak_planks", count: 3 }, { name: "cobblestone", count: 20 }];
  assert.deepEqual(shortfall(bill, inventory), [{ item: "oak_planks", count: 3 }, { item: "oak_door", count: 1 }]);
});

test("a shaped cell turns with the site: stairs keep facing up their slope and a beam keeps lying along its wall", () => {
  const blueprint: Blueprint = {
    name: "test",
    size: { x: 3, y: 2, z: 2 },
    cells: [
      { x: 1, y: 0, z: 0, role: "door" },
      { x: 0, y: 1, z: 1, role: "roof", shape: "stairs", facing: "north", half: "bottom" },
      { x: 1, y: 1, z: 1, role: "trim", axis: "x" },
      { x: 2, y: 1, z: 1, role: "roof", shape: "slab", half: "bottom" },
    ],
  };
  const variants = { roof: { stairs: "spruce_stairs", slab: "spruce_slab" } };
  const turned = { north: ["north", "x"], south: ["south", "x"], east: ["east", "z"], west: ["west", "z"] } as const;
  for (const facing of FACINGS) {
    const cells = placeBlueprint(blueprint, STYLES.get("medieval")!.palette, { x: 0, y: 64, z: 0 }, facing, variants);
    const stairs = cells.find((cell) => cell.block === "spruce_stairs")!;
    const beam = cells.find((cell) => cell.role === "trim")!;
    const slab = cells.find((cell) => cell.block === "spruce_slab")!;
    assert.equal(stairs.facing, turned[facing][0], `stairs, door facing ${facing}`);
    assert.equal(stairs.half, "bottom");
    assert.equal(beam.axis, turned[facing][1], `beam, door facing ${facing}`);
    assert.equal(slab.half, "bottom");
    assert.equal(slab.facing, undefined);
  }
});

test("a shaped cell whose role has no variant in the style is the role's full block, with no stair or slab state", () => {
  const blueprint: Blueprint = {
    name: "test",
    size: { x: 2, y: 2, z: 2 },
    cells: [
      { x: 0, y: 0, z: 0, role: "door" },
      { x: 1, y: 1, z: 1, role: "roof", shape: "stairs", facing: "north", half: "bottom" },
    ],
  };
  const roof = placeBlueprint(blueprint, STYLES.get("medieval")!.palette, { x: 0, y: 64, z: 0 }, "north").find((cell) => cell.role === "roof")!;
  assert.deepEqual(roof, { x: 1, y: 65, z: 1, block: "spruce_planks", role: "roof" });
});

test("roofs are stairs facing up their slope with a slab ridge; beams lie along their wall and pillars stand", () => {
  for (const [name, blueprint] of blueprints()) {
    const cells = blueprint.cells;
    const at = new Map(cells.map((cell) => [key(cell), cell]));
    const roofs = cells.filter((cell) => cell.role === "roof" && cell.shape !== undefined);
    assert.ok(roofs.length > 0, `${name} has a shaped roof`);
    for (const cell of roofs) {
      if (cell.shape === "slab") {
        assert.equal(cell.half, "bottom", `${name} ridge ${key(cell)}`);
        continue;
      }
      assert.equal(cell.half, "bottom", `${name} ${key(cell)}`);
      // Up the slope: the cell one step that way, one block higher, is roof too (or the ridge above the top row).
      const step = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[cell.facing!];
      const above = at.get(key({ x: cell.x + step[0], y: cell.y + 1, z: cell.z + step[1] }));
      const across = at.get(key({ x: cell.x + step[0], y: cell.y, z: cell.z + step[1] }));
      assert.ok(above?.role === "roof" || across?.role === "roof" || across?.role === "air" || across?.role === "wall", `${name} ${key(cell)} faces ${cell.facing}, up its slope`);
    }
    for (const cell of cells.filter((c) => c.role === "trim")) {
      const along = at.get(key({ x: cell.x + 1, y: cell.y, z: cell.z }))?.role === "trim" || at.get(key({ x: cell.x - 1, y: cell.y, z: cell.z }))?.role === "trim"
        || at.get(key({ x: cell.x + 1, y: cell.y, z: cell.z }))?.role === "pillar" || at.get(key({ x: cell.x - 1, y: cell.y, z: cell.z }))?.role === "pillar";
      assert.equal(cell.axis, along ? "x" : "z", `${name} trim ${key(cell)}`);
    }
    assert.ok(cells.filter((cell) => cell.role === "pillar").every((cell) => cell.axis === "y"), `${name} pillars stand`);
  }
});

test("a gable roof's slopes face each other and a one-cell ridge row is a slab", () => {
  const blueprint = house({ width: 5, depth: 5, wallHeight: 3, roof: "gable", overhang: 1 });
  const top = Math.max(...blueprint.cells.filter((cell) => cell.role === "roof").map((cell) => cell.y));
  const ridge = blueprint.cells.filter((cell) => cell.role === "roof" && cell.y === top);
  assert.ok(ridge.length > 0 && ridge.every((cell) => cell.shape === "slab"), "the top row is slab");
  const facings = new Set(blueprint.cells.filter((cell) => cell.shape === "stairs").map((cell) => cell.facing));
  assert.deepEqual([...facings].sort(), ["east", "west"], "5x5 slopes across x");
});
