import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { formatDropItemResult, dropItem } from "./drop-item.js";
import { PICKED_UP_BY_MS, abortAfterToss, deps, dropAttempts, dropBot, dropTest, wearingChestplateHoldingPickaxe } from "./drop-item-fixtures.test.js";

dropTest("drops every stack of an item and reports the inventory delta", async ({ clock, run }) => {
  const { bot, items } = dropBot(
    {
      carried: [
        { name: "cobblestone", count: 64 },
        { name: "cobblestone", count: 12 },
        { name: "diamond", count: 3 },
      ],
    },
    clock,
  );

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps(), createDiscardedItems()),
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.carriedAfter]),
    [["cobblestone", 76, 0]],
  );
  assert.equal(result.drop.freeSlotsBefore, 33);
  assert.equal(result.drop.freeSlotsAfter, 35);
  assert.deepEqual(
    items().map((stack) => stack.name),
    ["diamond"],
  );
});

dropTest("drops only the requested count, leaving the rest carried", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 64 }] }, clock);

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone", count: 10 }] }), {}, deps(), createDiscardedItems()),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.dropped[0]?.dropped, 10);
  assert.equal(result.drop.dropped[0]?.carriedAfter, 54);
});

dropTest("a count above what is carried drops all of it and succeeds", async ({ clock, run }) => {
  // Live 2026-10-09: "drop 16 oak_planks" with 2 carried dropped both, then failed DROP_NOT_OBSERVED; the step was
  // retried and each retry failed DROP_NOT_CARRIED for the planks already gone.
  const { bot } = dropBot({ carried: [{ name: "oak_planks", count: 2 }, { name: "cobblestone", count: 64 }] }, clock);

  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "oak_planks", count: 16 }, { item_name: "cobblestone", count: 10 }] }),
      {},
      deps(),
      createDiscardedItems(),
    ),
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.carriedAfter, entry.error]), [["oak_planks", 2, 0, undefined], ["cobblestone", 10, 54, undefined]]);
});

dropTest("never drops worn armour, and refuses the held item without allow_equipped", async ({ clock, run }) => {
  const { bot, items } = wearingChestplateHoldingPickaxe(clock);

  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }] }),
      {},
      deps(),
      createDiscardedItems(),
    ),
  );

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\].*torso/);
  assert.match(result.drop.dropped[1]?.error ?? "", /\[DROP_HELD\].*allow_equipped/);
  assert.equal(items().length, 2, "nothing was tossed");
});

dropTest("allow_equipped releases the held item but never the worn one", async ({ clock, run }) => {
  const { bot } = wearingChestplateHoldingPickaxe(clock);

  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({
        items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }],
        allow_equipped: true,
      }),
      {},
      deps(),
      createDiscardedItems(),
    ),
  );

  assert.equal(result.status, "partial");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 1);
});

dropTest("reports an item that is not carried without touching the others, and is no failure once others were carried", async ({ clock, run }) => {
  // Live 2026-10-09: drops listing tools she did not carry "failed 9 of 9" after freeing slots, and were sent again.
  const { bot } = dropBot({ carried: [{ name: "gravel", count: 4 }] }, clock);

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "clay_ball" }, { item_name: "gravel" }] }), {}, deps(), createDiscardedItems()),
  );

  assert.equal(result.status, "succeeded");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_NOT_CARRIED\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 4);

  // Nothing listed is carried (a wrong id): still a failure.
  const none = await run(dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_plank" }] }), {}, deps(), createDiscardedItems()));
  assert.equal(none.status, "failed");
  assert.match(none.error ?? "", /\[DROP_INCOMPLETE\] 1 of 1 item/);
});

