import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { createFakeBot, itemOf, type FakeCell, type FakeClock } from "../../test-support/fake-bot/index.js";
import { parseUseBucketRequest } from "./contract.js";
import { beginUseBucket, formatUseBucketResult, useBucket, type UseBucketDependencies } from "./use-bucket.js";

function key(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

/** The hotbar slot the bot holds: the first of the quick bar. */
const HELD_SLOT = 36;

/** Stone floor at y 63 and a water source at 4,63,0, lava sources at 8..9,63,0; open air everywhere else. */
function poolCells(): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = -2; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) cells[key({ x, y: 63, z })] = "stone";
  cells["4,63,0"] = "water";
  cells["8,63,0"] = "lava";
  cells["9,63,0"] = "lava";
  return cells;
}

/** Run a call that waits on physics ticks (a pour counting what it formed) while the clock supplies the ticks. */
async function driven<T>(clock: FakeClock, call: Promise<T>): Promise<T> {
  const outcome = call.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await clock.advance(5_000);
  const settled = await outcome;
  if ("error" in settled) throw settled.error;
  return settled.value;
}

/** A pool world: a bucket and a full water bucket carried (`held` in hand), the server's answer to a cast scripted. */
function poolWorld(held: string | null = null, cells: Record<string, FakeCell> = poolCells()) {
  const slots: Record<number, { name: string }> =
    held === "bucket"
      ? { [HELD_SLOT]: { name: "bucket" }, 37: { name: "water_bucket" } }
      : held === "water_bucket"
        ? { [HELD_SLOT]: { name: "water_bucket" }, 37: { name: "bucket" } }
        : { 37: { name: "bucket" }, 38: { name: "water_bucket" } };
  const { bot, clock, world, inventory } = createFakeBot({ groundY: null, cells, slots });
  const { registry } = bot;
  const setSlot = (slot: number, item: Item | null) =>
    (inventory.updateSlot as (slot: number, item: Item | null) => void).call(inventory, slot, item);
  const carried = (name: string) => inventory.count(registry.itemsByName[name]!.id, null);
  /** Set the carried count of `name`, as the server redraws the slots. */
  const setCarried = (name: string, count: number) => setCarriedCount(inventory, registry, registry.itemsByName[name]!.id, count);
  const uses: unknown[] = [];
  const dependencies: UseBucketDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    world: {
      blockAt: (x, y, z) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
      revision: 0,
      subscribe: () => () => {},
    },
    explore: async (_bot, request) => {
      const positions: Vec3[] = [];
      for (let x = -2; x <= 12; x += 1)
        for (let y = 60; y <= 66; y += 1)
          for (let z = -2; z <= 2; z += 1) {
            const cell = new Vec3(x, y, z);
            if (request.stateIds.has(bot.world.getBlockStateId(cell))) positions.push(cell);
          }
      positions.sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position));
      return positions.length > 0
        ? { kind: "found", positions, explored: false }
        : { kind: "none", reason: "nothing to explore in a test world" };
    },
    useItem: async (_bot, use) => {
      uses.push({ item: use.item.name, lookAt: use.lookAt });
      // The server's side of the use: the stack used becomes the result in its slot (one of a larger stack is spent,
      // the result goes to a free slot).
      const result = use.expectedHeldItem ?? use.expectedInventoryGain?.item;
      if (use.item.count > 1) {
        setSlot(use.item.slot, itemOf(registry, use.item.name, use.item.count - 1));
        if (result) setCarried(result, carried(result) + 1);
      } else setSlot(use.item.slot, result ? itemOf(registry, result) : null);
      if (use.item.name === "water_bucket") {
        for (const cell of use.expectedCells ?? []) world.setCell(new Vec3(cell.position.x, cell.position.y, cell.position.z), "water");
        // Water above the lava pool turns both sources to obsidian.
        world.setCell(new Vec3(8, 63, 0), "obsidian");
        world.setCell(new Vec3(9, 63, 0), "obsidian");
      }
      return { kind: "used" };
    },
  };
  return {
    bot,
    clock,
    dependencies,
    uses,
    setCell: world.setCell,
    carried,
    setCarried,
    drive: <T>(call: Promise<T>) => driven(clock, call),
  };
}

