import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { collectBlockInputSchema, formatCollectBlockResult, outcomes, parseCollectBlockRequest } from "./index.js";
import { breakBudget, collectBlock, collectionChance, inventoryStop, pursuedInventoryStop, reportToolLoss, settle } from "./collect-block.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { sourcesOf } from "../../world/block-drops.js";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";

/** Rewrite how many of `name` the harness's window carries, as the server's slot updates would. */
function carry(harness: FakeHarness, name: string, total: number): void {
  new CarriedCounts(harness.inventory, harness.bot.registry).set(harness.bot.registry.itemsByName[name]!.id, total);
}

/** Full stacks of stone filling `stacks` inventory slots, the filler that leaves the window's other slots empty. */
const stoneStacks = (stacks: number) => stacks * 64;

test("capacity admission allows a clearing break with free space or a compatible partial stack", () => {
  // 63 cobbled deepslate in one slot and 31 full stacks of stone: four of the 36 slots empty.
  const harness = createFakeBot({ carried: { cobbled_deepslate: 63, stone: stoneStacks(31) } });
  const { bot } = harness;
  const request = parseCollectBlockRequest({ block_name: "deepslate", count: 1 });
  const collectable = new Set(["cobbled_deepslate"]);
  assert.equal(inventoryStop(bot, request, collectable), null);
  carry(harness, "stone", stoneStacks(35));
  assert.equal(inventoryStop(bot, request, collectable), null);
  carry(harness, "cobbled_deepslate", 64);
  assert.match(inventoryStop(bot, request, collectable) ?? "", /INVENTORY_FULL.*no room in a stack of cobbled_deepslate/);
  assert.equal(inventoryStop(bot, { ...request, allowFullInventory: true }, collectable), null);
});

/**
 * The stall behind "mine one log, stand on it for five minutes, mine another":
 * a spare birch slot satisfied the set-wide check while the oak log on the
 * ground had nowhere to go, so the run waited for the server to despawn it.
 */
