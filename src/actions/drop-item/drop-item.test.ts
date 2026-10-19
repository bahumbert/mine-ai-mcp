import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, EQUIPMENT_SLOTS, type FakeStack } from "../../test-support/bot.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { formatDropItemResult, dropItem, type DropItemDependencies } from "./drop-item.js";
import { PLAYER_EYE_HEIGHT, tossAimHeight } from "./hand-over.js";

interface DropBotOptions {
  readonly carried: readonly FakeStack[];
  readonly worn?: Partial<Record<"head" | "torso" | "legs" | "feet" | "off-hand", string>>;
  readonly held?: string;
  /** Toss this item name throws instead of removing it. */
  readonly rejects?: string;
  /** Toss this item name silently succeeds without the inventory changing. */
  readonly swallows?: string;
  readonly players?: Record<string, { id: number; position: { x: number; y: number; z: number } }>;
  readonly position?: { x: number; y: number; z: number };
  /** Item entities already on the ground before the action runs. */
  readonly existingItems?: readonly { id: number; name: string; distance?: number }[];
  /** Entity id the server spawns for each successful toss, as the real one does. */
  readonly spawnsEntityId?: number;
  /** The tossed items come back into the inventory (picked up again) this long after the toss. */
  readonly returnsAfterMs?: number;
  /** With `returnsAfterMs`: the items come back only if the bot is then within this many blocks of where it tossed them. */
  readonly returnsWithin?: number;
  /** The server announces this pickup `afterMs` after the toss; the giver's also puts the items back in its inventory. */
  readonly collects?: { readonly by: "recipient" | "giver"; readonly afterMs: number };
  /** Stack count the spawned item entity reports. */
  readonly spawnedCount?: number;
}

function dropBot(options: DropBotOptions) {
  const items = options.carried.map((stack) => ({ ...stack }));
  const lookedAt: { x: number; y: number; z: number }[] = [];
  const slots: Record<number, { name: string } | null> = {};
  for (const [slot, name] of Object.entries(options.worn ?? {})) {
    if (name) slots[EQUIPMENT_SLOTS[slot]!] = { name };
  }

  /** Mineflayer tosses one identified stack, not "n of this name", so the fake must too. */
  const removeStack = (stack: FakeStack) => {
    const index = items.indexOf(stack);
    if (index >= 0) items.splice(index, 1);
  };
  const removeFrom = (stack: FakeStack, count: number) => {
    stack.count -= Math.min(stack.count, count);
    if (stack.count === 0) removeStack(stack);
  };

  const itemEntity = (id: number, name: string, distance = 1) => ({
    id,
    name: "item",
    position: new Vec3(0, 64, distance),
    getDroppedItem: () => ({ name, count: options.spawnedCount ?? 1 }),
  });
  const entities: Record<number, unknown> = {};
  for (const existing of options.existingItems ?? []) {
    entities[existing.id] = itemEntity(existing.id, existing.name, existing.distance);
  }
  /** A successful toss makes the server spawn the item beside the bot. */
  const spawnTossed = (name: string) => {
    if (options.spawnsEntityId === undefined) return;
    entities[options.spawnsEntityId] = itemEntity(options.spawnsEntityId, name);
  };
  /** The server tells the bot who picked a tossed item up. */
  const announceCollect = (stack: FakeStack) => {
    const collects = options.collects;
    const tossed = options.spawnsEntityId === undefined ? undefined : entities[options.spawnsEntityId];
    if (!collects || !tossed) return;
    setTimeout(() => {
      if (collects.by === "giver") items.push(stack);
      const collector = collects.by === "giver" ? bot.entity : Object.values(bot.players)[0]?.entity;
      bot.emit("playerCollect", collector as never, tossed as never);
    }, collects.afterMs);
  };

  // eslint-disable-next-line prefer-const
  let bot: ReturnType<typeof botFixture>;
  const comeBack = (stack: FakeStack) => {
    if (options.returnsAfterMs === undefined) return;
    const tossedFrom = bot.entity.position.clone();
    setTimeout(() => {
      if (options.returnsWithin === undefined || bot.entity.position.distanceTo(tossedFrom) <= options.returnsWithin) items.push(stack);
    }, options.returnsAfterMs);
  };

  bot = botFixture(
    {
      items,
      slots,
      entities,
      position: options.position,
      players: Object.fromEntries(
        Object.entries(options.players ?? {}).map(([name, player]) => [
          name,
          { entity: { id: player.id, username: name, height: 1.8, position: new Vec3(player.position.x, player.position.y, player.position.z) } },
        ]),
      ),
    },
    {
      heldItem: options.held ? { name: options.held } : null,
      lookAt: async (position: { x: number; y: number; z: number }) => {
        lookedAt.push({ x: position.x, y: position.y, z: position.z });
      },
      tossStack: async (stack: FakeStack) => {
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeStack(stack);
        spawnTossed(stack.name);
        comeBack({ ...stack });
        announceCollect({ ...stack });
      },
      toss: async (type: number, _metadata: number | null, count: number) => {
        const stack = items.find((candidate) => candidate.type === type);
        if (!stack) return;
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeFrom(stack, count);
        spawnTossed(stack.name);
        comeBack({ ...stack, count });
        announceCollect({ ...stack, count });
      },
    },
  );
  return { bot, items, lookedAt, entities };
}

