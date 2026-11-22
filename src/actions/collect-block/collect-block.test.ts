import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { collectBlockInputSchema, collectBlockResultSchema, formatCollectBlockResult, outcomes, parseCollectBlockRequest } from "./index.js";
import { beginCollectBlock, breakBudget, collectBlock, collectionChance, inventoryStop, pursuedInventoryStop, reportToolLoss, settle } from "./collect-block.js";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import type { MineResult } from "../../navigation/processes/mining/mine-process.js";
import { sourcesOf } from "../../world/block-drops.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { liveBlockReader } from "../../navigation/mineflayer/world.js";
import { mine } from "../../navigation/processes/mining/mine-process.js";
import { watch } from "../../test-support/pending.js";

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
    reason: outcomes.stalled(180, 3_600, 881, 8),
  });
  assert.equal(result.status, "partial");
  assert.match(
    result.error ?? "",
    /^\[COLLECTION_STALLED\] Nothing was broken or picked up for 180 s and 3600 world ticks \(walked 881 blocks meanwhile, now 8 blocks from the start\)\. Broke 1 matching block; inventory gained 7\/32/u,
  );
});

test("a 10 tps collection gets its world-tick stall window and the next call starts a fresh one", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond: 10 } });
  // The bot-wide break cache keeps its listeners for the bot's lifetime (movement-policy.ts, 2026-11-18).
  createMovements(harness.bot);
  const request = parseCollectBlockRequest({ block_name: "stone" });
  const waitForStop: MineRun = async (_bot, mining) => new Promise((_resolve, reject) => {
    const signal = mining.signal!;
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(signal.reason); };
    signal.addEventListener("abort", aborted, { once: true });
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const added = listenersAddedSince(harness.bot);
    const inventoryAdded = listenersAddedSince(harness.bot.inventory);
    const age = harness.bot.time.age;
    const started = clock.now();
    const result = collectBlock(harness.bot, shoreNavigation(harness), request, {}, undefined, waitForStop);
    const pending = watch(result);
    await clock.advance(180_000, 1_000);
    assert.equal(harness.bot.time.age - age, 1_800);
    assert.equal(pending.over, false, "180 s at 10 tps is only half the work window");
    const stopped = await clock.settle(result, 185_000, 1_000);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.collected.gained, 0);
    assert.match(stopped.error ?? "", /COLLECTION_STALLED.*36[23] s and 3620 world ticks/u);
    assert.ok(clock.now() - started >= 362_000 && clock.now() - started <= 363_000);
    assert.equal(harness.bot.time.age - age, 3_620);
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(added("physicsTick"), 0);
    assert.equal(added("heldItemChanged"), 0);
    assert.equal(inventoryAdded("updateSlot"), 0);
  }
  await clock.advance(60_000, 1_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

test("collection completion, cancellation and death release the watch and caller listeners at both rates", async () => {
  for (const ticksPerSecond of [20, 10]) for (const end of ["done", "cancel", "death"] as const) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const harness = createFakeBot({ clock, server: { ticksPerSecond } });
    createMovements(harness.bot);
    const added = listenersAddedSince(harness.bot);
    const inventoryAdded = listenersAddedSince(harness.bot.inventory);
    const stop = new AbortController();
    const reason = new Error(end === "death" ? "bot died" : "request cancelled");
    let mineSignal: AbortSignal | undefined;
    const perform: MineRun = async (_bot, mining) => {
      mineSignal = mining.signal;
      await clock.sleep(end === "done" ? 50 : 600_000, mining.signal);
      carry(harness, "cobblestone", 1);
      return { status: "satisfied", broken: [], reason: null };
    };
    const result = collectBlock(harness.bot, shoreNavigation(harness), parseCollectBlockRequest({ block_name: "stone" }),
      { signal: stop.signal }, undefined, perform);
    const pending = watch(result);
    let settled = 0;
    void result.then(() => { settled += 1; }, () => { settled += 1; });
    if (end === "done") assert.equal((await clock.settle(result, 1_000)).status, "succeeded");
    else {
      await clock.advance(100);
      assert.equal(pending.over, false);
      stop.abort(reason);
      await assert.rejects(result, (error) => error === reason);
    }
    assert.equal(clock.pendingGlobalTimers(), 0);
    assert.equal(clock.pendingTimers(), 0);
    for (const event of ["physicsTick", "heldItemChanged"]) assert.equal(added(event), 0, `${end}: ${event}`);
    assert.equal(inventoryAdded("updateSlot"), 0);
    const endedSignal = mineSignal?.aborted;
    await clock.advance(600_000, 1_000);
    assert.equal(mineSignal?.aborted, endedSignal, "the abandoned stall deadline never fires");
    assert.equal(settled, 1);
    assert.equal(clock.pendingGlobalTimers(), 0);
  }
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
  // No column loaded: an empty list, as a client with no chunk loaded answers.
  const { bot } = createFakeBot({ version: "1.21.4", loadedColumns: [] });
  const result = settle(bot, request, {}, new Set(["dark_oak_log"]), new Vec3(0, 64, 0), { status: "no_targets", broken: [], reason: null });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[NO_TARGET_IN_RANGE\] No dark_oak_log block left within 64 blocks of where the run started; none is loaded farther either\./u);
});

