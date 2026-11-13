// What a placement rests on and what a finished build leaves behind: the four engine bugs the house-templates scenarios
// found (plan 2026-11-09-house-templates Task 7b): a ladder placed on a floor face, a state the block has no property for,
// a door placed on a block the same call digs out, a scaffold block left after the takedown.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { structureWorld } from "../../../test-support/structure-world.js";
import { packKey } from "../../index.js";
import { build, BuildProgress, BuildTargeting, holdsCell, type BuildCell, type BuildRequest } from "./build-process.js";

/** The faces the bot clicked, one per placement, in order. */
function recordingFaces(world: ReturnType<typeof structureWorld>) {
  const faces: string[] = [];
  const place = world.physics.place;
  return { faces, physics: { ...world.physics, place: async (placement: Parameters<typeof place>[0]) => { faces.push(`${placement.face.x},${placement.face.y},${placement.face.z}`); return place(placement); } } };
}

const ladder: BuildCell = { position: { x: 3, y: 64, z: 0 }, blockName: "ladder", facing: "east" };
const wall: BuildCell = { position: { x: 2, y: 64, z: 0 }, blockName: "cobblestone" };

// Bug 1: the floor face was taken as a ladder's support, the server refused the click, the cell was refused for the run.
test("a ladder is placed against the wall behind its facing, never on the floor face", async () => {
  const world = structureWorld({ carried: { ladder: 3, cobblestone: 8 } });
  const { faces, physics } = recordingFaces(world);
  const alone = await build(world.bot, { ...physics, cells: [ladder], removeWrongBlocks: false });
  assert.equal(alone.cells[0]!.state.kind, "unsupported", "the floor holds no ladder: it waits for a wall");
  assert.deepEqual(faces, []);
  world.put(new Vec3(2, 64, 0), "cobblestone");
  const held = await build(world.bot, { ...physics, cells: [ladder], removeWrongBlocks: false });
  assert.equal(held.status, "complete");
  assert.deepEqual(faces, ["1,0,0"], "the face points from the wall into the ladder's cell: the way it faces");
});