test("parses fill without a cell and pour with one, and refuses a partial cell", () => {
  assert.deepEqual(parseUseBucketRequest({ action: "fill" }), { action: "fill", liquid: "water", cell: null });
  assert.deepEqual(parseUseBucketRequest({ action: "pour", liquid: "lava", x: 1, y: 2, z: 3 }), {
    action: "pour",
    liquid: "lava",
    cell: { x: 1, y: 2, z: 3 },
  });
  assert.throws(() => parseUseBucketRequest({ action: "pour" }), /pour needs/);
  assert.throws(() => parseUseBucketRequest({ action: "fill", x: 1 }), /all three/);
});

test("fill finds the nearest source, looks at its surface, and confirms the full bucket", async () => {
  const { bot, dependencies, uses, drive } = poolWorld("bucket");
  const result = await drive(useBucket(bot, { action: "fill", liquid: "water", cell: null }, {}, dependencies));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(uses, [{ item: "bucket", lookAt: new Vec3(4.5, 63.9, 0.5) }]);
  assert.equal(result.bucket.target?.x, 4);
  assert.equal(result.bucket.heldAfter, "water_bucket");
  assert.match(formatUseBucketResult(result), /Filled the bucket with \*\*water\*\*/);
});

test("fill keeps an already usable higher bank instead of walking into the pool", async () => {
  const { bot, setCell, dependencies, drive } = poolWorld("bucket");
  setCell(new Vec3(4, 63, 0), "air");
  setCell(new Vec3(4, 62, 0), "water");
  bot.entity.position.set(3.5, 64, 0.5);
  let routes = 0;
  const result = await drive(
    useBucket(
      bot,
      { action: "fill", liquid: "water", cell: null },
      {},
      {
        ...dependencies,
        navigate: async () => {
          routes += 1;
          return { status: "stopped", reason: "should stay on shore", elapsedMs: 0 };
        },
      },
    ),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(routes, 0);
});

for (const plant of ["seagrass", "tall_seagrass", "kelp", "bubble_column", "glow_lichen"]) {
  test(`fill refuses a submerged ${plant} stance even when navigation reports completion`, async () => {
    // Only the water source, the plant at the feet and the stone under it: the rest of the pool world is open air.
    const plantCell: FakeCell = plant === "glow_lichen" ? { name: plant, properties: { waterlogged: true } } : plant;
    const { bot, dependencies, uses, drive } = poolWorld("bucket", { "4,63,0": "water", "3,63,0": plantCell, "3,62,0": "stone" });
    bot.entity.position.set(3.5, 63, 0.5);
    let routes = 0;
    const result = await drive(
      useBucket(
        bot,
        { action: "fill", liquid: "water", cell: null },
        {},
        {
          ...dependencies,
          navigate: async () => {
            routes += 1;
            return { status: "completed", elapsedMs: 0 };
          },
        },
      ),
    );
    assert.equal(result.status, "failed");
    assert.match(result.error, /BUCKET_NO_LINE_OF_SIGHT/);
    assert.equal(routes, 1);
    assert.equal(uses.length, 0);
  });
}

test("fill checks visible sources beyond the first three blocked candidates", async () => {
  const { bot, dependencies, drive } = poolWorld("bucket");
  const result = await drive(
    useBucket(
      bot,
      { action: "fill", liquid: "water", cell: null },
      {},
      {
        ...dependencies,
        explore: async () => ({
          kind: "found",
          explored: false,
          positions: [new Vec3(30, 63, 0), new Vec3(31, 63, 0), new Vec3(32, 63, 0), new Vec3(4, 63, 0)],
        }),
      },
    ),
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.bucket.target, { x: 4, y: 63, z: 0 });
});

/**
 * Run 10 named a flowing cell and the action walked five seconds to it,
 * digging with the pickaxe on the way, before reading the block and refusing
 * it. A cell that is already wrong is wrong now.
 */
test("fill refuses a named cell that is not a source, without walking to it", async () => {
  const { bot, dependencies, drive } = poolWorld();
  let routes = 0;
  const result = await drive(
    useBucket(
      bot,
      { action: "fill", liquid: "water", cell: { x: 5, y: 63, z: 0 } },
      {},
      {
        ...dependencies,
        navigate: async () => {
          routes += 1;
          return { status: "completed", elapsedMs: 0 };
        },
      },
    ),
  );
  if (result.status === "succeeded") assert.fail("a stone cell must not be scooped");
  assert.match(result.error, /BUCKET_NOT_A_SOURCE/);
  assert.equal(routes, 0);
});

test("a fill named at a flowing cell scoops the source feeding it", async () => {
  const { bot, setCell, dependencies, uses, drive } = poolWorld("bucket");
  // Water spilling east from the source at 4,63,0 along the shelf above it.
  for (let x = 4; x <= 7; x += 1) setCell(new Vec3(x, 64, 0), { name: "water", properties: { level: x - 3 } });

  const result = await drive(useBucket(bot, { action: "fill", liquid: "water", cell: { x: 7, y: 64, z: 0 } }, {}, dependencies));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.bucket.target, { x: 4, y: 63, z: 0 });
  assert.deepEqual(uses, [{ item: "bucket", lookAt: new Vec3(4.5, 63.9, 0.5) }]);
});