/** The stop text of a `max_distance` run that found nothing in range, for a world of named cells and the nearest block beyond. */
function stopBeyondRange(blockName: string, cells: NonNullable<Parameters<typeof createFakeBot>[0]>["cells"], range = 64): string {
  const request = parseCollectBlockRequest({ block_name: blockName, count: 1, max_distance: range });
  const { bot } = createFakeBot({ cells, groundY: null });
  const result = settle(bot, request, {}, new Set([blockName]), new Vec3(0, 64, 0), { status: "no_targets", broken: [], reason: null });
  assert.equal(result.status, "failed");
  return result.error ?? "";
}

/** Live 2026-11-07, run 34: the "nearest oak_log" was a log 66 blocks under the sea; the model walked there and drowned its step. */
test("the hint says the nearest lies under water and names the nearest in the open", () => {
  const cells = {
    "80,64,0": "oak_log", "80,65,0": "water", "80,66,0": "water", "80,67,0": "water", "80,68,0": "water", "80,69,0": "water",
    "120,64,0": "oak_log",
  };
  assert.match(
    stopBeyondRange("oak_log", cells),
    /the nearest loaded one is at 80,64,0, 81 blocks from the start \(under water\); the nearest not under water or roofed over is at 120,64,0, 121 blocks\. Broke 0/u,
  );
});

test("an ore's and a Nether stem's hints name the nearest, roofed over, and say none is in the open", () => {
  assert.match(
    stopBeyondRange("coal_ore", { "100,20,0": "coal_ore", "100,21,0": "stone", "100,22,0": "stone" }),
    /the nearest loaded one is at 100,20,0, 101 blocks from the start \(roofed over\); none loaded is in the open\. Broke 0/u,
  );
  assert.match(
    stopBeyondRange("crimson_stem", { "100,60,0": "crimson_stem", "100,61,0": "nether_wart_block" }),
    /the nearest loaded one is at 100,60,0, 101 blocks from the start \(roofed over\); none loaded is in the open\. Broke 0/u,
  );
});

test("a capped scan says of the nearest 256 loaded", () => {
  const cells: Record<string, string> = {};
  for (let x = 100; x < 357; x++) {
    cells[`${x},64,0`] = "oak_log";
    cells[`${x},65,0`] = "water";
  }
  assert.match(stopBeyondRange("oak_log", cells), /\(under water\); none of the nearest 256 loaded is in the open\. Broke 0/u);
});

test("an open nearest block keeps today's words", () => {
  assert.match(stopBeyondRange("oak_log", { "80,64,0": "oak_log", "81,64,0": "oak_leaves" }), /the nearest loaded one is at 80,64,0, 81 blocks from the start\. Broke 0/u);
});

