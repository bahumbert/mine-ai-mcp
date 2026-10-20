import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock, type WorldView } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
import { isInFire } from "../perception/body.js";
import {
  clearFireEscape,
  clearFireHop,
  escapeCells,
  fireEscapeDeparture,
  fireEscapeRoute,
  fireWaterRoute,
  nearbyFireEscape,
} from "./fire-escape.js";

test("a newly burning occupied cell has a dry escape through navigation's observed geometry", () => {
  const cells: Record<string, string> = { "0,64,0": "soul_fire", "1,64,0": "fire", "-1,64,0": "cactus" };
  const bot = botFixture({ blocks: cells, groundY: 63 });
  const world = new MemoryWorld();
  const refresh = () => {
    for (let x = -5; x <= 5; x++)
      for (let z = -5; z <= 5; z++)
        for (let y = 62; y <= 66; y++) {
          const at = new Vec3(x, y, z);
          world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
        }
  };
  refresh();
  assert.equal(isInFire(bot), true, "metadata need not report burning yet");
  const target = nearbyFireEscape(bot, world);
  assert.ok(target, "the occupied source does not make every exit path unreachable");
  assert.equal(clearFireEscape(bot, world, new Vec3(2.5, 64, 0.5)), false, "do not cross a second fire cell");
  assert.equal(clearFireEscape(bot, world, new Vec3(-2.5, 64, 0.5)), false, "reuse navigation's non-fire hazard facts");
  cells[`${Math.floor(target.x)},64,${Math.floor(target.z)}`] = "soul_fire";
  refresh();
  assert.equal(clearFireEscape(bot, world, target), false, "a destination igniting after selection invalidates it");
  bot.entity.position.set(0.75, 64, 2.5);
  assert.equal(isInFire(bot), false);
  assert.equal(
    nearbyFireEscape(bot, world),
    null,
    "dry ground is not an extinguishing destination for residual burning",
  );
});

test("fire contact includes shoulder overlap but excludes mere boundary contact", () => {
  const bot = botFixture({ blocks: { "1,65,0": "soul_fire" }, position: new Vec3(0.76, 64, 0.5) });
  assert.equal(isInFire(bot), true);
  bot.entity.position.x = 0.7;
  assert.equal(isInFire(bot), false);
});