function deps(overrides: Partial<DropItemDependencies> = {}): DropItemDependencies {
  return {
    navigate: async () => ({ status: "completed", elapsedMs: 10 }) as never,
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "not placed in this test" }),
    createMovements: (() => ({})) as never,
    settleMs: 50,
    pickupWaitMs: 150,
    handoverWaitMs: 100,
    ...overrides,
  };
}

test("drops every stack of an item and reports the inventory delta", async () => {
  const { bot, items } = dropBot({
    carried: [
      { name: "cobblestone", count: 64, type: 1 },
      { name: "cobblestone", count: 12, type: 2 },
      { name: "diamond", count: 3, type: 3 },
    ],
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.carriedAfter]),
    [["cobblestone", 76, 0]],
  );
  assert.equal(result.drop.freeSlotsBefore, 33);
  assert.equal(result.drop.freeSlotsAfter, 35);
  assert.deepEqual(
    items.map((stack) => stack.name),
    ["diamond"],
  );
});

test("drops only the requested count, leaving the rest carried", async () => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 64, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "cobblestone", count: 10 }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.dropped[0]?.dropped, 10);
  assert.equal(result.drop.dropped[0]?.carriedAfter, 54);
});

test("a count above what is carried drops all of it and succeeds", async () => {
  // Live 2026-10-09: "drop 16 oak_planks" with 2 carried dropped both, then failed DROP_NOT_OBSERVED; the step was
  // retried and each retry failed DROP_NOT_CARRIED for the planks already gone.
  const { bot } = dropBot({ carried: [{ name: "oak_planks", count: 2, type: 1 }, { name: "cobblestone", count: 64, type: 2 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "oak_planks", count: 16 }, { item_name: "cobblestone", count: 10 }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.carriedAfter, entry.error]), [["oak_planks", 2, 0, undefined], ["cobblestone", 10, 54, undefined]]);
});

test("never drops worn armour, and refuses the held item without allow_equipped", async () => {
  const { bot, items } = dropBot({
    carried: [
      { name: "iron_chestplate", count: 1, type: 1 },
      { name: "diamond_pickaxe", count: 1, type: 2 },
    ],
    worn: { torso: "iron_chestplate" },
    held: "diamond_pickaxe",
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\].*torso/);
  assert.match(result.drop.dropped[1]?.error ?? "", /\[DROP_HELD\].*allow_equipped/);
  assert.equal(items.length, 2, "nothing was tossed");
});