dropTest("the incomplete error says why each item failed (live 2026-10-10 run 8: 69 steps read only '4 of 4 items could not be dropped')", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [] }, clock);
  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "sand", count: 3 }, { item_name: "granite" }] }), {}, deps(), createDiscardedItems()),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_INCOMPLETE\] 2 of 2 items could not be dropped: sand: not carried; granite: not carried/);

  const swallowing = dropBot({ carried: [{ name: "gravel", count: 4 }], swallows: "gravel" }, clock);
  const swallowed = await run(dropItem(swallowing.bot, parseDropItemRequest({ items: [{ item_name: "gravel" }] }), {}, deps(), createDiscardedItems()));
  assert.equal(swallowed.status, "failed");
  assert.match("error" in swallowed ? swallowed.error ?? "" : "", /could not be dropped: gravel: \[DROP_NOT_OBSERVED\]/);
});

dropTest("a toss the server swallows or rejects is reported, not assumed", async ({ clock, run }) => {
  const gravel = parseDropItemRequest({ items: [{ item_name: "gravel" }] });
  const carried = [{ name: "gravel", count: 4 }];

  const swallowed = await run(dropItem(dropBot({ carried, swallows: "gravel" }, clock).bot, gravel, {}, deps(), createDiscardedItems()));
  assert.equal(swallowed.status, "failed");
  assert.match(swallowed.drop.dropped[0]?.error ?? "", /\[DROP_NOT_OBSERVED\].*gravel x4/);

  const rejected = await run(dropItem(dropBot({ carried, rejects: "gravel" }, clock).bot, gravel, {}, deps(), createDiscardedItems()));
  assert.equal(rejected.status, "failed");
  assert.match(rejected.drop.dropped[0]?.error ?? "", /\[DROP_REJECTED\].*server refused/);
});

dropTest("walks to the named player, faces them, and records the handover", async ({ clock, run }) => {
  const { bot, lookedAt } = dropBot(
    {
      carried: [{ name: "bread", count: 8 }],
      players: { Dev: { id: 42, position: { x: 1, y: 64, z: 1 } } },
      position: { x: 0, y: 64, z: 0 },
    },
    clock,
  );
  let goalRange: number | null = null;

  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Dev" }),
      {},
      deps({
        navigate: (async (options: { goal: unknown }) => {
          goalRange = (options.goal as { range?: number }).range ?? null;
          return { status: "completed", elapsedMs: 5 };
        }) as never,
      }),
      createDiscardedItems(),
    ),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.name, "Dev");
  assert.equal(result.drop.dropped[0]?.dropped, 8);
  assert.deepEqual(lookedAt, [{ x: 1, y: 64, z: 1 }], "faced the player before tossing");
  assert.equal(goalRange, null, "the entity goal carries its own range");
});

dropTest("refuses to hand items to a player who is not loaded, dropping nothing", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "bread", count: 8 }] }, clock);

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Ghost" }), {}, deps(), createDiscardedItems()),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_NOT_FOUND\] No player named Ghost/);
  assert.deepEqual(result.drop.dropped, []);
  assert.equal(items().length, 1, "nothing was tossed");
});

dropTest("reports a player the route could not reach", async ({ clock, run }) => {
  const { bot } = dropBot(
    {
      carried: [{ name: "bread", count: 8 }],
      players: { Dev: { id: 42, position: { x: 40, y: 64, z: 40 } } },
    },
    clock,
  );

  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Dev" }),
      {},
      deps({ navigate: (async () => ({ status: "stopped", elapsedMs: 900, reason: "no route" })) as never }),
      createDiscardedItems(),
    ),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_UNREACHABLE\] Pathfinder could not reach Dev/);
});