test("a running collection asks whether the drop being walked to can enter, not whether any matching stack can", () => {
  // Three birch logs and 35 full stacks of stone: no empty slot, room for birch only.
  const harness: FakeHarness = createFakeBot({
    carried: { birch_log: 3, stone: stoneStacks(35) },
    entities: {
      7: { name: "item", position: new Vec3(0, 64, 0), getDroppedItem: () => itemOf(harness.bot.registry, "oak_log") },
      8: { name: "item", position: new Vec3(0, 64, 0), getDroppedItem: () => itemOf(harness.bot.registry, "birch_log") },
    },
  });
  const { bot } = harness;
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
  const harness = createFakeBot({ carried: { obsidian: 16 } });
  const { bot } = harness;
  const request = parseCollectBlockRequest({ block_name: "obsidian", count: 16 });
  const result = settle(bot, request, { water_bucket: 1 }, new Set(["obsidian"]), new Vec3(0, 0, 0), {
    status: "satisfied",
    broken: [],
    reason: null,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.collected.gained, 16);
  assert.match(result.error ?? "", /CASTING_BUCKET_MISSING.*1 to 0/);
  carry(harness, "bucket", 1);
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
  const { bot } = createFakeBot({ carried: { cobblestone: 30 } });
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
  const { bot } = createFakeBot({ version: "1.21.4" });
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
      maxDistance: null,
      maxBreaks: null,
    },
  );
  assert.deepEqual(parseCollectBlockRequest({ block_name: "oak_log", x: 8, y: 64, z: -3 }), {
    selector: "oak_log",
    requested: 1,
    exactTarget: new Vec3(8, 64, -3),
    scaffolding: true,
    allowFullInventory: false,
    onToolLoss: "stop",
    maxDistance: null,
    maxBreaks: null,
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

/**
 * Live 2026-10-03: with no bound, a fetch for a scarce wood walked 491, 907 and 806 blocks (an ocean twice), the loaded
 * nearest moving on as it walked. Under max_distance the run ends with the nearest farther one named instead.
 */
test("max_distance bounds the run and its stop names the nearest block beyond the range", () => {
  const request = parseCollectBlockRequest({ block_name: "dark_oak_log", count: 3, max_distance: 64 });
  assert.equal(request.maxDistance, 64);
  assert.throws(() => parseCollectBlockRequest({ block_name: "oak_log", max_distance: 0 }));
  assert.throws(() => parseCollectBlockRequest({ block_name: "oak_log", max_distance: 5000 }));
  assert.equal(
    outcomes.noTargetInRange("dark_oak_log", 64, { position: { x: -150, y: 70, z: -260 }, distance: 712 }),
    "[NO_TARGET_IN_RANGE] No dark_oak_log block left within 64 blocks of where the run started; the nearest loaded one is at -150,70,-260, 712 blocks from the start.",
  );
  // Nothing loaded at all, in range or beyond.
  const { bot } = createFakeBot({ version: "1.21.4" });
  // The harness's world has no loaded columns to list: an empty list, as a client with no chunk loaded answers.
  Object.assign(bot.world, { getColumns: () => [] });
  const result = settle(bot, request, {}, new Set(["dark_oak_log"]), new Vec3(0, 64, 0), { status: "no_targets", broken: [], reason: null });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[NO_TARGET_IN_RANGE\] No dark_oak_log block left within 64 blocks of where the run started; none is loaded farther either\./u);
});

/** Live run 13: a shovel that broke while collecting dirt was only a sentence in the stop reason, and the fetch went on by hand. */
test("a tool that broke during the run is reported as a field of the result, not only in the stop reason", () => {
  const request = parseCollectBlockRequest({ block_name: "dirt", count: 4 });
  const { bot } = createFakeBot({ carried: { dirt: 2 } });
  const stopped = settle(bot, request, {}, new Set(["dirt"]), new Vec3(0, 64, 0), { status: "stopped", broken: [], reason: "[TOOL_TIER_LOST] wooden_shovel was lost at 1,64,2; no shovel remains." });
  const lost = {
    class: "shovel" as const,
    before: { class: "shovel" as const, tier: "wooden" as const, item: "wooden_shovel", slot: 36, durabilityLeft: 1, maximumDurability: 59 },
    now: { class: "shovel" as const, tier: "none" as const, item: null, slot: null, durabilityLeft: null, maximumDurability: null },
    reason: "[TOOL_TIER_LOST] wooden_shovel was lost at 1,64,2; no shovel remains.",
  };
  assert.deepEqual(reportToolLoss(stopped, lost).collected.toolLost, { item: "wooden_shovel", class: "shovel" });
  // No loss, no field.
  assert.equal("toolLost" in reportToolLoss(stopped, null).collected, false);
});

/** Run 14 review SF7: `get_items apple 5` asked for 5 drops at 0.5%, a budget of 2004 breaks, while the brain bounds a rare fetch at 64 blocks. */
test("max_breaks caps the break budget whatever the drop chance asks for", () => {
  assert.equal(parseCollectBlockRequest({ block_name: "oak_leaves", count: 5, max_breaks: 12 }).maxBreaks, 12);
  assert.equal(parseCollectBlockRequest({ block_name: "oak_leaves" }).maxBreaks, null);
  assert.throws(() => parseCollectBlockRequest({ block_name: "oak_leaves", max_breaks: 0 }));
  assert.equal(breakBudget(5, 0.005), 2004, "no cap: twice the expected breaks");
  assert.equal(breakBudget(5, 0.005, 12), 12);
  assert.equal(breakBudget(5, 1, 12), 9, "a sure drop needs fewer breaks than the cap: the cap does not raise it");
});

// ── An unknown name is refused before any movement (ACT-02) ────────────────────────────────

/** A navigation runtime that fails the test on any use: an unknown name must never reach it. */
const untouchedNavigation = new Proxy({}, {
  get: (_target, property) => { throw new Error(`the refusal reached navigation.${String(property)}`); },
}) as unknown as NavigationRuntime;

function refusedBot(version = "1.21.4") {
  return createFakeBot({ version }).bot;
}

async function refusal(selector: string, version = "1.21.4", extra: Record<string, unknown> = {}) {
  const request = parseCollectBlockRequest({ block_name: selector, count: 3, ...extra });
  return collectBlock(refusedBot(version), untouchedNavigation, request, {});
}

test("a name that is an item, not a block, fails at once naming the blocks that drop it", async () => {
  const result = await refusal("coal");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\] Minecraft has no block or block tag named coal\./u);
  const droppers = sourcesOf("coal", "1.21.4").slice(0, 5).map((source) => source.block);
  assert.ok(droppers.length > 0);
  assert.ok((result.error ?? "").includes(`Blocks that drop it: ${droppers.join(", ")}. Name one of them as block_name.`));
  assert.equal(result.collected.blocksBroken, 0);
  assert.equal(result.collected.gained, 0);
});

test("an item no block drops but a recipe makes fails at once saying craft or smelt", async () => {
  for (const item of ["iron_ingot", "iron_pickaxe", "bread"]) {
    assert.equal(sourcesOf(item, "1.21.4").length, 0, `${item} must have no block source for this test`);
    const result = await refusal(item);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /No block drops it: craft it or smelt it \(view_crafting_requirements, view_smelting_recipes\)\./u);
  }
});

test("a name that is nothing fails with the closest registry names", async () => {
  const result = await refusal("deepslat_coal_ore");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\] Minecraft has no block or block tag named deepslat_coal_ore\./u);
  assert.match(result.error ?? "", /Closest names: [^.]*deepslate_coal_ore/u);
});

test("the singular log is unknown and its refusal suggests the logs", async () => {
  const result = await refusal("log");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\] Minecraft has no block or block tag named log\./u);
  const closest = /Closest names: ([^.]*)\./u.exec(result.error ?? "")?.[1] ?? "";
  assert.match(closest, /\blogs\b/u);
  assert.match(closest, /oak_log/u);
});

test("a version with no shipped tags matches exact names only: logs is the unknown-name refusal, not an exploration", async () => {
  const result = await refusal("logs", "1.19.4");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\]/u);
});

test("a refusal with coordinates names the unknown block, not a cell mismatch", async () => {
  const result = await refusal("coal", "1.21.4", { count: 1, x: 3, y: 64, z: 3 });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\]/u);
});