test("a pour named at a solid cell fails before the walk", async () => {
  const { bot, dependencies, drive } = poolWorld("water_bucket");
  let routes = 0;
  const result = await drive(
    useBucket(
      bot,
      { action: "pour", liquid: "water", cell: { x: 5, y: 63, z: 0 } },
      {},
      {
        ...dependencies,
        navigate: async () => {
          routes += 1;
          return { status: "completed", elapsedMs: 0 };
        },
      },
    ),
  );
  if (result.status === "succeeded") assert.fail("a stone cell must not take a pour");
  assert.match(result.error, /BUCKET_TARGET_OCCUPIED/);
  assert.equal(routes, 0);
});

test("pour aims where the ray actually lands in the named cell, and counts the obsidian", async () => {
  const { bot, dependencies, uses, drive } = poolWorld("water_bucket");
  const result = await drive(
    useBucket(
      bot,
      { action: "pour", liquid: "water", cell: { x: 7, y: 64, z: 0 } },
      {},
      {
        ...dependencies,
        // A route that arrives, because where the bot stands is what decides
        // whether any ray reaches the named cell at all.
        navigate: async () => {
          bot.entity.position.set(6.5, 64, 0.5);
          return { status: "completed", elapsedMs: 0 };
        },
      },
    ),
  );

  assert.equal(result.status, "succeeded");
  // The shore cell beside the pool: the only ray that lands there is the one
  // onto the top of the stone under it.
  assert.equal(uses.length, 1);
  const use = uses[0] as { item: string; lookAt: Vec3 };
  assert.equal(use.item, "water_bucket");
  assert.deepEqual(use.lookAt, new Vec3(7.5, 64, 0.5));
  assert.deepEqual(result.bucket.aimedAt, { x: 7, y: 63, z: 0 });
  assert.deepEqual(result.bucket.formed, { obsidian: 2 });
  assert.match(formatUseBucketResult(result), /Formed: 2 obsidian$/m);
});