test("allow_equipped releases the held item but never the worn one", async () => {
  const { bot } = dropBot({
    carried: [
      { name: "iron_chestplate", count: 1, type: 1 },
      { name: "diamond_pickaxe", count: 1, type: 2 },
    ],
    worn: { torso: "iron_chestplate" },
    held: "diamond_pickaxe",
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({
      items: [{ item_name: "iron_chestplate" }, { item_name: "diamond_pickaxe" }],
      allow_equipped: true,
    }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "partial");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_WORN\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 1);
});

test("reports an item that is not carried without touching the others, and is no failure once others were carried", async () => {
  // Live 2026-10-09: drops listing tools she did not carry "failed 9 of 9" after freeing slots, and were sent again.
  const { bot } = dropBot({ carried: [{ name: "gravel", count: 4, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "clay_ball" }, { item_name: "gravel" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "succeeded");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_NOT_CARRIED\]/);
  assert.equal(result.drop.dropped[1]?.dropped, 4);

  // Nothing listed is carried (a wrong id): still a failure.
  const none = await dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_plank" }] }), {}, deps(), createDiscardedItems());
  assert.equal(none.status, "failed");
  assert.match(none.error ?? "", /\[DROP_INCOMPLETE\] 1 of 1 item/);
});

test("the incomplete error says why each item failed (live 2026-10-10 run 8: 69 steps read only '4 of 4 items could not be dropped')", async () => {
  const { bot } = dropBot({ carried: [], held: undefined });
  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "sand", count: 3 }, { item_name: "granite" }] }),
    {},
    deps(),
    createDiscardedItems(),
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_INCOMPLETE\] 2 of 2 items could not be dropped: sand: not carried; granite: not carried/);

  const swallowing = dropBot({ carried: [{ name: "gravel", count: 4, type: 1 }], swallows: "gravel" });
  const swallowed = await dropItem(swallowing.bot, parseDropItemRequest({ items: [{ item_name: "gravel" }] }), {}, deps(), createDiscardedItems());
  assert.equal(swallowed.status, "failed");
  assert.match("error" in swallowed ? swallowed.error ?? "" : "", /could not be dropped: gravel: \[DROP_NOT_OBSERVED\]/);
});

test("a toss the server swallows or rejects is reported, not assumed", async () => {
  const gravel = parseDropItemRequest({ items: [{ item_name: "gravel" }] });
  const carried = [{ name: "gravel", count: 4, type: 1 }];

  const swallowed = await dropItem(
    dropBot({ carried, swallows: "gravel" }).bot,
    gravel,
    {},
    deps(),
    createDiscardedItems(),
  );
  assert.equal(swallowed.status, "failed");
  assert.match(swallowed.drop.dropped[0]?.error ?? "", /\[DROP_NOT_OBSERVED\].*gravel x4/);

  const rejected = await dropItem(
    dropBot({ carried, rejects: "gravel" }).bot,
    gravel,
    {},
    deps(),
    createDiscardedItems(),
  );
  assert.equal(rejected.status, "failed");
  assert.match(rejected.drop.dropped[0]?.error ?? "", /\[DROP_REJECTED\].*server refused/);
});

test("walks to the named player, faces them, and records the handover", async () => {
  const { bot, lookedAt } = dropBot({
    carried: [{ name: "bread", count: 8, type: 1 }],
    players: { Dev: { id: 42, position: { x: 1, y: 64, z: 1 } } },
    position: { x: 0, y: 64, z: 0 },
  });
  let goalRange: number | null = null;

  const result = await dropItem(
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
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.name, "Dev");
  assert.equal(result.drop.dropped[0]?.dropped, 8);
  assert.equal(lookedAt.length, 1, "faced the player before tossing");
  assert.equal(goalRange, null, "the entity goal carries its own range");
});

test("refuses to hand items to a player who is not loaded, dropping nothing", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "bread", count: 8, type: 1 }] });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Ghost" }),
    {},
    deps(),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_NOT_FOUND\] No player named Ghost/);
  assert.deepEqual(result.drop.dropped, []);
  assert.equal(items.length, 1, "nothing was tossed");
});

test("reports a player the route could not reach", async () => {
  const { bot } = dropBot({
    carried: [{ name: "bread", count: 8, type: 1 }],
    players: { Dev: { id: 42, position: { x: 40, y: 64, z: 40 } } },
  });

  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "bread" }], to_player: "Dev" }),
    {},
    deps({ navigate: (async () => ({ status: "stopped", elapsedMs: 900, reason: "no route" })) as never }),
    createDiscardedItems(),
  );

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /\[DROP_PLAYER_UNREACHABLE\] Pathfinder could not reach Dev/);
});