dropTest("registers only what it actually tossed, so a later sweep leaves that alone and nothing else", async ({ clock, run }) => {
  const cobblestone = parseDropItemRequest({ items: [{ item_name: "cobblestone" }] });
  const carried = [{ name: "cobblestone", count: 64 }];

  // The tossed stack is remembered; a diamond already lying there is not this bot's discard.
  const { bot, harness } = dropBot({ carried, existingItems: [{ id: 12, name: "diamond" }], tossWaitsForSpawn: true }, clock);
  const discarded: DiscardedItems = createDiscardedItems();
  const result = await run(dropItem(bot, cobblestone, {}, deps(), discarded));
  assert.equal(result.status, "succeeded");
  const tossed = Object.values(bot.entities).filter((entity) => entity.name === "item" && entity.id !== 12);
  assert.ok(tossed.length > 0, "the server spawned the tossed stack");
  assert.deepEqual([tossed.every((entity) => discarded.ignored().has(entity.id)), discarded.ignored().has(12)], [true, false]);

  // A mob dies across the clearing while the toss is settling: too far away to be this toss.
  harness.entities.spawn({ id: 99, name: "item", position: new Vec3(0.5, 64, 30.5), item: { name: "bone", count: 1 } });
  assert.equal(discarded.ignored().has(99), false);

  // Nothing tossed, nothing claimed, even when an item spawns.
  const swallowed = createDiscardedItems();
  const { bot: silent } = dropBot({ carried: [{ name: "gravel", count: 4 }], swallows: "gravel" }, clock);
  const failed = await run(dropItem(silent, parseDropItemRequest({ items: [{ item_name: "gravel" }] }), {}, deps(), swallowed));
  assert.equal(failed.status, "failed");
  assert.deepEqual([...swallowed.ignored()], []);
});

test("formats the drop, the location, and the pickup warning", () => {
  const markdown = formatDropItemResult({
    status: "succeeded",
    drop: {
      dropped: [{ item: "cobblestone", requested: null, carriedBefore: 64, carriedAfter: 0, dropped: 64 }],
      freeSlotsBefore: 2,
      freeSlotsAfter: 3,
      droppedAt: { x: 100.5, y: 3, z: 92.5 },
      recipient: null,
      hole: null,
      holeClosure: null,
    },
  });

  assert.match(markdown, /Dropped \*\*cobblestone\*\* x64/);
  assert.match(markdown, /Dropped at `100\.5, 3\.0, 92\.5`/);
  assert.match(markdown, /Free slots 2 → 3/);
  assert.match(markdown, /despawn after about five minutes/);
});

dropTest("items picked up again after the toss are no drop (live 2026-10-10 run 7: coal dropped and picked straight up)", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "coal", count: 16 }] }, clock);

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "coal" }] }), {}, deps({ pickupWaitMs: PICKED_UP_BY_MS }), createDiscardedItems()),
  );

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /^\[DROP_PICKED_UP\] coal came back into the inventory/);
  assert.equal(result.drop.dropped[0]?.dropped, 0);
});

dropTest("picked-up items never count, even from a partial toss", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "coal", count: 16 }, { name: "coal", count: 8 }] }, clock);

  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "coal", count: 8 }] }), {}, deps({ pickupWaitMs: PICKED_UP_BY_MS }), createDiscardedItems()),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.drop.dropped[0]?.dropped, 0);
});

dropTest("a ground drop walks off before the pickup check, so the items stay dropped (live 2026-10-10 run 9: ground toss picked straight back)", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 4 }] }, clock);
  const goals: unknown[] = [];
  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "oak_log" }] }),
      {},
      deps({
        pickupWaitMs: PICKED_UP_BY_MS,
        navigate: (async (options: { goal: unknown }) => {
          goals.push(options.goal);
          bot.entity.position = bot.entity.position.offset(0, 0, 5);
          return { status: "completed", elapsedMs: 10 };
        }) as never,
      }),
      createDiscardedItems(),
    ),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(goals.length, 1, "the first side was enough");
  assert.equal(result.drop.dropped[0]?.dropped, 4);
});

dropTest("a ground drop whose body stops short of the node centre the goal accepted needs no second side", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 4 }] }, clock);
  let tries = 0;
  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "oak_log" }] }),
      {},
      deps({
        pickupWaitMs: PICKED_UP_BY_MS,
        navigate: (async () => {
          tries += 1;
          // Four blocks from the toss in the cell's centre (z 4.5), the body 0.07 short of it.
          bot.entity.position.set(bot.entity.position.x, bot.entity.position.y, 4.43);
          return { status: "completed", elapsedMs: 10 };
        }) as never,
      }),
      createDiscardedItems(),
    ),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(tries, 1, "the first side was enough");
});

