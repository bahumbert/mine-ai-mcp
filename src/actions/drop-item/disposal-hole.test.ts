import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { blockClass } from "../../navigation/mineflayer/world.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { prepareDisposalHole, observeHoleDrops, sealDisposalHole, snapshotDroppedCounts } from "./disposal-hole.js";

const registry = minecraftData("1.21.4");
const Block = blockClass({ registry } as Pick<Bot, "registry">);

function ground(carried: { name: string; count: number }[] = []) {
  const changed = new Map<string, string>();
  const bot = {
    registry,
    entity: { position: new Vec3(0.5, 64, 0.5), onGround: true },
    inventory: { items: () => carried },
    blockAt(position: Vec3) {
      const name = changed.get(position.toString()) ?? (position.y < 64 ? "dirt" : "air");
      return Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);
    },
    lookAt: async () => {},
  } as unknown as Bot;
  return { bot, changed };
}

/** A placement that fills the cell with the chosen item and spends one of it. */
function fakePlacement(changed: Map<string, string>, placed: { cell: Vec3; item: string }[]) {
  return (async (bot: Bot, cell: { x: number; y: number; z: number }, item: { name: string; count: number } | null) => {
    if (!item) return { kind: "failed" as const, error: "no item" };
    const position = new Vec3(cell.x, cell.y, cell.z);
    placed.push({ cell: position, item: item.name });
    changed.set(position.toString(), item.name);
    item.count -= 1;
    // Mineflayer drops a spent stack from the inventory rather than listing it at zero.
    const carried = bot.inventory.items() as unknown as { count: number }[];
    if (item.count === 0) carried.splice(carried.indexOf(item), 1);
    return { kind: "placed" as const, block: bot.blockAt(position)! };
  }) as never;
}

test("the shaft above the discards is plugged first, then the ground-level cell", async () => {
  const { bot, changed } = ground([
    { name: "oak_log", count: 5 },
    { name: "cobblestone", count: 2 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {});

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
  const { bot, changed } = ground([
    { name: "dirt", count: 1 },
    { name: "sand", count: 64 },
    { name: "crafting_table", count: 1 },
    { name: "stick", count: 3 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {});

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
  const { bot, changed } = ground();
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, []), {});

  assert.equal(seal.placed, 0);
  assert.equal(seal.item, null);
  assert.match(seal.error ?? "", /DROP_HOLE_OPEN/);
});

test("hole preparation refuses liquid beside its shaft without digging", async () => {
  const { bot, changed } = ground();
  for (const [x, z] of [
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
  ])
    changed.set(new Vec3(x, 62, z).toString(), "water");
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
  const { bot, changed } = ground();
  const stop = new AbortController();
  const digs: number[] = [];
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        digs.push(position.y);
        changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
        stop.abort(new Error("stop disposal"));
        return { status: "broken" };
      },
      { signal: stop.signal },
    ),
    /stop disposal/,
  );
  assert.deepEqual(digs, [63]);
});

test("a tunnel wall is excavated above an enclosed disposal pit", async () => {
  const { bot, changed } = ground();
  changed.set(new Vec3(1, 64, 0).toString(), "stone");
  changed.set(new Vec3(1, 65, 0).toString(), "stone");
  const digs: number[] = [];
  const bottom = await prepareDisposalHole(
    bot,
    createMovementPolicy(),
    async ({ position }) => {
      digs.push(position.y);
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    {},
  );
  assert.deepEqual(bottom, new Vec3(1, 62, 0));
  assert.deepEqual(digs, [65, 64, 63, 62]);
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "dirt");
});

test("hole evidence counts merged stack growth and ignores existing items", async () => {
  const entity = { id: 1, position: new Vec3(1.5, 62, 0.5), getDroppedItem: () => ({ name: "dirt", count: 2 }) };
  const bot = Object.assign(new EventEmitter(), { entities: { 1: entity } }) as unknown as Bot;
  const baseline = snapshotDroppedCounts(bot);
  entity.getDroppedItem = () => ({ name: "dirt", count: 12 });
  assert.equal(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
    ),
    true,
  );
  entity.getDroppedItem = () => ({ name: "dirt", count: 2 });
  assert.equal(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
      50,
    ),
    false,
  );
});

/** Water over the pit layer around the bot, so no cell within `radius` blocks fits a pit. */
function floodAround(changed: Map<string, string>, radius: number) {
  for (let x = -radius; x <= radius; x++)
    for (let z = -radius; z <= radius; z++) changed.set(new Vec3(x, 62, z).toString(), "water");
}

test("a pit is dug at the nearest fit stance when none beside the feet fits", async () => {
  const { bot, changed } = ground();
  floodAround(changed, 4);
  const moves: Vec3[] = [];
  const digs: Vec3[] = [];
  const bottom = await prepareDisposalHole(
    bot,
    createMovementPolicy(),
    async ({ position }) => {
      digs.push(new Vec3(position.x, position.y, position.z));
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    {},
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
  const { bot, changed } = ground();
  Object.assign(bot, { game: { dimension: "overworld" } });
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
  const bottom = await prepareDisposalHole(
    bot,
    createMovementPolicy(),
    async ({ position }) => {
      digs.push(new Vec3(position.x, position.y, position.z));
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    {},
    async (stance) => {
      bot.entity.position = stance.offset(0.5, 0, 0.5);
      return undefined;
    },
  );
  for (const cell of [bottom, ...digs]) assert.ok(Math.max(Math.abs(cell.x), Math.abs(cell.z)) > 3, `${cell} is outside`);
});

test("nothing within eight blocks that fits reports the radius", async () => {
  const { bot, changed } = ground();
  floodAround(changed, 12);
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