test("registers only what it actually tossed, so a later sweep leaves that alone and nothing else", async () => {
  const cobblestone = parseDropItemRequest({ items: [{ item_name: "cobblestone" }] });
  const carried = [{ name: "cobblestone", count: 64, type: 1 }];

  // The tossed stack is remembered; a diamond already lying there is not this bot's discard.
  const { bot, entities } = dropBot({ carried, existingItems: [{ id: 12, name: "diamond" }], spawnsEntityId: 77 });
  const discarded: DiscardedItems = createDiscardedItems();
  const result = await dropItem(bot, cobblestone, {}, deps(), discarded);
  assert.equal(result.status, "succeeded");
  assert.deepEqual([discarded.ignored().has(77), discarded.ignored().has(12)], [true, false]);

  // A mob dies across the clearing while the toss is settling: too far away to be this toss.
  entities[99] = { id: 99, name: "item", position: new Vec3(0, 64, 30), getDroppedItem: () => ({ name: "bone" }) };
  assert.equal(discarded.ignored().has(99), false);

  // Nothing tossed, nothing claimed, even when an item spawns.
  const swallowed = createDiscardedItems();
  const { bot: silent } = dropBot({
    carried: [{ name: "gravel", count: 4, type: 1 }],
    swallows: "gravel",
    spawnsEntityId: 77,
  });
  const failed = await dropItem(
    silent,
    parseDropItemRequest({ items: [{ item_name: "gravel" }] }),
    {},
    deps(),
    swallowed,
  );
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

test("items picked up again after the toss are no drop (live 2026-10-10 run 7: coal dropped and picked straight up)", async () => {
  const { bot } = dropBot({ carried: [{ name: "coal", count: 16, type: 1 }], returnsAfterMs: 80 });

  const result = await dropItem(bot, parseDropItemRequest({ items: [{ item_name: "coal" }] }), {}, deps(), createDiscardedItems());

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /^\[DROP_PICKED_UP\] coal came back into the inventory/);
  assert.equal(result.drop.dropped[0]?.dropped, 0);
});

test("picked-up items never count, even from a partial toss", async () => {
  const { bot } = dropBot({ carried: [{ name: "coal", count: 16, type: 1 }, { name: "coal", count: 8, type: 2 }], returnsAfterMs: 80 });

  const result = await dropItem(bot, parseDropItemRequest({ items: [{ item_name: "coal", count: 8 }] }), {}, deps(), createDiscardedItems());

  assert.equal(result.status, "failed");
  assert.equal(result.drop.dropped[0]?.dropped, 0);
});

test("a ground drop walks off before the pickup check, so the items stay dropped (live 2026-10-10 run 9: ground toss picked straight back)", async () => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 4, type: 1 }], returnsAfterMs: 80, returnsWithin: 2 });
  const goals: unknown[] = [];
  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "oak_log" }] }),
    {},
    deps({
      navigate: (async (options: { goal: unknown }) => {
        goals.push(options.goal);
        bot.entity.position = bot.entity.position.offset(0, 0, 5);
        return { status: "completed", elapsedMs: 10 };
      }) as never,
    }),
    createDiscardedItems(),
  );
  assert.equal(result.status, "succeeded");
  assert.equal(goals.length, 1, "the first side was enough");
  assert.equal(result.drop.dropped[0]?.dropped, 4);
});

test("a ground drop that cannot walk away still reports the items picked up again", async () => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 4, type: 1 }], returnsAfterMs: 80, returnsWithin: 2 });
  let tries = 0;
  const result = await dropItem(
    bot,
    parseDropItemRequest({ items: [{ item_name: "oak_log" }] }),
    {},
    deps({ navigate: (async () => { tries += 1; return { status: "stopped", elapsedMs: 5, reason: "no route" }; }) as never }),
    createDiscardedItems(),
  );
  assert.equal(tries, 4, "all four sides were tried");
  assert.equal(result.status, "failed");
  assert.ok(result.drop.dropped[0]?.error?.startsWith("[DROP_PICKED_UP]"));
});

const handOver = (options: Partial<DropBotOptions> = {}) =>
  dropBot({
    carried: [{ name: "oak_log", count: 3, type: 1 }],
    players: { Dev: { id: 42, position: { x: 0, y: 64, z: 1.5 } } },
    spawnsEntityId: 90,
    spawnedCount: 3,
    ...options,
  });
