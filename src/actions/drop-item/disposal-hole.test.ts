import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { blockClass } from "../../navigation/mineflayer/world.js";
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

const registry = minecraftData("1.21.4");
const Block = blockClass({ registry } as Pick<Bot, "registry">);

function ground(carried: { name: string; count: number }[] = []) {
  const changed = new Map<string, string>();
  const bot = {
    registry,
    version: "1.21.4",
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

test("the plug uses the kept item before the policy's first scaffold block", async () => {
  const { bot, changed } = ground([
    { name: "dirt", count: 5 },
    { name: "oak_planks", count: 2 },
  ]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {}, { plugItem: "oak_planks" });

  assert.deepEqual(seal, { item: "oak_planks", placed: 2 });
  assert.deepEqual(placed.map((entry) => entry.item), ["oak_planks", "oak_planks"]);
});

test("with no policy block carried, a common-stock block plugs the hole", async () => {
  const { bot, changed } = ground([{ name: "oak_planks", count: 2 }, { name: "oak_log", count: 9 }]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const placed: { cell: Vec3; item: string }[] = [];

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, placed), {});

  assert.deepEqual(seal, { item: "oak_planks", placed: 2 });
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
  assert.deepEqual(
    await observeHoleDrops(
      bot,
      { x: 1, y: 62, z: 0 },
      baseline,
      [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
      {},
    ),
    { landed: true, entityIds: [1] },
  );
  entity.getDroppedItem = () => ({ name: "dirt", count: 2 });
  assert.equal(
    (
      await observeHoleDrops(
        bot,
        { x: 1, y: 62, z: 0 },
        baseline,
        [{ item: "dirt", requested: 10, carriedBefore: 10, carriedAfter: 0, dropped: 10 }],
        {},
        50,
      )
    ).landed,
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

test("a pit that holds a dropped item is skipped for the next one (live 2026-10-10 run 8: buried items came back)", async () => {
  const { bot, changed } = ground();
  const item = { id: 5, name: "item", position: new Vec3(1.5, 62.1, 0.5), getDroppedItem: () => ({ name: "dirt", count: 3 }) };
  Object.assign(bot, { entities: { 5: item } });
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
  );
  assert.notDeepEqual(bottom, new Vec3(1, 62, 0), "the pit with the item in it is not reused");
  assert.equal(digs.length, 2);
  // An item that is not within reach of the pit's cells does not matter.
  item.position = new Vec3(9.5, 62.1, 9.5);
  const free = await prepareDisposalHole(bot, createMovementPolicy(), async ({ position }) => {
    changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
    return { status: "broken" };
  }, {});
  assert.ok(free);
});

/** Digs the pit and aborts after its first block, leaving the half-dug pit and the item that block dropped. */
async function digUntilReflex(
  bot: Bot,
  changed: Map<string, string>,
  pit: { bottom: Vec3 | null } | undefined,
): Promise<void> {
  const reflex = new AbortController();
  await assert.rejects(
    prepareDisposalHole(
      bot,
      createMovementPolicy(),
      async ({ position }) => {
        changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
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
  Object.assign(bot, {
    entities: { 9: { id: 9, position: new Vec3(1.5, 62.5, 0.5), getDroppedItem: () => ({ name: "dirt", count: 1 }) } },
  });
}

test("a pit cut short by a reflex is dug on by the next attempt, not replaced by a second pit", async () => {
  const { bot, changed } = ground();
  const pit = { bottom: null as Vec3 | null };
  await digUntilReflex(bot, changed, pit);
  assert.deepEqual(pit.bottom, new Vec3(1, 62, 0));
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
    undefined,
    pit,
  );

  assert.deepEqual(bottom, new Vec3(1, 62, 0));
  assert.deepEqual(digs, [62], "only the cell the first attempt had not reached is dug");
});

test("without the pit memory the item the first dig dropped makes the next attempt start another pit", async () => {
  const { bot, changed } = ground();
  await digUntilReflex(bot, changed, undefined);

  const bottom = await prepareDisposalHole(
    bot,
    createMovementPolicy(),
    async ({ position }) => {
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    {},
  );

  assert.notDeepEqual(bottom, new Vec3(1, 62, 0));
});

test("a plug a first attempt began is counted with what the next attempt placed", async () => {
  const { bot, changed } = ground([{ name: "cobblestone", count: 2 }]);
  changed.set(new Vec3(1, 62, 0).toString(), "air");
  changed.set(new Vec3(1, 63, 0).toString(), "cobblestone");
  changed.set(new Vec3(1, 64, 0).toString(), "air");

  assert.equal(pluggedCellCount(bot, new Vec3(1, 62, 0)), 1);
});

test("no new pit opens a guard cell of a sealed pit", async () => {
  const { bot, changed } = ground();
  const dig = async ({ position }: { position: { x: number; y: number; z: number } }) => {
    changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
    return { status: "broken" as const };
  };
  const open = await prepareDisposalHole(bot, createMovementPolicy(), dig, {});
  assert.deepEqual([open.x, open.y, open.z], [1, 62, 0], "the first side fits on open ground");

  const fresh = ground();
  rememberSealedPit(fresh.bot, { x: 2, y: 62, z: 1 });
  const beside = await prepareDisposalHole(fresh.bot, createMovementPolicy(), async ({ position }) => {
    fresh.changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
    return { status: "broken" };
  }, {});
  assert.deepEqual([beside.x, beside.y, beside.z], [-1, 62, 0], "the cell inside the sealed pit's guard volume is passed over");
});

/** A ground bot that emits ticks, with one dropped item lying in the lower plug cell of the pit at (1, 62, 0). */
function bottomWithFallingStack() {
  const { bot, changed } = ground([{ name: "cobblestone", count: 2 }]);
  for (const y of [62, 63]) changed.set(new Vec3(1, y, 0).toString(), "air");
  const events = new EventEmitter();
  const stack = { id: 9, name: "item", position: new Vec3(1.5, 63.6, 0.5), getDroppedItem: () => ({ name: "cobblestone", count: 5 }) };
  Object.assign(bot, { on: events.on.bind(events), off: events.off.bind(events), entities: { 9: stack } });
  return { bot, changed, events, stack };
}

test("a plug cell waits for a falling stack to leave it, at most 2 s", async () => {
  const { bot, changed, events, stack } = bottomWithFallingStack();
  const stackWhenPlaced: number[] = [];
  const place: typeof placeSolidBlockInto = fakePlacement(changed, []);
  const placeAfterStack: typeof placeSolidBlockInto = async (...args) => {
    stackWhenPlaced.push(stack.position.y);
    return place(...args);
  };
  let ticks = 0;
  const falling = setInterval(() => {
    if (++ticks === 3) stack.position = new Vec3(1.5, 62.2, 0.5);
    events.emit("physicsTick");
  }, 5);
  try {
    const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), placeAfterStack, {});
    assert.equal(seal.placed, 2);
  } finally {
    clearInterval(falling);
  }
  assert.ok(ticks >= 3, "the plug waited for the stack's ticks");
  assert.ok(stackWhenPlaced.every((y) => y < 63), `the stack was out of the cell when the block went in: ${stackWhenPlaced}`);
});

test("a stack that never leaves its plug cell does not hold the plug past the bound, ticks or not", async () => {
  const { bot, changed } = bottomWithFallingStack();
  const startedAt = Date.now();

  const seal = await sealDisposalHole(bot, new Vec3(1, 62, 0), fakePlacement(changed, []), {}, { clearWaitMs: 60 });

  assert.equal(seal.placed, 2, "placed anyway once the wait ran out");
  assert.ok(Date.now() - startedAt >= 50, "it waited on the wall clock, with no tick to wake it");
});
