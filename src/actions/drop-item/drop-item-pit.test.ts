import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { sealedPitGuarding } from "../../world/sealed-pits.js";
import { parseDropItemRequest } from "./contract.js";
import { dropItem, formatDropItemResult } from "./drop-item.js";
import { abortAfterToss, dropAttempts, dropTest, pitWorld } from "./drop-item-fixtures.test.js";

dropTest("a pit half dug when a reflex took the body is dug on, filled with the drop and plugged by the next attempt", async ({ clock, run }) => {
  const world = pitWorld(clock);
  const owner = new AbortController();
  const breakInPlace = world.dependencies.breakInPlace;
  let breaks = 0;
  const dependencies = {
    ...world.dependencies,
    breakInPlace: async (options: Parameters<typeof breakInPlace>[0]) => {
      const broken = await breakInPlace(options);
      if (++breaks === 1) owner.abort(new Error("fall reflex"));
      return broken;
    },
  };
  const attempt = dropAttempts(world.bot, { items: [{ item_name: "dirt" }], in_a_hole: true }, dependencies);

  await assert.rejects(run(attempt(owner.signal)), /fall reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([result.drop.hole?.x, result.drop.hole?.y, result.drop.hole?.z], [1, 62, 0]);
  assert.deepEqual(world.dug, ["1,63,0", "1,62,0"], "each cell of the one pit is dug once");
  assert.equal(result.drop.holeClosure?.placed, 2);
  assert.equal(world.blockNameAt(new Vec3(1, 63, 0)), "cobblestone");
  assert.equal(world.blockNameAt(new Vec3(1, 64, 0)), "cobblestone");
});

const BURY_EVERYTHING = { items: [{ item_name: "oak_log" }, { item_name: "cobblestone" }], in_a_hole: true };

dropTest("an \"all\" burial of the only plug-capable stack keeps 2, plugs with them and says so", async ({ clock, run }) => {
  // Run 16, Anselm: 170 cobblestone buried, nothing left to plug, the stack back 16 s later.
  const world = pitWorld(clock, [{ name: "cobblestone", count: 70 }, { name: "oak_log", count: 16 }]);

  const result = await run(dropItem(world.bot, parseDropItemRequest(BURY_EVERYTHING), {}, world.dependencies, createDiscardedItems()));

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.keptForPlug]), [["oak_log", 16, undefined], ["cobblestone", 68, 2]]);
  assert.equal(result.drop.holeClosure?.placed, 2);
  assert.deepEqual(world.plugged, ["cobblestone", "cobblestone"]);
  assert.match(formatDropItemResult(result), /Kept 2 cobblestone to close the hole\./);
});

dropTest("a resumed burial keeps the plug it planned and does not toss the kept blocks", async ({ clock, run }) => {
  const world = pitWorld(clock, [{ name: "cobblestone", count: 64 }, { name: "cobblestone", count: 6 }]);
  const owner = new AbortController();
  abortAfterToss(world.bot, owner, 1);
  const attempt = dropAttempts(world.bot, { items: [{ item_name: "cobblestone" }], in_a_hole: true }, world.dependencies);

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.keptForPlug], [68, 2]);
  assert.deepEqual(world.plugged, ["cobblestone", "cobblestone"]);
  assert.equal(world.items().length, 0, "the two kept blocks went into the plug");
});

dropTest("the same \"all\" drop again buries what the first one left", async ({ clock, run }) => {
  // A plug that failed leaves the kept blocks carried: the next "all" drop is another burial and keeps again.
  const failed = pitWorld(clock, [{ name: "cobblestone", count: 70 }], { plugFails: true });
  const first = await run(dropItem(failed.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, failed.dependencies, createDiscardedItems()));
  assert.equal(first.drop.dropped[0]?.dropped, 68);
  assert.match(first.drop.holeClosure?.error ?? "", /DROP_HOLE_OPEN/);
  assert.equal(failed.items()[0]?.count, 2, "the kept blocks are still carried");

  for (const [carried, keeps, buries] of [[3, 2, 1], [2, 1, 1]] as const) {
    const world = pitWorld(clock, [{ name: "cobblestone", count: carried }]);
    const again = await run(dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, world.dependencies, createDiscardedItems()));
    assert.deepEqual([again.drop.dropped[0]?.dropped, again.drop.dropped[0]?.keptForPlug, again.drop.holeClosure?.placed], [buries, keeps, keeps], `${carried} carried`);
  }
});

