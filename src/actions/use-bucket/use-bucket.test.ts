import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../../test-support/bot.js";
import { FULL_CUBE, NO_SHAPE, type FakeBlock } from "../../test-support/world.js";
import prismarineBlock from "prismarine-block";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { parseUseBucketRequest } from "./contract.js";
import { beginUseBucket, formatUseBucketResult, useBucket, type UseBucketDependencies } from "./use-bucket.js";

const water = registry.blocksByName.water;
const lava = registry.blocksByName.lava;
const obsidian = registry.blocksByName.obsidian;

function key(position: { x: number; y: number; z: number }): string {
  return `${position.x},${position.y},${position.z}`;
}

/** A pool world: stone floor at y 63, a water source at 4,63,0 and lava sources at 8..9,63,0, air above. */
function poolWorld(held: string | null = null) {
  /** Cells as the tests name them; the reader below gives each its collision shape and properties. */
  const blocks = new Map<
    string,
    Pick<FakeBlock, "name" | "stateId" | "position"> & {
      boundingBox: "block" | "empty";
      getProperties?: FakeBlock["getProperties"];
    }
  >();
  const put = (position: Vec3, name: string, stateId: number, boundingBox: "block" | "empty") =>
    blocks.set(key(position), { name, stateId, boundingBox, position });
  for (let x = -2; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) put(new Vec3(x, 63, z), "stone", 1, "block");
  put(new Vec3(4, 63, 0), "water", water.minStateId, "empty");
  put(new Vec3(8, 63, 0), "lava", lava.minStateId, "empty");
  put(new Vec3(9, 63, 0), "lava", lava.minStateId, "empty");
  let hand: { name: string } | null = held ? { name: held } : null;
  const bot = botFixture(
    {
      items: [
        { name: "bucket", count: 1 },
        { name: "water_bucket", count: 1 },
      ],
      blocks: (position): FakeBlock => {
        const named = blocks.get(key(position)) ?? { name: "air", stateId: 0, boundingBox: "empty" as const, position };
        return { getProperties: () => ({}), ...named, shapes: named.boundingBox === "block" ? FULL_CUBE : NO_SHAPE };
      },
    },
    {
      findBlocks: ({ matching, point }: { matching: number; point?: Vec3 }) =>
        [...blocks.values()]
          .filter((block) => registry.blocksByName[block.name]?.id === matching)
          .filter((block) => !point || block.position.distanceTo(point) <= 10)
          .map((block) => block.position),
    },
  );
  Object.defineProperty(bot, "heldItem", { get: () => hand });
  const uses: unknown[] = [];
  const dependencies: UseBucketDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    world: {
      blockAt(x, y, z) {
        const block = bot.blockAt(new Vec3(x, y, z))!;
        const Block = prismarineBlock("1.21.4");
        // A cell named with properties is built from them; the rest keep their exact state id.
        const properties = block.getProperties();
        return observeMineflayerBlock(
          Object.keys(properties).length > 0
            ? Block.fromProperties(
                registry.blocksByName[block.name]!.id,
                Object.fromEntries(
                  Object.entries(properties).map(([name, value]) => [
                    name,
                    typeof value === "boolean" ? String(value) : value,
                  ]),
                ),
                0,
              )
            : Block.fromStateId(block.stateId, 0),
        );
      },
      revision: 0,
      subscribe: () => () => {},
    },
    explore: async (_bot, request) => {
      const positions = [...blocks.values()]
        .filter((block) => request.stateIds.has(block.stateId))
        .map((block) => block.position)
        .sort((left, right) => left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position));
      return positions.length > 0
        ? { kind: "found", positions, explored: false }
        : { kind: "none", reason: "nothing to explore in a test world" };
    },
    useItem: async (_bot, use) => {
      uses.push({ item: use.item.name, lookAt: use.lookAt });
      const resultItem = use.expectedHeldItem ?? use.expectedInventoryGain?.item;
      hand = resultItem ? { name: resultItem } : null;
      if (use.item.name === "water_bucket") {
        for (const cell of use.expectedCells ?? [])
          put(new Vec3(cell.position.x, cell.position.y, cell.position.z), "water", water.minStateId, "empty");
        // Water above the lava pool turns both sources to obsidian.
        put(new Vec3(8, 63, 0), "obsidian", obsidian.minStateId, "block");
        put(new Vec3(9, 63, 0), "obsidian", obsidian.minStateId, "block");
      }
      return { kind: "used" };
    },
  };
  return { bot, blocks, dependencies, uses };
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
  const { bot, dependencies, uses } = poolWorld("bucket");
  const result = await useBucket(bot, { action: "fill", liquid: "water", cell: null }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(uses, [{ item: "bucket", lookAt: new Vec3(4.5, 63.9, 0.5) }]);
  assert.equal(result.bucket.target?.x, 4);
  assert.equal(result.bucket.heldAfter, "water_bucket");
  assert.match(formatUseBucketResult(result), /Filled the bucket with \*\*water\*\*/);
});