/** Live run 13: a shovel that broke while collecting dirt was only a sentence in the stop reason, and the fetch went on by hand. */
test("a tool that broke during the run is reported as a field of the result, not only in the stop reason", () => {
  const request = parseCollectBlockRequest({ block_name: "dirt", count: 4 });
  const { bot } = createFakeBot({ carried: { dirt: 2 } });
  const stopped = settle(bot, request, {}, new Set(["dirt"]), new Vec3(0, 64, 0), { status: "stopped", broken: [], reason: "[TOOL_TIER_LOST] wooden_shovel was lost at 1,64,2; family: shovel; no shovel remains." });
  const lost = {
    class: "shovel" as const,
    before: { class: "shovel" as const, rank: 2, item: "wooden_shovel", slot: 36, durabilityLeft: 1, maximumDurability: 59 },
    now: { class: "shovel" as const, rank: 0, item: null, slot: null, durabilityLeft: null, maximumDurability: null },
    reason: "[TOOL_TIER_LOST] wooden_shovel was lost at 1,64,2; family: shovel; no shovel remains.",
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

/** Keep the real scan and preparation; navigation is forbidden until the refusal has been decided. */
function shoreNavigation(harness: FakeHarness): NavigationRuntime {
  return new Proxy(untouchedNavigation, {
    get: (navigation, property) => {
      if (property === "world") return { blockAt: liveBlockReader(harness.bot), revision: 0, subscribe: () => () => {} };
      return Reflect.get(navigation, property);
    },
  });
}

test("a sea-only area says TARGETS_UNDER_WATER and walks nowhere", async () => {
  const cells: Record<string, string> = {};
  for (let x = 0; x <= 2; x++) for (let y = 64; y <= 66; y++) for (let z = -1; z <= 1; z++) cells[`${x},${y},${z}`] = "water";
  cells["1,64,0"] = "oak_log";
  cells["1,65,0"] = "oak_log";
  const harness = createFakeBot({ groundY: 63, cells, carried: { cobblestone: 16 }, position: new Vec3(-4.5, 64, 0.5) });
  const start = harness.bot.entity.position.clone();
  const result = await collectBlock(harness.bot, shoreNavigation(harness), parseCollectBlockRequest({ block_name: "oak_log", count: 1, max_distance: 16 }), {});
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[TARGETS_UNDER_WATER\]/u);
  assert.deepEqual(harness.bot.entity.position, start);
});

test("given the blocks it named, the next collect mines it; an exact in-water cell is TARGET_UNMINEABLE in water", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, groundY: 63, cells: { "1,64,0": "oak_log", "2,64,0": "water" }, position: new Vec3(0.5, 64, 0.5) });
  const navigation = shoreNavigation(harness);
  const request = parseCollectBlockRequest({ block_name: "oak_log", count: 1, max_distance: 16 });
  const refused = await clock.settle(collectBlock(harness.bot, navigation, request, {}), 5_000);
  assert.match("error" in refused ? refused.error : "", /TARGETS_UNDER_WATER.*takes 1 block to place, 0 carried/u);
  const exactRequest = parseCollectBlockRequest({ block_name: "oak_log", x: 1, y: 64, z: 0 });
  const exact = await clock.settle(collectBlock(harness.bot, navigation, exactRequest, {}), 5_000);
  assert.match("error" in exact ? exact.error : "", /TARGET_UNMINEABLE.*in water:/u);
  carry(harness, "cobblestone", 1);
  // The server-confirmed cell and slot changes are the boundary; the live drain placement is proved by drowned-trunk-drained.
  const perform: MineRun = (bot, mining) => mine(bot, {
    ...mining,
    placeInto: async (_bot, cell) => {
      harness.world.setCell(new Vec3(cell.x, cell.y, cell.z), "cobblestone");
      carry(harness, "cobblestone", 0);
      return { kind: "placed", block: bot.blockAt(new Vec3(cell.x, cell.y, cell.z))! };
    },
    breakInPlace: async ({ position }) => {
      harness.world.setCell(new Vec3(position.x, position.y, position.z), "air");
      carry(harness, "oak_log", 1);
      return { status: "broken" };
    },
  });
  const collected = await clock.settle(collectBlock(harness.bot, navigation, request, {}, undefined, perform), 5_000);
  assert.equal(collected.status, "succeeded");
  assert.equal(collected.collected.gained, 1);
  assert.equal(harness.bot.blockAt(new Vec3(2, 64, 0))?.name, "cobblestone");
});

