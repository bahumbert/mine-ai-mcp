import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import {
  type FakeClock,
  type FakeEntitySpec,
  type FakeHarness,
  type FakeWorld,
  createFakeBot,
  createFakeClock,
  itemOf,
} from "../../test-support/fake-bot/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import type { placeSolidBlockInto } from "../../world/placement.js";
import { rememberSealedPit } from "../../world/sealed-pits.js";
import {
  observeHoleDrops,
  pluggedCellCount,
  prepareDisposalHole,
  sealDisposalHole,
  snapshotDroppedCounts,
} from "./disposal-hole.js";

/** Dirt under the bot's feet out past the pit search radius and its walls (stone beyond, which no test reaches). */
const DIRT_GROUND: Record<string, string> = {};
for (let x = -12; x <= 12; x++)
  for (let z = -12; z <= 12; z++) for (let y = 56; y <= 63; y++) DIRT_GROUND[`${x},${y},${z}`] = "dirt";

/** The bot standing at (0.5, 64, 0.5) on dirt, carrying `carried`, with any `entities` (items) around it. */
function ground(
  carried: { name: string; count: number }[] = [],
  options: { readonly entities?: Readonly<Record<number, FakeEntitySpec>>; readonly clock?: FakeClock } = {},
) {
  const harness = createFakeBot({
    cells: DIRT_GROUND,
    carried: Object.fromEntries(carried.map(({ name, count }) => [name, count])),
    ...(options.entities && { entities: options.entities }),
    ...(options.clock && { clock: options.clock }),
  });
  return { bot: harness.bot, world: harness.world, harness };
}

/** A placement that fills the cell with the chosen item and spends one of it. */
function fakePlacement(harness: FakeHarness, placed: { cell: Vec3; item: string }[]): typeof placeSolidBlockInto {
  const counts = new CarriedCounts(harness.inventory, harness.bot.registry);
  return async (bot, cell, item) => {
    if (!item) return { kind: "failed" as const, error: "no item" };
    const position = new Vec3(cell.x, cell.y, cell.z);
    placed.push({ cell: position, item: item.name });
    harness.world.setCell(position, item.name);
    // The server takes one from the stack; a spent stack leaves the window rather than staying at zero.
    counts.set(item.type, (counts.get(item.type) ?? 0) - 1);
    return { kind: "placed" as const, block: bot.blockAt(position)! };
  };
}

/** An item entity's `getDroppedItem`: a real stack of `count` `name`. */
function droppedStack(bot: Bot, name: string, count: number) {
  return () => itemOf(bot.registry, name, count);
}

test("the shaft above the discards is plugged first, then the ground-level cell", async () => {
  const { bot, world, harness } = ground([
    { name: "oak_log", count: 5 },
    { name: "cobblestone", count: 2 },
  ]);
  for (const y of [62, 63]) world.setCell(new Vec3(1, y, 0), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, placed), {});

  assert.deepEqual(seal, { item: "cobblestone", placed: 2 });
  assert.deepEqual(
    placed.map((entry) => [entry.cell.y, entry.item]),
    [
      [63, "cobblestone"],
      [64, "cobblestone"],
    ],
    "scaffold material is preferred over other carried blocks",
  );
  assert.equal(bot.blockAt(new Vec3(1, 62, 0))?.name, "air", "the discards' own cell is left alone");
});

test("a partly plugged hole reports what was placed and why it stopped", async () => {
  const { bot, world, harness } = ground([
    { name: "dirt", count: 1 },
    { name: "sand", count: 64 },
    { name: "crafting_table", count: 1 },
    { name: "stick", count: 3 },
  ]);
  for (const y of [62, 63]) world.setCell(new Vec3(1, y, 0), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, placed), {});

  assert.equal(seal.item, "dirt");
  assert.equal(seal.placed, 1);
  assert.match(seal.error ?? "", /DROP_HOLE_OPEN.*\(1, 64, 0\)/);
  assert.deepEqual(
    placed.map((entry) => entry.item),
    ["dirt"],
    "falling blocks, workstations, and non-blocks are never used as a plug",
  );
});

test("an empty hand leaves the hole open without failing the drop", async () => {
  const { bot, world, harness } = ground();
  for (const y of [62, 63]) world.setCell(new Vec3(1, y, 0), "air");

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, []), {});

  assert.equal(seal.placed, 0);
  assert.equal(seal.item, null);
  assert.match(seal.error ?? "", /DROP_HOLE_OPEN/);
});

