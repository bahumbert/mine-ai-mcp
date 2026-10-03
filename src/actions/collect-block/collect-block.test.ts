import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { collectBlockInputSchema, formatCollectBlockResult, outcomes, parseCollectBlockRequest } from "./index.js";
import type { Bot } from "mineflayer";
import { breakBudget, collectionChance, inventoryStop, pursuedInventoryStop, settle } from "./collect-block.js";
import { botFixture } from "../../test-support/bot.js";

test("capacity admission allows a clearing break with free space or a compatible partial stack", () => {
  let empty = 4;
  const stacks = [{ name: "cobbled_deepslate", count: 63, stackSize: 64 }];
  const bot = {
    inventory: { inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => empty, items: () => stacks },
  } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "deepslate", count: 1 });
  const collectable = new Set(["cobbled_deepslate"]);
  assert.equal(inventoryStop(bot, request, collectable), null);
  empty = 0;
  assert.equal(inventoryStop(bot, request, collectable), null);
  stacks[0]!.count = 64;
  assert.match(inventoryStop(bot, request, collectable) ?? "", /INVENTORY_FULL.*no room in a stack of cobbled_deepslate/);
  assert.equal(inventoryStop(bot, { ...request, allowFullInventory: true }, collectable), null);
});

/**
 * The stall behind "mine one log, stand on it for five minutes, mine another":
 * a spare birch slot satisfied the set-wide check while the oak log on the
 * ground had nowhere to go, so the run waited for the server to despawn it.
 */
test("a running collection asks whether the drop being walked to can enter, not whether any matching stack can", () => {
  const stacks = [{ name: "birch_log", count: 3, stackSize: 64 }];
  const bot = {
    inventory: { inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => 0, items: () => stacks },
    entities: {
      7: { id: 7, name: "item", getDroppedItem: () => ({ name: "oak_log" }) },
      8: { id: 8, name: "item", getDroppedItem: () => ({ name: "birch_log" }) },
    },
  } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "logs", count: 4 });
  const collectable = new Set(["oak_log", "birch_log"]);
  const drop = (entityId: number) => ({ kind: "drop" as const, entityId, position: { x: 0, y: 64, z: 0 } });
  // With nothing on the ground yet, only the set can be asked, and birch answers for it.
  assert.equal(pursuedInventoryStop(bot, request, collectable, []), null);
  assert.equal(pursuedInventoryStop(bot, request, collectable, [drop(8)]), null);
  assert.match(
    pursuedInventoryStop(bot, request, collectable, [drop(7)]) ?? "",
    /INVENTORY_FULL.*no room in a stack of oak_log/,
  );
  assert.equal(pursuedInventoryStop(bot, { ...request, allowFullInventory: true }, collectable, [drop(7)]), null);
});

test("sixteen obsidian cannot conceal a casting bucket absent from the final inventory", () => {
  const stacks = [{ name: "obsidian", count: 16 }];
  const bot = { inventory: { items: () => stacks } } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "obsidian", count: 16 });
  const result = settle(bot, request, { water_bucket: 1 }, new Set(["obsidian"]), new Vec3(0, 0, 0), {
    status: "satisfied",
    broken: [],
    reason: null,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.collected.gained, 16);
  assert.match(result.error ?? "", /CASTING_BUCKET_MISSING.*1 to 0/);
  stacks.push({ name: "bucket", count: 1 });
  assert.equal(
    settle(bot, request, { water_bucket: 1 }, new Set(["obsidian"]), new Vec3(0, 0, 0), {
      status: "satisfied",
      broken: [],
      reason: null,
    }).status,
    "succeeded",
  );
});

/** Observed live on 2026-10-02: 27 minutes, 881 blocks walked, 7 of 32 stone, settled only by a server kick. */
test("a stalled collection settles with what it got and how far it walked meanwhile", () => {
  const bot = { inventory: { items: () => [{ name: "cobblestone", count: 30 }] } } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "stone", count: 32 });
  const result = settle(bot, request, { cobblestone: 23 }, new Set(["cobblestone", "stone"]), new Vec3(0, 0, 0), {
    status: "stopped",
    broken: [new Vec3(1, 60, 1)],
    reason: outcomes.stalled(180, 881, 8),
  });
  assert.equal(result.status, "partial");
  assert.match(
    result.error ?? "",
    /^\[COLLECTION_STALLED\] Nothing was broken or picked up for 180 s \(walked 881 blocks meanwhile, now 8 blocks from the start\)\. Broke 1 matching block; inventory gained 7\/32/u,
  );
});