test("a ladder listed before its wall waits for it in the same call and is not refused", async () => {
  const world = structureWorld({ carried: { ladder: 3, cobblestone: 8 } });
  const { faces, physics } = recordingFaces(world);
  const result = await build(world.bot, { ...physics, cells: [ladder, wall], removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.cells.map(({ state }) => state.kind), ["correct", "correct"]);
  assert.deepEqual(world.harness.world.blockAt(new Vec3(3, 64, 0))?.name, "ladder");
  assert.deepEqual(faces, ["0,1,0", "1,0,0"], "the wall on the floor, then the ladder on the wall");
});

test("a block with a facing that is no clinging block keeps every face: stairs and doors are placed on the floor", async () => {
  const world = structureWorld({ carried: { oak_stairs: 2, oak_door: 1 } });
  const { faces, physics } = recordingFaces(world);
  const cells: BuildCell[] = [
    { position: { x: 2, y: 64, z: 0 }, blockName: "oak_stairs", facing: "east", half: "bottom" },
    { position: { x: 3, y: 64, z: 0 }, blockName: "oak_door", facing: "south" },
  ];
  const result = await build(world.bot, { ...physics, cells, removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(faces, ["0,1,0", "0,1,0"]);
});

// Bug 2: the audit asked `axis` of planks, which have no such property, so the cell never counted as right.
test("a cell asking a state its block has no property for is right when the block is", () => {
  const { bot, put } = structureWorld();
  const at = new Vec3(0, 64, 0);
  const planks = (cell: Partial<BuildCell>): BuildCell => ({ position: at, blockName: "dark_oak_planks", ...cell });
  put(at, "dark_oak_planks");
  const held = bot.blockAt(at)!;
  assert.equal(holdsCell(held, planks({ axis: "x" })), true, "planks have no axis");
  assert.equal(holdsCell(held, planks({ facing: "north" })), true, "planks have no facing");
  assert.equal(holdsCell(held, planks({ half: "top" })), true, "planks have no half");
  // A state the block has still decides: the same log along another axis is wrong.
  put(at, "oak_log", { axis: "y" });
  assert.equal(holdsCell(bot.blockAt(at)!, { position: at, blockName: "oak_log", axis: "x" }), false);
});

// Bug 3: the door was placed on the block under it, then the same call dug that block out for the support it asks.
test("a door waits for the block under it to hold its final block: the support is dug and placed first", async () => {
  const world = structureWorld({ carried: { oak_door: 1, cobblestone: 4 } });
  const under = { x: 2, y: 63, z: 0 };
  const door: BuildCell = { position: { x: 2, y: 64, z: 0 }, blockName: "oak_door", facing: "south" };
  const support: BuildCell = { position: under, blockName: "cobblestone" };
  // The wall beside the doorway stands: the door could rest on it, but it needs the block under it all the same.
  world.put(new Vec3(1, 64, 0), "cobblestone");
  world.put(new Vec3(3, 64, 0), "cobblestone");
  const heldUnderDoor: string[] = [];
  const place = world.physics.place;
  // The stone under the door is out of sight until the bot has walked: the door is the only thing it can work in reach.
  const physics = {
    ...world.physics,
    canSeeDig: () => world.routes.length > 0,
    place: async (placement: Parameters<typeof place>[0]) => {
      if (placement.item.name === "oak_door") heldUnderDoor.push(world.bot.blockAt(new Vec3(under.x, under.y, under.z))?.name ?? "none");
      return place(placement);
    },
  };
  const result = await build(world.bot, { ...physics, cells: [door, support], removeWrongBlocks: true });
  assert.equal(result.status, "complete");
  assert.deepEqual(heldUnderDoor, ["cobblestone"], "the door went on the cobblestone, not on the stone about to be dug");
  assert.deepEqual(world.placements, ["2,63,0", "2,64,0"]);
});

// Task review: the rule above must not fire for an empty cell under, or a beam end and the lantern hanging under it wait for each other.
test("a lantern hanging under a beam end and the beam wait for nothing: the hanging cell is no cell under that holds a block to replace", async () => {
  const world = structureWorld({ carried: { cobblestone: 8, lantern: 1 } });
  const cells: BuildCell[] = [
    ...[64, 65, 66].map((y): BuildCell => ({ position: { x: 2, y, z: 0 }, blockName: "cobblestone" })),
    { position: { x: 3, y: 66, z: 0 }, blockName: "cobblestone" },
    { position: { x: 4, y: 66, z: 0 }, blockName: "cobblestone" },
    { position: { x: 4, y: 65, z: 0 }, blockName: "lantern" },
  ];
  const result = await build(world.bot, { ...world.physics, cells, removeWrongBlocks: true });
  assert.equal(result.status, "complete");
  assert.equal(world.placements.at(-1), "4,65,0", "the lantern hangs from the beam, placed after it");
});

test("a door on a support that is not a cell of the build is placed at once", async () => {
  const world = structureWorld({ carried: { oak_door: 1 } });
  const door: BuildCell = { position: { x: 2, y: 64, z: 0 }, blockName: "oak_door", facing: "south" };
  const result = await build(world.bot, { ...world.physics, cells: [door], removeWrongBlocks: true });
  assert.equal(result.status, "complete");
  assert.deepEqual(world.placements, ["2,64,0"]);
});

// Found by the saltbox scenario once its ladder stood (a roof call ran 290 s, the next past 430 s): a ladder's cell reads
// "block" in the registry, so a bot climbing it was taken for a bot inside a solid block and every placement for "sealing it in".
test("a bot standing on a ladder is not sealed in by it: the walls it builds around itself stay placeable", () => {
  const box = (x: number, y: number, z: number) => [x, y, z] as [number, number, number];
  const shell = [] as [number, number, number][];
  for (let x = 0; x <= 2; x += 1) for (let y = 64; y <= 66; y += 1) for (let z = 0; z <= 2; z += 1) {
    const interior = x === 1 && z === 1 && y <= 65;
    const doorway = x === 0 && z === 1 && y <= 65;
    if (!interior && !doorway) shell.push(box(x, y, z));
  }
  const world = structureWorld({ feet: new Vec3(1, 64, 1) });
  world.put(new Vec3(1, 64, 1), "ladder", { facing: "east" });
  const cells = shell.map(([x, y, z]): BuildCell => ({ position: { x, y, z }, blockName: "cobblestone" }));
  const targeting = new BuildTargeting(world.bot, { ...({} as BuildRequest), cells, removeWrongBlocks: false });
  const kinds = [...targeting.states().values()].map((state) => state.kind);
  assert.ok(!kinds.includes("would_enclose"), `a doorway is open: ${kinds.join(",")}`);
  assert.ok(kinds.includes("placeable"));
});

test("a ladder the build has placed does not close the bot in either", () => {
  const world = structureWorld({ feet: new Vec3(1, 64, 1) });
  const ladderCell: BuildCell = { position: { x: 1, y: 64, z: 1 }, blockName: "ladder", facing: "east" };
  world.put(new Vec3(1, 64, 1), "ladder", { facing: "east" });
  const wallCells = [[0, 64, 0], [0, 65, 0], [2, 64, 0]].map(([x, y, z]): BuildCell => ({ position: { x: x!, y: y!, z: z! }, blockName: "cobblestone" }));
  const targeting = new BuildTargeting(world.bot, { ...({} as BuildRequest), cells: [ladderCell, ...wallCells], removeWrongBlocks: false });
  assert.equal(targeting.states().get(packKey(1, 64, 1))?.kind, "correct", "the ladder is built");
  assert.ok(![...targeting.states().values()].some((state) => state.kind === "would_enclose"));
});

// Bug 4: the takedown placed scaffold of its own to reach the highest block, reported it to nobody, and ran one pass.
test("scaffold the takedown places itself is taken down too, until none is left", async () => {
  const world = structureWorld();
  const state = 10; // dirt, as the routes report their placements
  const placeScaffold = (options: { onPlacement?: (placed: { position: { x: number; y: number; z: number }; stateId: number }) => void }, at: [number, number, number]) => {
    world.harness.world.setCell(new Vec3(...at), state);
    options.onPlacement?.({ position: { x: at[0], y: at[1], z: at[2] }, stateId: state });
  };
  const route = world.physics.route;
  let routes = 0;
  const physics = {
    ...world.physics,
    route: async (options: Parameters<typeof route>[0]) => {
      routes += 1;
      if (routes === 1) placeScaffold(options, [30, 65, 0]); // the build's own route
      if (routes === 2) placeScaffold(options, [31, 66, 0]); // the takedown's route, pillaring up to the first block
      return route(options);
    },
  };
  const result = await build(world.bot, { ...physics, cells: [{ position: { x: 10, y: 64, z: 0 }, blockName: "cobblestone" }], removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.equal(world.blocks.get("30,65,0")!.name, "air");
  assert.equal(world.blocks.get("31,66,0")!.name, "air", "the block the takedown's own route placed is gone too");
  assert.deepEqual(result.scaffold, { placed: 2, removed: 2, left: [] });
});

// Task review: scaffold the takedown placed before an abort is kept in the request's progress, for the attempt that resumes it.
test("scaffold placed by an aborted takedown is taken down by the attempt that resumes", async () => {
  const world = structureWorld();
  const progress = new BuildProgress();
  const cut = new AbortController();
  const route = world.physics.route;
  let routes = 0;
  const physics = {
    ...world.physics,
    route: async (options: Parameters<typeof route>[0]) => {
      routes += 1;
      if (routes === 1) {
        world.harness.world.setCell(new Vec3(30, 65, 0), 10);
        options.onPlacement?.({ position: { x: 30, y: 65, z: 0 }, stateId: 10 });
      }
      if (routes === 2) {
        world.harness.world.setCell(new Vec3(31, 66, 0), 10);
        options.onPlacement?.({ position: { x: 31, y: 66, z: 0 }, stateId: 10 });
        cut.abort(new Error("[HUNGER] reflex"));
        throw cut.signal.reason;
      }
      return route(options);
    },
  };
  const structure: BuildCell[] = [{ position: { x: 10, y: 64, z: 0 }, blockName: "cobblestone" }];
  await assert.rejects(build(world.bot, { ...physics, cells: structure, removeWrongBlocks: false, signal: cut.signal }, false, progress), /HUNGER/);
  assert.ok(progress.scaffold.has(packKey(31, 66, 0)), "the block the aborted takedown placed is remembered");
  const resumed = await build(world.bot, { ...world.physics, cells: structure, removeWrongBlocks: false }, false, progress);
  assert.equal(resumed.status, "complete");
  assert.equal(world.blocks.get("31,66,0")!.name, "air");
  assert.equal(world.blocks.get("30,65,0")!.name, "air");
  assert.deepEqual(resumed.scaffold.left, []);
});

test("a takedown that removes nothing more stops: the scaffold left is reported", async () => {
  const world = structureWorld();
  const route = world.physics.route;
  let routes = 0;
  const physics = {
    ...world.physics,
    route: async (options: Parameters<typeof route>[0]) => {
      routes += 1;
      if (routes === 1) {
        world.harness.world.setCell(new Vec3(30, 65, 0), 10);
        options.onPlacement?.({ position: { x: 30, y: 65, z: 0 }, stateId: 10 });
      }
      return route(options);
    },
    breakInPlace: async () => ({ status: "failed", reason: "unreachable" }) as never,
  };
  const result = await build(world.bot, { ...physics, cells: [{ position: { x: 10, y: 64, z: 0 }, blockName: "cobblestone" }], removeWrongBlocks: false });
  assert.equal(result.status, "complete");
  assert.deepEqual(result.scaffold, { placed: 1, removed: 0, left: [{ x: 30, y: 65, z: 0 }] });
  assert.ok(routes < 12, `the takedown gave up (${routes} routes)`);
});