test("the plug uses the kept item before the policy's first scaffold block", async () => {
  const { bot, world, harness } = ground([
    { name: "dirt", count: 5 },
    { name: "oak_planks", count: 2 },
  ]);
  for (const y of [62, 63]) world.setCell(new Vec3(1, y, 0), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, placed), {}, { plugItem: "oak_planks" });

  assert.deepEqual(seal, { item: "oak_planks", placed: 2 });
  assert.deepEqual(placed.map((entry) => entry.item), ["oak_planks", "oak_planks"]);
});

test("with no policy block carried, a common-stock block plugs the hole", async () => {
  const { bot, world, harness } = ground([{ name: "oak_planks", count: 2 }, { name: "oak_log", count: 9 }]);
  for (const y of [62, 63]) world.setCell(new Vec3(1, y, 0), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, placed), {});

  assert.deepEqual(seal, { item: "oak_planks", placed: 2 });
});

test("hole preparation refuses liquid beside its shaft without digging", async () => {
  const { bot, world } = ground();
  for (const [x, z] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ])
    world.setCell(new Vec3(x, 62, z), "water");
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async () => {
        assert.fail("A shaft that opens into liquid must not be dug.");
      },
      {},
    ),
    /DROP_HOLE_UNAVAILABLE/,
  );
});

test("cancellation after the first hole block prevents the second dig", async () => {
  const { bot, world } = ground();
  const stop = new AbortController();
  const digs: number[] = [];
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        digs.push(position.y);
        world.setCell(new Vec3(position.x, position.y, position.z), "air");
        stop.abort(new Error("stop disposal"));
        return { status: "broken" };
      },
      { signal: stop.signal },
    ),
    /stop disposal/,
  );
  assert.deepEqual(digs, [63]);
});

/** The last step of a prepared pit is a look through its opening, which turns on the bot's physics ticks (a half turn takes 21). */
const LOOK_MS = 2_000;

/**
 * The bot digs its disposal pit, its closing look included, on the harness clock: each cell it breaks turns to air and
 * is reported to `dug`. `moveTo` and `pit` are prepareDisposalHole's own.
 */
function digPit(
  { bot, world, clock }: FakeHarness,
  dug: (cell: Vec3) => void = () => {},
  moveTo?: Parameters<typeof prepareDisposalHole>[4],
  pit?: Parameters<typeof prepareDisposalHole>[5],
): Promise<Vec3> {
  return clock.settle(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        dug(new Vec3(position.x, position.y, position.z));
        world.setCell(new Vec3(position.x, position.y, position.z), "air");
        return { status: "broken" };
      },
      {},
      moveTo,
      pit,
    ),
    LOOK_MS,
  );
}

test("a tunnel wall is excavated above an enclosed disposal pit", async () => {
  const { bot, world, harness } = ground();
  world.setCell(new Vec3(1, 64, 0), "stone");
  world.setCell(new Vec3(1, 65, 0), "stone");
  const digs: number[] = [];
  const bottom = await digPit(harness, (cell) => digs.push(cell.y));
  assert.deepEqual(bottom, new Vec3(1, 62, 0));
  assert.deepEqual(digs, [65, 64, 63, 62]);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "dirt");
});

test("hole evidence counts merged stack growth and ignores existing items", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  // Entity 1 is the bot's own in the harness (Mineflayer's login entity); the item takes the next id.
  const { bot } = ground([], { clock, entities: { 2: { name: "item", position: new Vec3(1.5, 62, 0.5) } } });
  const entity = bot.entities[2]!;
  entity.getDroppedItem = droppedStack(bot, "dirt", 2);
  const baseline = snapshotDroppedCounts(bot);
  entity.getDroppedItem = droppedStack(bot, "dirt", 12);
  assert.deepEqual(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
    ),
    { landed: true, entityIds: [2] },
  );
  entity.getDroppedItem = droppedStack(bot, "dirt", 2);
  assert.equal(
    (
      await clock.settle(
        observeHoleDrops(
          bot,
          { x: 1, y: 62, z: 0 },
          baseline,
          [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
          {},
          50,
        ),
        1_000,
      )
    ).landed,
    false,
  );
});

/** Water over the pit layer around the bot, so no cell within `radius` blocks fits a pit. */
function floodAround(world: FakeWorld, radius: number) {
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++) world.setCell(new Vec3(x, 62, z), "water");
}