test("pour refuses an occupied cell and reports the missing bucket", async () => {
  const { bot, dependencies, drive } = poolWorld();
  const occupied = await drive(
    useBucket(bot, { action: "pour", liquid: "water", cell: { x: 2, y: 63, z: 0 } }, {}, dependencies),
  );
  if (occupied.status === "succeeded") assert.fail("a stone cell must not take a pour");
  assert.match(occupied.error, /BUCKET_TARGET_OCCUPIED/);

  const missing = await drive(
    useBucket(bot, { action: "pour", liquid: "lava", cell: { x: 2, y: 64, z: 0 } }, {}, dependencies),
  );
  if (missing.status === "succeeded") assert.fail("no lava bucket is carried");
  assert.match(missing.error, /BUCKET_MISSING\] Bot inventory holds no lava_bucket/);
});

/** A farm's water hole: one cell dug into the plot's soil, its floor one block lower. */
function holeWorld() {
  const world = poolWorld("water_bucket");
  world.setCell(new Vec3(6, 63, 0), "air");
  world.setCell(new Vec3(6, 62, 0), "stone");
  return world;
}

test("a pour whose route ended too far for any face steps closer instead of refusing", async () => {
  const { bot, dependencies, uses, drive } = holeWorld();
  // The first route ends four cells back, where the rim hides every face; the second ends beside the hole.
  bot.entity.position.set(6.5, 64, 8.5);
  const stands = [new Vec3(6.5, 64, 4.5), new Vec3(6.5, 64, 1.5)];
  let routes = 0;
  const result = await drive(
    useBucket(
      bot,
      { action: "pour", liquid: "water", cell: { x: 6, y: 63, z: 0 } },
      {},
      {
        ...dependencies,
        navigate: async () => {
          bot.entity.position.set(...(stands[Math.min(routes, stands.length - 1)]!.toArray() as [number, number, number]));
          routes += 1;
          return { status: "completed", elapsedMs: 0 };
        },
      },
    ),
  );

  // From four blocks back no face of the hole is in reach: the first stance has nothing to pour against.
  assert.equal(result.status, "succeeded");
  assert.equal(routes, 2);
  assert.equal(uses.length, 1);
  // The face is one of the hole's own walls or its floor, seen from the second stance.
  const aimed = result.bucket.aimedAt!;
  assert.equal(Math.abs(aimed.x - 6) + Math.abs(aimed.y - 63) + Math.abs(aimed.z), 1);
});

test("a pour with no face even from the nearest stance still names the missing face", async () => {
  const { bot, dependencies, drive } = holeWorld();
  bot.entity.position.set(6.5, 64, 4.5);
  const result = await drive(
    useBucket(
      bot,
      { action: "pour", liquid: "water", cell: { x: 6, y: 63, z: 0 } },
      {},
      {
        ...dependencies,
        // A route that cannot get closer than where the bot already stands.
        navigate: async () => ({ status: "completed", elapsedMs: 0 }),
      },
    ),
  );
  if (result.status === "succeeded") assert.fail("a rim that hides the floor from every stance has no face");
  assert.match(result.error, /BUCKET_NO_FACE/);
});

/** The pool world with a useItem that also takes a scooped source out of its cell, and a navigate that arrives. */
function bucketRequestWorld(held: string, cells: Record<string, FakeCell> = poolCells()) {
  const world = poolWorld(held, cells);
  const useItem = world.dependencies.useItem;
  const dependencies: UseBucketDependencies = {
    ...world.dependencies,
    navigate: async () => {
      world.bot.entity.position.set(6.5, 64, 0.5);
      return { status: "completed", elapsedMs: 0 };
    },
    useItem: async (bot, use) => {
      const used = await useItem(bot, use);
      // A scoop takes the source out of its cell, as the game does: the cell is what proves a resumed fill.
      if (use.item.name === "bucket" && use.lookAt) world.setCell(new Vec3(use.lookAt.x, use.lookAt.y, use.lookAt.z).floored(), "air");
      return used;
    },
  };
  return { ...world, dependencies };
}

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function bucketAttempts(world: ReturnType<typeof bucketRequestWorld>, request: Parameters<typeof beginUseBucket>[1]) {
  const run = beginUseBucket(world.bot, request, () => {}, world.dependencies);
  return (signal?: AbortSignal) => world.drive(run({ signal }));
}