test("fill keeps an already usable higher bank instead of walking into the pool", async () => {
  const { bot, blocks, dependencies } = poolWorld("bucket");
  blocks.delete("4,63,0");
  const source = new Vec3(4, 62, 0);
  blocks.set(key(source), { name: "water", stateId: water.minStateId, boundingBox: "empty", position: source });
  bot.entity.position.set(3.5, 64, 0.5);
  let routes = 0;
  const result = await useBucket(
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
  );
  assert.equal(result.status, "succeeded");
  assert.equal(routes, 0);
});

for (const plant of ["seagrass", "tall_seagrass", "kelp", "bubble_column", "glow_lichen"]) {
  test(`fill refuses a submerged ${plant} stance even when navigation reports completion`, async () => {
    const { bot, blocks, dependencies, uses } = poolWorld("bucket");
    blocks.clear();
    const source = new Vec3(4, 63, 0);
    blocks.set(key(source), { name: "water", stateId: water.minStateId, boundingBox: "empty", position: source });
    const feet = new Vec3(3, 63, 0);
    bot.entity.position.set(3.5, 63, 0.5);
    blocks.set(key(feet), {
      name: plant,
      stateId: registry.blocksByName[plant].minStateId,
      boundingBox: "empty",
      position: feet,
      getProperties: () => ({ waterlogged: true }),
    });
    const floor = feet.offset(0, -1, 0);
    blocks.set(key(floor), { name: "stone", stateId: 1, boundingBox: "block", position: floor });
    let routes = 0;
    const result = await useBucket(
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
    );
    assert.equal(result.status, "failed");
    assert.match(result.error, /BUCKET_NO_LINE_OF_SIGHT/);
    assert.equal(routes, 1);
    assert.equal(uses.length, 0);
  });
}