test("a pit is dug at the nearest fit stance when none beside the feet fits", async () => {
  const { bot, world, harness } = ground();
  floodAround(world, 4);
  const moves: Vec3[] = [];
  const digs: Vec3[] = [];
  const bottom = await digPit(
    harness,
    (cell) => digs.push(cell),
    async (stance) => {
      moves.push(stance);
      bot.entity.position = stance.offset(0.5, 0, 0.5);
      return undefined;
    },
  );
  assert.equal(moves.length, 1);
  assert.ok(Math.hypot(moves[0]!.x, moves[0]!.z) >= 4.5, "the stance is outside the flooded patch");
  assert.ok(Math.hypot(moves[0]!.x, moves[0]!.z) <= 8);
  assert.equal(Math.abs(bottom.x - moves[0]!.x) + Math.abs(bottom.z - moves[0]!.z), 1, "the pit is beside the stance");
  assert.equal(digs.length, 2, "the pit is dug where the bot now stands");
});

test("a pit cell inside a protected region is never chosen, the bot's own region included", async () => {
  const { bot, harness } = ground();
  setProtectedRegionsProvider(bot, () => [
    {
      regionId: 1,
      dimension: "overworld",
      min: { x: -3, y: 55, z: -3 },
      max: { x: 3, y: 70, z: 3 },
      owner: "someone",
      label: "house",
    },
  ]);
  const digs: Vec3[] = [];
  const bottom = await digPit(
    harness,
    (cell) => digs.push(cell),
    async (stance) => {
      bot.entity.position = stance.offset(0.5, 0, 0.5);
      return undefined;
    },
  );
  for (const cell of [bottom, ...digs]) assert.ok(Math.max(Math.abs(cell.x), Math.abs(cell.z)) > 3, `${cell} is outside`);
});

test("nothing within eight blocks that fits reports the radius", async () => {
  const { bot, world } = ground();
  floodAround(world, 12);
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async () => assert.fail("no dig"),
      {},
      async () => assert.fail("no walk"),
    ),
    /DROP_HOLE_UNAVAILABLE.*within 8 blocks/,
  );
});

test("a pit that holds a dropped item is skipped for the next one (live 2026-10-10 run 8: buried items came back)", async () => {
  const { bot, harness } = ground([], { entities: { 5: { name: "item", position: new Vec3(1.5, 62.1, 0.5) } } });
  const item = bot.entities[5]!;
  item.getDroppedItem = droppedStack(bot, "dirt", 3);
  const digs: Vec3[] = [];
  const bottom = await digPit(harness, (cell) => digs.push(cell));
  assert.notDeepEqual(bottom, new Vec3(1, 62, 0), "the pit with the item in it is not reused");
  assert.equal(digs.length, 2);
  // An item that is not within reach of the pit's cells does not matter.
  item.position = new Vec3(9.5, 62.1, 9.5);
  const free = await digPit(harness);
  assert.ok(free);
});

/** Where the item the first dig of `digUntilReflex` drops waits until then: far from any pit the tests look at. */
const AWAY = new Vec3(100.5, 64, 100.5);

/** A ground bot with the item entity (id 9) that `digUntilReflex` drops into the pit, lying `AWAY` until then. */
function groundWithDigDrop() {
  const scene = ground([], { entities: { 9: { name: "item", position: AWAY } } });
  scene.bot.entities[9]!.getDroppedItem = droppedStack(scene.bot, "dirt", 1);
  return scene;
}

/** Digs the pit and aborts after its first block, leaving the half-dug pit and the item that block dropped. */
async function digUntilReflex(
  bot: Bot,
  world: FakeWorld,
  pit: { bottom: Vec3 | null } | undefined,
): Promise<void> {
  const reflex = new AbortController();
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        world.setCell(new Vec3(position.x, position.y, position.z), "air");
        reflex.abort(new Error("hunger reflex"));
        return { status: "broken" };
      },
      { signal: reflex.signal },
      undefined,
      pit,
    ),
    /hunger reflex/,
  );
  // The block the first dig broke dropped its item into the pit.
  bot.entities[9]!.position = new Vec3(1.5, 62.5, 0.5);
}

test("a pit cut short by a reflex is dug on by the next attempt, not replaced by a second pit", async () => {
  const { bot, world, harness } = groundWithDigDrop();
  const pit = { bottom: null as Vec3 | null };
  await digUntilReflex(bot, world, pit);
  assert.deepEqual(pit.bottom, new Vec3(1, 62, 0));
  const digs: number[] = [];

  const bottom = await digPit(harness, (cell) => digs.push(cell.y), undefined, pit);

  assert.deepEqual(bottom, new Vec3(1, 62, 0));
  assert.deepEqual(digs, [62], "only the cell the first attempt had not reached is dug");
});