/** Makes the world's first useItem abort the request right after its effect, as a reflex taking the body would. */
function abortAfterUse(world: ReturnType<typeof bucketRequestWorld>, owner: AbortController): void {
  const useItem = world.dependencies.useItem;
  let casts = 0;
  world.dependencies = {
    ...world.dependencies,
    useItem: async (bot, use) => {
      const used = await useItem(bot, use);
      if (casts++ > 0) return used;
      owner.abort(new Error("hunger reflex"));
      throw owner.signal.reason;
    },
  };
}

const POUR_BESIDE_POOL = { action: "pour", liquid: "water", cell: { x: 7, y: 64, z: 0 } } as const;

test("a pour cut off right after the water landed is not poured again and still counts the obsidian", async () => {
  const world = bucketRequestWorld("water_bucket");
  const owner = new AbortController();
  abortAfterUse(world, owner);
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1);
  assert.equal(world.carried("water_bucket"), 0);
  assert.deepEqual(result.bucket.formed, { obsidian: 2 });
  assert.deepEqual(result.bucket.aimedAt, { x: 7, y: 63, z: 0 });
  assert.equal(result.bucket.used, true);
});

test("a fill cut off right after the scoop is not scooped again and keeps its source cell", async () => {
  const world = bucketRequestWorld("bucket");
  const owner = new AbortController();
  abortAfterUse(world, owner);
  const attempt = bucketAttempts(world, { action: "fill", liquid: "water", cell: null });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1);
  assert.equal(result.bucket.target?.x, 4);
  assert.equal(world.carried("water_bucket"), 2);
});

test("a fill whose source was drained between attempts says so and uses nothing", async () => {
  const world = bucketRequestWorld("bucket");
  const owner = new AbortController();
  const explore = world.dependencies.explore;
  let searches = 0;
  world.dependencies = {
    ...world.dependencies,
    explore: async (bot, request) => {
      if (searches++ > 0) return explore(bot, request);
      owner.abort(new Error("fall reflex"));
      throw owner.signal.reason;
    },
  };
  const attempt = bucketAttempts(world, { action: "fill", liquid: "water", cell: null });

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  world.setCell(new Vec3(4, 63, 0), "air");
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /BUCKET_NO_SOURCE/);
  assert.equal(world.uses.length, 0);
});

test("a second call after a completed pour returns the success without pouring", async () => {
  const world = bucketRequestWorld("water_bucket");
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(world.uses.length, 1);
  assert.deepEqual(second.bucket, first.bucket);
});

test("a pour that was refused is tried again by the next attempt, not counted as done", async () => {
  const world = bucketRequestWorld("water_bucket");
  const attempt = bucketAttempts(world, { action: "pour", liquid: "water", cell: { x: 5, y: 63, z: 0 } });

  const refused = await attempt();
  const again = await attempt();

  assert.equal(refused.status, "failed");
  assert.equal(again.status, "failed");
  assert.equal(world.uses.length, 0);
});

/** The body is taken during the route, before any cast: the first attempt ends with nothing used. */
function abortInRoute(world: ReturnType<typeof bucketRequestWorld>, owner: AbortController): void {
  const navigate = world.dependencies.navigate;
  let routes = 0;
  world.dependencies = {
    ...world.dependencies,
    navigate: async (request) => {
      if (routes++ > 0) return navigate(request);
      owner.abort(new Error("hunger reflex"));
      throw owner.signal.reason;
    },
  };
}

test("a pour resumed after the bucket counts changed elsewhere (a footing pour) but with its cell still empty pours again", async () => {
  const world = bucketRequestWorld("water_bucket");
  world.setCarried("water_bucket", 2);
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.setCarried("water_bucket", world.carried("water_bucket") - 1); // the footing reflex poured one into the sea: counts moved, our cell did not
  world.setCarried("bucket", world.carried("bucket") + 1);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the pour is cast again");
  assert.equal(result.bucket.targetAfter, "water");
});