dropTest("a ground drop that cannot walk away still reports the items picked up again", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 4 }] }, clock);
  let tries = 0;
  const result = await run(
    dropItem(
      bot,
      parseDropItemRequest({ items: [{ item_name: "oak_log" }] }),
      {},
      deps({
        pickupWaitMs: PICKED_UP_BY_MS,
        navigate: (async () => {
          tries += 1;
          return { status: "stopped", elapsedMs: 5, reason: "no route" };
        }) as never,
      }),
      createDiscardedItems(),
    ),
  );
  assert.equal(tries, 4, "all four sides were tried");
  assert.equal(result.status, "failed");
  assert.ok(result.drop.dropped[0]?.error?.startsWith("[DROP_PICKED_UP]"));
});

dropTest("a drop of 10 cut off after the first stack of 5 tosses 10 in all, not 5 and not 15", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 5 }, { name: "cobblestone", count: 5 }] }, clock);
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(items(), []);
  assert.deepEqual(
    [result.drop.dropped[0]?.requested, result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedBefore],
    [10, 10, 10],
  );
});

dropTest("a toss of 10 from one stack that resolved just before the abort is not tossed again", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 20 }] }, clock);
  const owner = new AbortController();
  const counted = abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(counted.tosses, 1);
  assert.equal(items()[0]?.count, 10);
  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedAfter], [10, 10]);
});

dropTest("food a reflex ate between attempts is not dropped, and the result says fewer were dropped", async ({ clock, run }) => {
  const { bot, harness } = dropBot(
    { carried: [{ name: "cooked_beef", count: 4 }, { name: "cooked_beef", count: 4 }, { name: "cooked_beef", count: 4 }] },
    clock,
  );
  const owner = new AbortController();
  abortAfterToss(bot, owner, 2);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cooked_beef", count: 12 }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const beef = bot.registry.itemsByName.cooked_beef!.id;
  setCarriedCount(harness.inventory, bot.registry, beef, bot.inventory.count(beef, null) - 1);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedAfter], [11, 0]);
  assert.match(formatDropItemResult(result), /1 more left the inventory meanwhile/);
});

dropTest("an item a reflex held between attempts is still dropped once the drop is under way", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 5 }, { name: "cobblestone", count: 5 }] }, clock);
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  await bot.equip(bot.inventory.items()[0]!, "hand");
  assert.equal(bot.heldItem?.name, "cobblestone");
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.dropped[0]?.dropped, 10);
});

dropTest("a second call after a finished drop returns the success without tossing again", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 20 }] }, clock);
  const counted = abortAfterToss(bot, new AbortController(), 99);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  const first = await run(attempt());
  const second = await run(attempt());

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(counted.tosses, 1);
  assert.equal(items()[0]?.count, 10);
  assert.equal(second.drop.dropped[0]?.dropped, 10);
});

dropTest("an item the reflex used up entirely is reported not carried instead of being tossed again", async ({ clock, run }) => {
  const { bot, harness } = dropBot({ carried: [{ name: "cooked_beef", count: 3 }] }, clock);
  const owner = new AbortController();
  owner.abort(new Error("hunger reflex"));
  const attempt = dropAttempts(bot, { items: [{ item_name: "cooked_beef" }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  setCarriedCount(harness.inventory, bot.registry, bot.registry.itemsByName.cooked_beef!.id, 0);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /DROP_NOT_CARRIED/);
});

dropTest("a ground drop of every plug block keeps none", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 70 }] }, clock);
  const result = await run(dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps(), createDiscardedItems()));
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.keptForPlug], [70, undefined]);
});