test("the break budget follows how often a break yields the item: grass gives seeds one time in eight", () => {
  const bot = Object.assign(botFixture(), { version: "1.21.4" });
  assert.equal(collectionChance(bot, ["short_grass"], new Set(["short_grass", "wheat_seeds"])), 0.125);
  // Twice the breaks expected at that chance, so bad luck rarely cuts the run short.
  assert.equal(breakBudget(16, collectionChance(bot, ["short_grass"], new Set(["short_grass", "wheat_seeds"]))), 260);
  // A sure drop keeps today's budget exactly.
  assert.equal(collectionChance(bot, ["stone"], new Set(["stone", "cobblestone"])), 1);
  assert.equal(breakBudget(16, 1), 20);
  // Of several matching blocks the likeliest counts, and a block without shipped drops counts as sure.
  assert.equal(collectionChance(bot, ["short_grass", "not_a_block"], new Set(["wheat_seeds"])), 1);
});

test("collect_block presents collection evidence as Markdown", () => {
  const markdown = formatCollectBlockResult({
    status: "partial",
    error: "One drop was not recovered.",
    collected: {
      requested: 3,
      gained: 2,
      gainedByItem: { oak_log: 2 },
      blocksBroken: 3,
      brokenAt: [
        { x: 102, y: 4, z: 92, distanceFromStart: 1.4 },
        { x: 102, y: 5, z: 92, distanceFromStart: 2.1 },
        { x: 86, y: -55, z: 94, distanceFromStart: 61.3 },
      ],
    },
  });

  assert.match(markdown, /Inventory gained: 2/);
  assert.match(markdown, /Matching blocks broken: 3\n  - 102,4,92 \(1\.4 blocks from the start\)\n  - 102,5,92/);
  assert.match(markdown, /86,-55,94 \(61\.3 blocks from the start\)/);
  assert.match(markdown, /`oak_log`: 2/);
  assert.match(markdown, /Observed stop.*One drop was not recovered/s);
});

test("collect_block parses MCP arguments into its normalized action model", () => {
  assert.deepEqual(
    parseCollectBlockRequest({
      block_name: " MINECRAFT:OAK_LOG ",
      count: 4,
      scaffold: false,
      allow_full_inventory: true,
    }),
    {
      selector: "oak_log",
      requested: 4,
      exactTarget: null,
      scaffolding: false,
      allowFullInventory: true,
      onToolLoss: "stop",
    },
  );
  assert.deepEqual(parseCollectBlockRequest({ block_name: "oak_log", x: 8, y: 64, z: -3 }), {
    selector: "oak_log",
    requested: 1,
    exactTarget: new Vec3(8, 64, -3),
    scaffolding: true,
    allowFullInventory: false,
    onToolLoss: "stop",
  });
  assert.throws(() => parseCollectBlockRequest({ block_name: "minecraft:" }), /must identify a block/);
  assert.throws(
    () => parseCollectBlockRequest({ block_name: "minecraft:water" }),
    /minecraft:water is not a mineable block/,
  );
});

test("exact collection accepts one or omitted count and rejects larger counts at the input boundary", () => {
  const target = { block_name: "coal_ore", x: 6, y: -59, z: 0 };
  assert.equal(collectBlockInputSchema.parse(target).count, 1);
  assert.equal(collectBlockInputSchema.parse({ ...target, count: 1 }).count, 1);
  assert.equal(collectBlockInputSchema.parse({ block_name: "coal_ore", count: 3 }).count, 3);

  for (const count of [2, 3, 32]) {
    const result = collectBlockInputSchema.safeParse({ ...target, count });
    assert.ok(!result.success, "Contradictory exact-target count was accepted");
    assert.deepEqual(result.error.issues.map(({ path, message }) => ({ path, message })), [{
      path: ["count"],
      message: "Exact coordinates select one block. Omit count or set it to 1. To collect multiple blocks, omit x, y, and z.",
    }]);
  }
});