const handOverRequest = parseDropItemRequest({ items: [{ item_name: "oak_log" }], to_player: "Dev" });

test("hand-over: the recipient collects -> succeeded, collected true", async () => {
  const { bot } = handOver({ collects: { by: "recipient", afterMs: 40 } });
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWaitMs: 1_000 }), createDiscardedItems());
  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.collectedCount, 3);
  assert.match(formatDropItemResult(result), /Handed to \*\*Dev\*\*/);
});

test("hand-over: the giver collects its toss back -> failed [DROP_PICKED_UP]", async () => {
  const { bot } = handOver({ collects: { by: "giver", afterMs: 40 } });
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWaitMs: 1_000 }), createDiscardedItems());
  assert.equal(result.status, "failed");
  assert.ok(result.drop.dropped[0]?.error?.startsWith("[DROP_PICKED_UP]"));
  assert.equal(result.drop.recipient?.collected, false);
});

test("hand-over: nobody collects within the wait -> succeeded, collected false, ends within the wait on the wall clock", async () => {
  const { bot } = handOver();
  const startedAt = Date.now();
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWaitMs: 200 }), createDiscardedItems());
  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.ok(Date.now() - startedAt < 1_000, "the wait is bounded");
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet, not picked up yet/);
});

test("hand-over: the giver aims the toss at the recipient", async () => {
  const { bot, lookedAt } = handOver({ collects: { by: "recipient", afterMs: 10 } });
  await dropItem(bot, handOverRequest, {}, deps({ handoverWaitMs: 500 }), createDiscardedItems());
  assert.equal(lookedAt.length, 1);
  assert.equal(lookedAt[0]!.y, 64 + tossAimHeight(Math.hypot(0.5, 1)), "aimed at the height that lands the toss at their feet");
});

test("hand-over: the giver steps away after the toss", async () => {
  const { bot } = handOver({ collects: { by: "recipient", afterMs: 10 } });
  let routes = 0;
  await dropItem(
    bot,
    handOverRequest,
    {},
    deps({
      handoverWaitMs: 500,
      navigate: (async () => {
        routes += 1;
        return { status: "completed", elapsedMs: 5 };
      }) as never,
    }),
    createDiscardedItems(),
  );
  assert.ok(routes > 0, "the giver routed away from the toss (the recipient was already in reach, so no approach route)");
});

test("hand-over: abort during the wait removes the listener", async () => {
  const { bot } = handOver();
  const controller = new AbortController();
  const run = dropItem(bot, handOverRequest, { signal: controller.signal }, deps({ handoverWaitMs: 5_000 }), createDiscardedItems());
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(run);
  assert.equal(bot.listenerCount("playerCollect"), 0);
});

test("hand-over: a pickup announced while the giver walks away still counts", async () => {
  const { bot } = handOver({ collects: { by: "recipient", afterMs: 20 } });
  const result = await dropItem(
    bot,
    handOverRequest,
    {},
    deps({
      handoverWaitMs: 1_000,
      navigate: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        return { status: "completed", elapsedMs: 80 };
      }) as never,
    }),
    createDiscardedItems(),
  );
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.collectedCount, 3);
});

test("hand-over: the aim height makes the toss land at the recipient's feet, from 0.5 to 2 blocks", () => {
  const pitchDown = (distance: number) => (Math.atan2(PLAYER_EYE_HEIGHT - tossAimHeight(distance), distance) * 180) / Math.PI;
  // Measured toss reach (Mine Labs 2026-10-20, simulated and live): level it slides about 4.3 blocks, 60 degrees down 1.5.
  for (const [distance, expected] of [[0.5, 79.5], [1, 69], [1.47, 59], [2, 48]] as const) {
    assert.ok(Math.abs(pitchDown(distance) - expected) < 1, `${distance} blocks: ${pitchDown(distance).toFixed(1)} degrees down`);
  }
  assert.ok(tossAimHeight(0.5) < tossAimHeight(1) && tossAimHeight(1) < tossAimHeight(2), "the farther they are, the higher the aim");
  assert.equal(tossAimHeight(6), PLAYER_EYE_HEIGHT, "beyond the toss reach the aim is level");
});