/** `version` only sets the string the tag lookups read: the shared fake builds no registry older than 1.19.4. */
function refusedBot(version = "1.21.4") {
  return Object.assign(createFakeBot().bot, { version });
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
  const result = await refusal("logs", "1.18.2");
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\]/u);
});

test("a refusal with coordinates names the unknown block, not a cell mismatch", async () => {
  const result = await refusal("coal", "1.21.4", { count: 1, x: 3, y: 64, z: 3 });
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /^\[COLLECT_UNKNOWN_BLOCK\]/u);
});

// ── Drops that never appeared (P4-01a D8) ──────────────────────────────────────────────────

type MineRun = NonNullable<Parameters<typeof collectBlock>[5]>;

/** A mine process that reports `lost` expected drops never seen, then settles as `status`: no physical work, only the counting. */
const mineLosing = (lost: number, status: MineResult["status"] = "satisfied"): MineRun => async (_bot, mineRequest) => {
  for (let i = 0; i < lost; i++) mineRequest.onLostDrop?.();
  return { status, broken: [], reason: status === "stopped" ? "[TEST_STOP] the fake process stopped." : null };
};

async function collectWith(mineRun: MineRun, count = 1) {
  const { bot } = createFakeBot({ version: "1.21.4" });
  const request = parseCollectBlockRequest({ block_name: "stone", count });
  return collectBlock(bot, untouchedNavigation, request, {}, undefined, mineRun);
}

test("a break whose drop never appeared is reported as lostDrops and as a line of the text", async () => {
  const result = await collectWith(mineLosing(1));
  assert.equal(result.collected.lostDrops, 1);
  assert.match(formatCollectBlockResult(result), /^- Expected drops never seen: 1$/mu);
});

test("a collection that lost no drop reports 0 and prints no line", async () => {
  const result = await collectWith(mineLosing(0));
  assert.equal(result.collected.lostDrops, 0);
  assert.doesNotMatch(formatCollectBlockResult(result), /drops never seen/iu);
});

test("an old result with no lostDrops field still parses and prints no line", () => {
  const old = { requested: 1, gained: 0, gainedByItem: {}, blocksBroken: 0, brokenAt: [] };
  assert.equal(collectBlockResultSchema.safeParse({ status: "failed", error: "x", collected: old }).success, true);
  assert.doesNotMatch(formatCollectBlockResult({ status: "failed", error: "x", collected: old }), /drops never seen/iu);
});

/** The capacity watch stops the run (the drop it walks to cannot enter): a stopped result, built from the catch path. */
function capacityStoppedHarness() {
  const harness: FakeHarness = createFakeBot({
    carried: { birch_log: 3, stone: stoneStacks(35) },
    entities: { 7: { name: "item", position: new Vec3(0, 64, 0), getDroppedItem: () => itemOf(harness.bot.registry, "oak_log") } },
  });
  const request = parseCollectBlockRequest({ block_name: "logs", count: 4 });
  const stopWhileLosing = (lost: number): MineRun => async (bot, mineRequest) => {
    for (let i = 0; i < lost; i++) mineRequest.onLostDrop?.();
    mineRequest.onTargets?.([{ kind: "drop", entityId: 7, position: { x: 0, y: 64, z: 0 } }]);
    bot.emit("physicsTick");
    mineRequest.signal?.throwIfAborted();
    throw new Error("the capacity watch did not stop the run");
  };
  return { harness, request, stopWhileLosing };
}

test("a lost drop, a stop that makes mine() throw, the resume and a second lost drop report both", async () => {
  const { harness, request, stopWhileLosing } = capacityStoppedHarness();
  const lifetime = new AbortController();
  try {
    let current = stopWhileLosing(1);
    const run = beginCollectBlock(harness.bot, untouchedNavigation, request, createDiscardedItems(), () => {}, lifetime.signal, (...args) => current(...args));
    const first = await run({});
    assert.match("error" in first ? first.error : "", /INVENTORY_FULL/u, "the first run ended by the capacity stop, not by a normal result");
    assert.equal(first.collected.lostDrops, 1);
    current = mineLosing(1, "stopped");
    assert.equal((await run({})).collected.lostDrops, 2);
  } finally {
    lifetime.abort("test done");
  }
});