test("a fill resumed after the bucket counts changed elsewhere with its source still in place scoops again", async () => {
  const world = bucketRequestWorld("bucket");
  world.setCarried("bucket", 2);
  const owner = new AbortController();
  owner.abort(new Error("hunger reflex")); // taken before the attempt's first step: nothing was cast
  const attempt = bucketAttempts(world, { action: "fill", liquid: "water", cell: { x: 4, y: 63, z: 0 } });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.setCarried("bucket", world.carried("bucket") - 1); // another scoop elsewhere: counts moved, the named source is still there
  world.setCarried("water_bucket", world.carried("water_bucket") + 1);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the scoop is cast again");
});

const LAVA_BESIDE_POOL = new Vec3(7, 64, 0);
const POUR_INTO_LAVA = { action: "pour", liquid: "water", cell: { x: 7, y: 64, z: 0 } } as const;

/** The pool with a lava source in the pour's cell, as a lava cover over the pit is: a start cell, which the fake never flows (lava set later would spread over the bot's footing in 30 ticks). */
function bucketWorldWithLavaInPourCell(held: string) {
  return bucketRequestWorld(held, { ...poolCells(), [key(LAVA_BESIDE_POOL)]: "lava" });
}

/** The pour's cell becomes `cell` once the cast lands, as the game makes a block of lava and water meeting. */
function pourMakes(world: ReturnType<typeof bucketRequestWorld>, cell: FakeCell) {
  const useItem = world.dependencies.useItem;
  world.dependencies = {
    ...world.dependencies,
    useItem: async (bot, use) => {
      const used = await useItem(bot, use);
      world.setCell(LAVA_BESIDE_POOL, cell);
      return used;
    },
  };
}

test("a lava cover cut after the cast whose cell turned to stone is not poured again", async () => {
  const world = bucketWorldWithLavaInPourCell("water_bucket");
  pourMakes(world, "stone");
  const owner = new AbortController();
  abortAfterUse(world, owner);
  const attempt = bucketAttempts(world, POUR_INTO_LAVA);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "one cast in total");
  assert.equal(result.bucket.targetBefore, "lava");
  assert.equal(result.bucket.targetAfter, "stone");
  assert.deepEqual(result.bucket.formed, { obsidian: 2, stone: 1 }, "the resumed attempt counts from the cut attempt's watch");
});

test("a pour cut after the cast whose lava cell still holds lava is cast again", async () => {
  const world = bucketWorldWithLavaInPourCell("water_bucket");
  world.setCarried("water_bucket", 2);
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_INTO_LAVA);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.setCarried("water_bucket", world.carried("water_bucket") - 1); // a footing pour elsewhere moved the counts, not this cell
  world.setCarried("bucket", world.carried("bucket") + 1);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the pour is cast again");
});

test("a pour cut after the cast whose cell holds flowing water now is cast again", async () => {
  const world = bucketWorldWithLavaInPourCell("water_bucket");
  // A second full bucket is carried: the first one is an empty bucket after its cast, as the game has it.
  world.setCarried("water_bucket", 2);
  // Flowing water has no collision box and is not a source: it does not show this pour.
  pourMakes(world, { name: "water", properties: { level: 1 } });
  const owner = new AbortController();
  abortAfterUse(world, owner);
  const attempt = bucketAttempts(world, POUR_INTO_LAVA);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(world.uses.length, 2, "the first cast and the resumed one");
  assert.equal(result.status, "succeeded");
});

test("a pour resumed while its cell is unloaded is refused as unloaded, not read as done", async () => {
  const world = bucketRequestWorld("water_bucket");
  world.setCarried("water_bucket", 2);
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.setCarried("water_bucket", world.carried("water_bucket") - 1);
  world.setCarried("bucket", world.carried("bucket") + 1);
  world.setCell(new Vec3(7, 64, 0), "void");
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /BUCKET_TARGET_UNLOADED/);
  assert.equal(world.uses.length, 0);
});