dropTest("stacks the server spawns after the toss resolved are claimed once seen in the pit", async ({ clock, run }) => {
  // Run 16, Theo 17:18:58: collect_block took 18 logs from the pit buried 28 s before; the claim ran before the spawn.
  const world = pitWorld(clock, [{ name: "cobblestone", count: 70 }, { name: "oak_log", count: 16 }], { spawnAfterMs: 30 });
  const discarded = createDiscardedItems();

  const result = await run(dropItem(world.bot, parseDropItemRequest(BURY_EVERYTHING), {}, { ...world.dependencies, settleMs: 300 }, discarded));

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([...discarded.ignored()].sort(), [77, 78], "both stacks that landed in the pit are claimed");
});

dropTest("a sealed burial is remembered, an open one is not", async ({ clock, run }) => {
  const sealed = pitWorld(clock, [{ name: "cobblestone", count: 70 }]);
  await run(dropItem(sealed.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, sealed.dependencies, createDiscardedItems()));
  assert.deepEqual(sealedPitGuarding(sealed.bot, 1, 62, 0), { x: 1, y: 62, z: 0 });

  const open = pitWorld(clock, [{ name: "cobblestone", count: 70 }], { plugFails: true });
  await run(dropItem(open.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, open.dependencies, createDiscardedItems()));
  assert.equal(sealedPitGuarding(open.bot, 1, 62, 0), null);
});

dropTest("a body that stops 0.07 short of the node centre the goal accepted has stepped back from the hole", async ({ clock, run }) => {
  // The goal measures from the node's cell centre; the body stops a little short of that centre (live: "Still 2.93 blocks").
  const world = pitWorld(clock, [{ name: "cobblestone", count: 70 }]);
  const dependencies = {
    ...world.dependencies,
    navigate: async () => {
      world.bot.entity.position.set(4.43, 64, 0.5);
      return { status: "completed", elapsedMs: 0 } as never;
    },
  };

  const result = await run(dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, dependencies, createDiscardedItems()));

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.equal(result.drop.holeClosure?.error, undefined);
  assert.equal(result.drop.holeClosure?.distance, 3, "the cell centre of the feet is 3 blocks from the hole's column");
});

dropTest("a step back that fails reports the distance of the cell the body stands in", async ({ clock, run }) => {
  const world = pitWorld(clock, [{ name: "cobblestone", count: 70 }]);
  const dependencies = {
    ...world.dependencies,
    navigate: async () => {
      world.bot.entity.position.set(4.43, 64, 0.5);
      throw new Error("route lost");
    },
  };

  const result = await run(dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, dependencies, createDiscardedItems()));

  assert.match(result.drop.holeClosure?.error ?? "", /\[DROP_HOLE_BESIDE\] Could not step back from the hole: route lost/);
  assert.equal(result.drop.holeClosure?.distance, 3);
});

dropTest("a body on a cell whose centre is short of the clearance has not stepped back from the hole", async ({ clock, run }) => {
  const world = pitWorld(clock, [{ name: "cobblestone", count: 70 }]);
  const dependencies = {
    ...world.dependencies,
    navigate: async () => {
      world.bot.entity.position.set(3.9, 64, 0.5);
      return { status: "completed", elapsedMs: 0 } as never;
    },
  };

  const result = await run(dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, dependencies, createDiscardedItems()));

  assert.match(result.drop.holeClosure?.error ?? "", /\[DROP_HOLE_BESIDE\] Still 2 blocks/);
});