dropTest("a count of 1 of two iron pickaxes drops the worn one, wherever it is in the inventory (review #5)", async ({ clock, run }) => {
  const pickaxe = (durabilityUsed: number) => ({ name: "iron_pickaxe", count: 1, durabilityUsed });
  const { bot, items } = dropBot({ carried: [pickaxe(10), pickaxe(240), pickaxe(120)] }, clock);

  const result = await run(dropItem(bot, parseDropItemRequest({ items: [{ item_name: "iron_pickaxe", count: 1 }] }), {}, deps(), createDiscardedItems()));

  assert.equal(result.status, "succeeded");
  assert.deepEqual(items().map((stack) => stack.durabilityUsed), [10, 120], "the pickaxe with 10 left went, the two better ones stay");
});

dropTest("tools without a durability and stackable items keep inventory order", async ({ clock, run }) => {
  const unmarked = (count: number) => ({ name: "bucket", count });
  const { bot, items } = dropBot({ carried: [unmarked(1), unmarked(1)] }, clock);
  const secondBucket = items()[1]!.slot;
  await run(dropItem(bot, parseDropItemRequest({ items: [{ item_name: "bucket", count: 1 }] }), {}, deps(), createDiscardedItems()));
  assert.deepEqual(items().map((stack) => stack.slot), [secondBucket], "the first bucket went");

  const stacks = dropBot({ carried: [{ name: "cobblestone", count: 5 }, { name: "cobblestone", count: 64 }] }, clock);
  await run(dropItem(stacks.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone", count: 5 }] }), {}, deps(), createDiscardedItems()));
  assert.deepEqual(stacks.items().map((stack) => stack.count), [64], "a count equal to the first stack frees that slot");
});

dropTest("a toss the server swallowed, cut off by a reflex before it was confirmed, is not counted as dropped on the resume", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "gravel", count: 4 }], swallows: "gravel" }, clock);
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "gravel" }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "failed", "the inventory never lost the gravel: nothing was dropped");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_NOT_OBSERVED\].*gravel x4/);
  assert.equal(result.drop.dropped[0]?.dropped, 0);
  assert.equal(items()[0]?.count, 4);
});

dropTest("a toss cut off before its confirmation that the server did carry out is still counted once", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 20 }] }, clock);
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(run(attempt(owner.signal)), /hunger reflex/);
  const result = await run(attempt(new AbortController().signal));

  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.drop.dropped[0]?.dropped, items()[0]?.count], [10, 10], "10 tossed in all, not 20");
});

dropTest("a ground drop from the air is refused before any toss, and the refusal names what to do next", async ({ clock, run }) => {
  // Run 16, Oskar pinned on ghost air: 58 ground tosses at his feet, each picked straight back up for want of a walk away.
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 64 }] }, clock);
  bot.entity.onGround = false;

  const result = await run(dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps({ groundedWaitMs: 30 }), createDiscardedItems()));

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_GROUND_UNAVAILABLE\].*navigate/);
  assert.deepEqual(result.drop.dropped, [], "nothing was tossed");
  assert.equal(items()[0]?.count, 64);
});

dropTest("a ground drop waits for the body to land, and one in water or seated is not refused", async ({ clock, run }) => {
  const landing = dropBot({ carried: [{ name: "cobblestone", count: 4 }] }, clock);
  landing.bot.entity.onGround = false;
  setTimeout(() => {
    landing.bot.entity.onGround = true;
    landing.bot.emit("physicsTick");
  }, 20);
  const landed = await run(dropItem(landing.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps({ groundedWaitMs: 500 }), createDiscardedItems()));
  assert.equal(landed.status, "succeeded", "a body that lands within the wait is no refusal");

  const swimming = dropBot({ carried: [{ name: "cobblestone", count: 4 }] }, clock);
  swimming.bot.entity.onGround = false;
  Reflect.set(swimming.bot.entity, "isInWater", true);
  const swum = await run(dropItem(swimming.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps({ groundedWaitMs: 30 }), createDiscardedItems()));
  assert.equal(JSON.stringify(swum).includes("DROP_GROUND_UNAVAILABLE"), false, "a swimmer tosses into the water and swims on");
});