test("a raised escape does not hide a new fire cell below its jump clearance", () => {
  const bot = botFixture({ blocks: { "0,64,0": "soul_fire", "1,64,0": "fire", "2,64,0": "stone" }, groundY: 63 });
  const world = new MemoryWorld();
  for (let x = -1; x <= 3; x++)
    for (let z = -1; z <= 1; z++)
      for (let y = 63; y <= 67; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  assert.equal(clearFireEscape(bot, world, new Vec3(2.5, 65, 0.5)), false);
});

test("a lava escape retains its departure while the body is airborne above the pool", () => {
  const cells: Record<string, string> = { "0,64,0": "lava", "1,64,0": "stone" };
  const bot = botFixture({ blocks: cells, groundY: 63 });
  Reflect.set(bot.entity, "isInLava", true);
  const world = new MemoryWorld();
  for (let x = -1; x <= 2; x++)
    for (let z = -1; z <= 1; z++)
      for (let y = 63; y <= 68; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  const departure = fireEscapeDeparture(bot);
  const target = new Vec3(1.5, 65, 0.5);
  assert.equal(clearFireEscape(bot, world, target, departure), true);
  bot.entity.position.set(0.7, 65.2, 0.5);
  bot.entity.onGround = false;
  Reflect.set(bot.entity, "isInLava", false);
  assert.equal(clearFireEscape(bot, world, target, departure), true, "the admitted bank remains reachable mid-jump");
  for (const hazard of ["fire", "lava"]) {
    cells["1,65,0"] = hazard;
    world.load(new Vec3(1, 65, 0), observeMineflayerBlock(bot.blockAt(new Vec3(1, 65, 0))!));
    assert.equal(clearFireEscape(bot, world, target, departure), false, `${hazard} invalidates the destination`);
  }
});

/** The lava-escape-to-water scene on the fixture's floor: stone up to y 64, so the body stands at y 65 and a pit cell is a hole in it. */
function sceneAt(cells: Record<string, string>, position: Vec3) {
  const bot = botFixture({ blocks: cells, groundY: 64, position });
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++)
      for (let y = 62; y <= 68; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  return { bot, world };
}

const PIT_AND_WATER = { "0,64,0": "lava", "2,64,0": "water" };
const IN_THE_PIT = new Vec3(0.5, 64, 0.5);
const ON_THE_WEST_BANK = new Vec3(-0.5, 65, 0.5);

function cellOf(point: Vec3): string {
  return `${Math.floor(point.x)},${Math.floor(point.y)},${Math.floor(point.z)}`;
}

test("the pit's way to water goes over the bank nearer the water", () => {
  const { bot, world } = sceneAt(PIT_AND_WATER, IN_THE_PIT);
  Reflect.set(bot.entity, "isInLava", true);
  const route = fireWaterRoute(bot, world, "contact");
  assert.deepEqual(route?.map((point) => [point.x, point.y, point.z]), [
    [1.5, 65, 0.5],
    [2.5, 64, 0.5],
  ]);
  const target = nearbyFireEscape(bot, world);
  assert.equal(target && cellOf(target), "1,65,0", "the east bank, where the scan order used to pick the west one");
});

/** Every hop of the route is one the straight-line check admits, and no cell is over lava. */
function assertWalkableRoute(bot: ReturnType<typeof sceneAt>["bot"], world: MemoryWorld, route: Vec3[] | null, lava: string[]) {
  assert.ok(route, "a route to the water exists");
  const water = world.blockAt(Math.floor(route.at(-1)!.x), Math.floor(route.at(-1)!.y), Math.floor(route.at(-1)!.z));
  assert.equal(water.kind === "loaded" && water.traits.liquid, "water", "the route ends in the water");
  let from = bot.entity.position;
  let departure = fireEscapeDeparture(bot);
  for (const point of route) {
    assert.equal(
      lava.includes(`${Math.floor(point.x)},${Math.floor(point.y - 1)},${Math.floor(point.z)}`),
      false,
      `${cellOf(point)} is not over lava`,
    );
    assert.equal(clearFireHop(bot, world, from, point, departure), true, `hop to ${cellOf(point)} is clear`);
    from = point;
    departure = { position: point, inLava: false };
  }
}

test("a burning bot on the far bank walks round the lava to the water", () => {
  const { bot, world } = sceneAt(PIT_AND_WATER, ON_THE_WEST_BANK);
  const route = fireWaterRoute(bot, world, "contact");
  assertWalkableRoute(bot, world, route, ["0,64,0"]);
  assert.equal(
    clearFireEscape(bot, world, new Vec3(2.5, 64, 0.5)),
    false,
    "the straight line to the water still crosses the lava",
  );
});

test("a second lava pool on the short way is walked round", () => {
  const cells = { "1,64,0": "lava", "2,64,0": "lava", "3,64,0": "water" };
  const { bot, world } = sceneAt(cells, new Vec3(0.5, 65, 0.5));
  assertWalkableRoute(bot, world, fireWaterRoute(bot, world, "contact"), ["1,64,0", "2,64,0"]);
});

const WATER_RINGED_BY_LAVA = {
  "0,64,0": "lava",
  "2,64,0": "lava",
  "3,64,0": "water",
  "4,64,0": "lava",
  "3,64,1": "lava",
  "3,64,-1": "lava",
};

test("water only through lava is no route", () => {
  const pit = sceneAt(WATER_RINGED_BY_LAVA, IN_THE_PIT);
  Reflect.set(pit.bot.entity, "isInLava", true);
  assert.equal(fireWaterRoute(pit.bot, pit.world, "contact"), null);
  const target = nearbyFireEscape(pit.bot, pit.world);
  assert.equal(target && cellOf(target), "1,65,0", "the tie between the banks goes toward the water");
  const bank = sceneAt(WATER_RINGED_BY_LAVA, new Vec3(1.5, 65, 0.5));
  assert.equal(nearbyFireEscape(bank.bot, bank.world), null, "burning on the east bank: stand down as before");
  assert.equal(fireEscapeRoute(bank.bot, bank.world, "contact"), null);
});

test("a body in water routes to its own cell", () => {
  const { bot, world } = sceneAt({ "0,64,0": "water" }, new Vec3(0.5, 64, 0.5));
  const route = fireWaterRoute(bot, world, "contact");
  assert.deepEqual(route?.map((point) => [point.x, point.y, point.z]), [[0.5, 64, 0.5]]);
});

test("the route search is bounded", () => {
  const counted = (cells: Record<string, string>, position: Vec3) => {
    const scene = sceneAt(cells, position);
    let reads = 0;
    const counting: WorldView = {
      blockAt: (x, y, z) => (reads++, scene.world.blockAt(x, y, z)),
      subscribe: (listener) => scene.world.subscribe(listener),
      get revision() {
        return scene.world.revision;
      },
    };
    return { bot: scene.bot, counting, reads: () => reads, reset: () => (reads = 0) };
  };
  const dry = counted({}, ON_THE_WEST_BANK);
  assert.equal(fireWaterRoute(dry.bot, dry.counting, "contact"), null);
  const scanReads = dry.reads();
  dry.reset();
  escapeCells(dry.bot, dry.counting);
  assert.equal(scanReads, dry.reads(), "no water in the scan: the route search reads only the scan");
  const ringed = counted(WATER_RINGED_BY_LAVA, ON_THE_WEST_BANK);
  assert.equal(fireWaterRoute(ringed.bot, ringed.counting, "contact"), null);
  assert.ok(ringed.reads() < 50_000, `one search reads ${ringed.reads()} cells`);
});

test("only fire contact looks for water, not advancing lava", () => {
  const { bot, world } = sceneAt(PIT_AND_WATER, ON_THE_WEST_BANK);
  assert.equal(fireWaterRoute(bot, world, "advancing_lava"), null);
});

test("a hop onto a cell that holds a block is not admitted", () => {
  const { bot, world } = sceneAt({ "1,65,0": "stone", "1,66,0": "stone" }, new Vec3(0.5, 65, 0.5));
  assert.equal(clearFireHop(bot, world, bot.entity.position, new Vec3(1.5, 65, 0.5), fireEscapeDeparture(bot)), false);
});

test("a body standing on the bank edge, its shoulder over the lava, still finds the way to the water", () => {
  const { bot, world } = sceneAt(PIT_AND_WATER, new Vec3(1.2757, 65, 0.5));
  const route = fireWaterRoute(bot, world, "contact");
  assert.deepEqual(route?.map((point) => [point.x, point.y, point.z]), [[2.5, 64, 0.5]]);
});

/** A thin block's collision: full width, `height` tall (the fixture's registry names are full cubes). */
const thinBlock = (stateId: number, height: number) => ({
  stateId,
  collisionShapes: [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: height, maxZ: 1 }],
});

test("a lava bank of carpet or a snow layer, which navigation walks over, is admitted from the pit", () => {
  for (const [name, height] of [["a carpet", 0.0625], ["a snow layer", 0.125]] as const) {
    const { bot, world } = sceneAt({ "0,64,0": "lava" }, IN_THE_PIT);
    Reflect.set(bot.entity, "isInLava", true);
    world.load(new Vec3(1, 65, 0), thinBlock(9, height));
    assert.equal(
      clearFireHop(bot, world, bot.entity.position, new Vec3(1.5, 65, 0.5), fireEscapeDeparture(bot)),
      true,
      `${name} is thin: its cell holds a collision shape and is still a standing cell`,
    );
  }
});

/** Stone up to y 64 and a wall of stone two high around the pit at (0,64,0), open only at `gap` (its bank cell). */
function walledPit(extra: Record<string, string>, gap = "-1,65,0") {
  const cells: Record<string, string> = { "0,64,0": "lava" };
  for (let x = -3; x <= 3; x++)
    for (let z = -3; z <= 3; z++)
      for (const y of [65, 66]) {
        const key = `${x},${y},${z}`;
        if ((x !== 0 || z !== 0) && key !== gap && key !== gap.replace(",65,", ",66,")) cells[key] = "stone";
      }
  return { ...cells, ...extra };
}

test("the body's own cell is never a dry escape cell", () => {
  const { bot, world } = sceneAt({}, new Vec3(0.5, 65, 0.5));
  const own = escapeCells(bot, world).dry.filter((point) => cellOf(point) === "0,65,0");
  assert.deepEqual(own, [], "a burning body on dry ground is not asked to walk to where it stands");
});

test("a cell lava can spread into is no escape cell", () => {
  const { bot, world } = sceneAt({ "1,65,0": "lava[level=2]" }, new Vec3(-1.5, 65, 0.5));
  const dry = escapeCells(bot, world).dry.map(cellOf);
  assert.ok(!dry.includes("0,65,0"), "beside level 2 lava");
  assert.ok(!dry.includes("1,65,1"), "beside level 2 lava");
  assert.ok(dry.includes("-1,65,0"), "two cells from the lava is safe");
});

test("a body in lava whose only bank is within the lava's reach takes it, as the last resort", () => {
  const { bot, world } = sceneAt(walledPit({ "-1,65,1": "lava[level=2]" }), IN_THE_PIT);
  Reflect.set(bot.entity, "isInLava", true);
  assert.deepEqual(
    fireEscapeRoute(bot, world, "contact")?.map(cellOf),
    ["-1,65,0"],
    "no safe cell exists and staying in lava is worse",
  );
});

test("a body on dry ground does not shuffle between cells lava can reach", () => {
  const { bot, world } = sceneAt(walledPit({ "-1,65,1": "lava[level=2]" }), new Vec3(-0.5, 65, 0.5));
  assert.equal(fireEscapeRoute(bot, world, "contact"), null, "out of the lava: no safe cell, no walk to another unsafe one");
});