test("without the pit memory the item the first dig dropped makes the next attempt start another pit", async () => {
  const { bot, world, harness } = groundWithDigDrop();
  await digUntilReflex(bot, world, undefined);

  const bottom = await digPit(harness);

  assert.notDeepEqual(bottom, new Vec3(1, 62, 0));
});

test("a plug a first attempt began is counted with what the next attempt placed", async () => {
  const { bot, world } = ground([{ name: "cobblestone", count: 2 }]);
  world.setCell(new Vec3(1, 62, 0), "air");
  world.setCell(new Vec3(1, 63, 0), "cobblestone");
  world.setCell(new Vec3(1, 64, 0), "air");

  assert.equal(pluggedCellCount(bot, new Vec3(1, 62, 0)), 1);
});

test("no new pit opens a guard cell of a sealed pit", async () => {
  const { bot, world, harness } = ground();
  const dig = async ({ position }: { position: { x: number; y: number; z: number } }) => {
    world.setCell(new Vec3(position.x, position.y, position.z), "air");
    return { status: "broken" as const };
  };
  const open = await harness.clock.settle(prepareDisposalHole(bot, createMovementPolicy(), dig, {}), LOOK_MS);
  assert.deepEqual([open.x, open.y, open.z], [1, 62, 0], "the first side fits on open ground");

  const fresh = ground();
  rememberSealedPit(fresh.bot, { x: 2, y: 62, z: 1 });
  const beside = await fresh.harness.clock.settle(
    prepareDisposalHole(fresh.bot, createMovementPolicy(), async ({ position }) => {
      fresh.world.setCell(new Vec3(position.x, position.y, position.z), "air");
      return { status: "broken" };
    }, {}),
    LOOK_MS,
  );
  assert.deepEqual([beside.x, beside.y, beside.z], [-1, 62, 0], "the cell inside the sealed pit's guard volume is passed over");
});

/**
 * A ground bot on a mocked clock, whose physics ticks come with each slice of it, with one dropped item lying in the
 * lower plug cell of the pit at (1, 62, 0).
 */
function bottomWithFallingStack(clock: FakeClock) {
  const scene = ground([{ name: "cobblestone", count: 2 }], {
    clock,
    entities: { 9: { name: "item", position: new Vec3(1.5, 63.6, 0.5) } },
  });
  for (const y of [62, 63]) scene.world.setCell(new Vec3(1, y, 0), "air");
  const stack = scene.bot.entities[9]!;
  stack.getDroppedItem = droppedStack(scene.bot, "cobblestone", 5);
  return { ...scene, stack };
}

test("a plug cell waits for a falling stack to leave it, at most 2 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, harness, stack } = bottomWithFallingStack(clock);
  const stackWhenPlaced: number[] = [];
  const place: typeof placeSolidBlockInto = fakePlacement(harness, []);
  const placeAfterStack: typeof placeSolidBlockInto = async (...args) => {
    stackWhenPlaced.push(stack.position.y);
    return place(...args);
  };
  let ticks = 0;
  // Heard before the plug's own listener, as the stack moves before the client's tick looks at it.
  bot.on("physicsTick", () => {
    if (++ticks === 3) stack.position = new Vec3(1.5, 62.2, 0.5);
  });
  const seal = await clock.settle(sealDisposalHole(bot, new Vec3(1, 62, 0), placeAfterStack, {}), 2_000);
  assert.equal(seal.placed, 2);
  assert.ok(ticks >= 3, "the plug waited for the stack's ticks");
  assert.ok(stackWhenPlaced.every((y) => y < 63), `the stack was out of the cell when the block went in: ${stackWhenPlaced}`);
});

test("a stack that never leaves its plug cell does not hold the plug past the bound, ticks or not", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { bot, harness } = bottomWithFallingStack(clock);
  const startedAt = Date.now();

  const seal = await clock.settle(sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(harness, []), {}, { clearWaitMs: 60 }), 1_000);

  assert.equal(seal.placed, 2, "placed anyway once the wait ran out");
  assert.ok(Date.now() - startedAt >= 50, "it waited on the wall clock, with no tick to wake it");
});