test("fill checks visible sources beyond the first three blocked candidates", async () => {
  const { bot, dependencies } = poolWorld("bucket");
  const result = await useBucket(
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
  const { bot, dependencies } = poolWorld();
  let routes = 0;
  const result = await useBucket(
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
  );
  if (result.status === "succeeded") assert.fail("a stone cell must not be scooped");
  assert.match(result.error, /BUCKET_NOT_A_SOURCE/);
  assert.equal(routes, 0);
});

test("a fill named at a flowing cell scoops the source feeding it", async () => {
  const { bot, blocks, dependencies, uses } = poolWorld("bucket");
  // Water spilling east from the source at 4,63,0 along the shelf above it.
  for (let x = 4; x <= 7; x += 1) {
    const position = new Vec3(x, 64, 0);
    blocks.set(`${x},64,0`, {
      name: "water",
      stateId: water.minStateId + (x - 3),
      boundingBox: "empty",
      position,
    });
  }

  const result = await useBucket(
    bot,
    { action: "fill", liquid: "water", cell: { x: 7, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.bucket.target, { x: 4, y: 63, z: 0 });
  assert.deepEqual(uses, [{ item: "bucket", lookAt: new Vec3(4.5, 63.9, 0.5) }]);
});

test("a pour named at a solid cell fails before the walk", async () => {
  const { bot, dependencies } = poolWorld("water_bucket");
  let routes = 0;
  const result = await useBucket(
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
  );
  if (result.status === "succeeded") assert.fail("a stone cell must not take a pour");
  assert.match(result.error, /BUCKET_TARGET_OCCUPIED/);
  assert.equal(routes, 0);
});

test("pour aims where the ray actually lands in the named cell, and counts the obsidian", async () => {
  const { bot, dependencies, uses } = poolWorld("water_bucket");
  const result = await useBucket(
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
  );

  assert.equal(result.status, "succeeded");
  // The shore cell beside the pool: the only ray that lands there is the one
  // onto the top of the stone under it.
  assert.equal(uses.length, 1);
  const use = uses[0] as { item: string; lookAt: Vec3 };
  assert.equal(use.item, "water_bucket");
  assert.deepEqual(use.lookAt, new Vec3(7.5, 64, 0.5));
  assert.deepEqual(result.bucket.aimedAt, { x: 7, y: 63, z: 0 });
  assert.equal(result.bucket.obsidianFormed, 2);
  assert.equal(result.bucket.cobblestoneFormed, 0);
  assert.match(formatUseBucketResult(result), /Formed: 2 obsidian, 0 cobblestone/);
});

test("pour refuses an occupied cell and reports the missing bucket", async () => {
  const { bot, dependencies } = poolWorld();
  const occupied = await useBucket(
    bot,
    { action: "pour", liquid: "water", cell: { x: 2, y: 63, z: 0 } },
    {},
    dependencies,
  );
  if (occupied.status === "succeeded") assert.fail("a stone cell must not take a pour");
  assert.match(occupied.error, /BUCKET_TARGET_OCCUPIED/);

  const missing = await useBucket(
    bot,
    { action: "pour", liquid: "lava", cell: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );
  if (missing.status === "succeeded") assert.fail("no lava bucket is carried");
  assert.match(missing.error, /BUCKET_MISSING\] Bot inventory holds no lava_bucket/);
});

/** A farm's water hole: one cell dug into the plot's soil, its floor one block lower. */
function holeWorld() {
  const world = poolWorld("water_bucket");
  world.blocks.set(key(new Vec3(6, 63, 0)), {
    name: "air",
    stateId: 0,
    boundingBox: "empty",
    position: new Vec3(6, 63, 0),
  });
  world.blocks.set(key(new Vec3(6, 62, 0)), {
    name: "stone",
    stateId: 1,
    boundingBox: "block",
    position: new Vec3(6, 62, 0),
  });
  return world;
}

test("a pour whose route ended too far for any face steps closer instead of refusing", async () => {
  const { bot, dependencies, uses } = holeWorld();
  // The first route ends four cells back, where the rim hides every face; the second ends beside the hole.
  bot.entity.position.set(6.5, 64, 8.5);
  const stands = [new Vec3(6.5, 64, 4.5), new Vec3(6.5, 64, 1.5)];
  let routes = 0;
  const result = await useBucket(
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
  const { bot, dependencies } = holeWorld();
  bot.entity.position.set(6.5, 64, 4.5);
  const result = await useBucket(
    bot,
    { action: "pour", liquid: "water", cell: { x: 6, y: 63, z: 0 } },
    {},
    {
      ...dependencies,
      // A route that cannot get closer than where the bot already stands.
      navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    },
  );
  if (result.status === "succeeded") assert.fail("a rim that hides the floor from every stance has no face");
  assert.match(result.error, /BUCKET_NO_FACE/);
});

/** The pool world with a useItem that also moves the bucket counts as the server does, and a navigate that arrives. */
function bucketRequestWorld(held: string) {
  const world = poolWorld(held);
  const stacks = world.bot.inventory.items();
  const count = (name: string) => stacks.find((stack) => stack.name === name)!;
  const shiftBuckets = (filling: boolean) => {
    count("bucket").count += filling ? -1 : 1;
    count("water_bucket").count += filling ? 1 : -1;
  };
  const useItem = world.dependencies.useItem;
  const dependencies: UseBucketDependencies = {
    ...world.dependencies,
    navigate: async () => {
      world.bot.entity.position.set(6.5, 64, 0.5);
      return { status: "completed", elapsedMs: 0 };
    },
    useItem: async (bot, use) => {
      const used = await useItem(bot, use);
      shiftBuckets(use.item.name === "bucket");
      // A scoop takes the source out of its cell, as the game does: the cell is what proves a resumed fill.
      if (use.item.name === "bucket" && use.lookAt) world.blocks.delete(key(new Vec3(use.lookAt.x, use.lookAt.y, use.lookAt.z).floored()));
      return used;
    },
  };
  return { ...world, dependencies, count };
}

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function bucketAttempts(world: ReturnType<typeof bucketRequestWorld>, request: Parameters<typeof beginUseBucket>[1]) {
  const run = beginUseBucket(world.bot, request, () => {}, world.dependencies);
  return (signal?: AbortSignal) => run({ signal });
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
  assert.equal(world.count("water_bucket").count, 0);
  assert.equal(result.bucket.obsidianFormed, 2);
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
  assert.equal(world.count("water_bucket").count, 2);
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
  world.blocks.delete("4,63,0");
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
  world.count("water_bucket").count = 2;
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.count("water_bucket").count -= 1; // the footing reflex poured one into the sea: counts moved, our cell did not
  world.count("bucket").count += 1;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the pour is cast again");
  assert.equal(result.bucket.targetAfter, "water");
});

test("a fill resumed after the bucket counts changed elsewhere with its source still in place scoops again", async () => {
  const world = bucketRequestWorld("bucket");
  world.count("bucket").count = 2;
  const owner = new AbortController();
  owner.abort(new Error("hunger reflex")); // taken before the attempt's first step: nothing was cast
  const attempt = bucketAttempts(world, { action: "fill", liquid: "water", cell: { x: 4, y: 63, z: 0 } });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.count("bucket").count -= 1; // another scoop elsewhere: counts moved, the named source is still there
  world.count("water_bucket").count += 1;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the scoop is cast again");
});

const LAVA_BESIDE_POOL = new Vec3(7, 64, 0);
const POUR_INTO_LAVA = { action: "pour", liquid: "water", cell: { x: 7, y: 64, z: 0 } } as const;

/** A lava source in the pour's cell, as a lava cover over the pit is. */
function lavaInPourCell(world: ReturnType<typeof bucketRequestWorld>): void {
  world.blocks.set(key(LAVA_BESIDE_POOL), {
    name: "lava",
    stateId: lava.minStateId,
    boundingBox: "empty",
    position: LAVA_BESIDE_POOL,
  });
}

/** The pour's cell becomes `name` once the cast lands, as the game makes a block of lava and water meeting. */
function pourMakes(world: ReturnType<typeof bucketRequestWorld>, name: string, stateId: number, box: "block" | "empty") {
  const useItem = world.dependencies.useItem;
  world.dependencies = {
    ...world.dependencies,
    useItem: async (bot, use) => {
      const used = await useItem(bot, use);
      world.blocks.set(key(LAVA_BESIDE_POOL), { name, stateId, boundingBox: box, position: LAVA_BESIDE_POOL });
      return used;
    },
  };
}

test("a lava cover cut after the cast whose cell turned to stone is not poured again", async () => {
  const world = bucketRequestWorld("water_bucket");
  lavaInPourCell(world);
  pourMakes(world, "stone", 1, "block");
  const owner = new AbortController();
  abortAfterUse(world, owner);
  const attempt = bucketAttempts(world, POUR_INTO_LAVA);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "one cast in total");
  assert.equal(result.bucket.targetBefore, "lava");
  assert.equal(result.bucket.targetAfter, "stone");
});

test("a pour cut after the cast whose lava cell still holds lava is cast again", async () => {
  const world = bucketRequestWorld("water_bucket");
  lavaInPourCell(world);
  world.count("water_bucket").count = 2;
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_INTO_LAVA);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.count("water_bucket").count -= 1; // a footing pour elsewhere moved the counts, not this cell
  world.count("bucket").count += 1;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(world.uses.length, 1, "the pour is cast again");
});

test("a pour cut after the cast whose cell holds flowing water now is cast again", async () => {
  const world = bucketRequestWorld("water_bucket");
  lavaInPourCell(world);
  // Flowing water has no collision box and is not a source: it does not show this pour.
  pourMakes(world, "water", water.minStateId + 1, "empty");
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
  world.count("water_bucket").count = 2;
  const owner = new AbortController();
  abortInRoute(world, owner);
  const attempt = bucketAttempts(world, POUR_BESIDE_POOL);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  world.count("water_bucket").count -= 1;
  world.count("bucket").count += 1;
  const blockAt = world.bot.blockAt.bind(world.bot);
  world.bot.blockAt = (position: Vec3) => (key(position.floored()) === key(new Vec3(7, 64, 0)) ? null : blockAt(position));
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /BUCKET_TARGET_UNLOADED/);
  assert.equal(world.uses.length, 0);
});
