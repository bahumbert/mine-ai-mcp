import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { blockClass } from "../../navigation/mineflayer/world.js";
import { botFixture, EQUIPMENT_SLOTS, type FakeStack } from "../../test-support/bot.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { sealedPitGuarding } from "../../world/sealed-pits.js";
import { parseDropItemRequest } from "./contract.js";
import { beginDropItem, formatDropItemResult, dropItem, type DropItemDependencies } from "./drop-item.js";

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
}

const registry = minecraftData("1.21.4");
const Block = blockClass({ registry } as Pick<Bot, "registry">);

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
    getDroppedItem: () => ({ name }),
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
          { entity: { id: player.id, position: new Vec3(player.position.x, player.position.y, player.position.z) } },
        ]),
      ),
    },
    {
      version: "1.21.4", heldItem: options.held ? { name: options.held } : null,
      lookAt: async (position: { x: number; y: number; z: number }) => {
        lookedAt.push({ x: position.x, y: position.y, z: position.z });
      },
      tossStack: async (stack: FakeStack) => {
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeStack(stack);
        spawnTossed(stack.name);
        comeBack({ ...stack });
      },
      toss: async (type: number, _metadata: number | null, count: number) => {
        const stack = items.find((candidate) => candidate.type === type);
        if (!stack) return;
        if (stack.name === options.rejects) throw new Error("server refused");
        if (stack.name === options.swallows) return;
        removeFrom(stack, count);
        spawnTossed(stack.name);
        comeBack({ ...stack, count });
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
  assert.deepEqual(lookedAt, [{ x: 1, y: 64, z: 1 }], "faced the player before tossing");
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

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function dropAttempts(bot: ReturnType<typeof dropBot>["bot"], input: unknown, dependencies = deps()) {
  const run = beginDropItem(bot, parseDropItemRequest(input), () => {}, dependencies, createDiscardedItems());
  return (signal?: AbortSignal) => run({ signal });
}

/** Aborts the request once the nth toss has resolved (a reflex took the body); later tosses go through. */
function abortAfterToss(bot: ReturnType<typeof dropBot>["bot"], owner: AbortController, nth: number): { tosses: number } {
  const count = { tosses: 0 };
  for (const method of ["tossStack", "toss"] as const) {
    const original = (bot as unknown as Record<string, (...args: unknown[]) => Promise<void>>)[method]!;
    (bot as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
      await original(...args);
      count.tosses += 1;
      if (count.tosses === nth) owner.abort(new Error("hunger reflex"));
    };
  }
  return count;
}

test("a drop of 10 cut off after the first stack of 5 tosses 10 in all, not 5 and not 15", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 5, type: 1 }, { name: "cobblestone", count: 5, type: 1 }] });
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(items, []);
  assert.deepEqual(
    [result.drop.dropped[0]?.requested, result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedBefore],
    [10, 10, 10],
  );
});

test("a toss of 10 from one stack that resolved just before the abort is not tossed again", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 20, type: 1 }] });
  const owner = new AbortController();
  const counted = abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(counted.tosses, 1);
  assert.equal(items[0]?.count, 10);
  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedAfter], [10, 10]);
});

test("food a reflex ate between attempts is not dropped, and the result says fewer were dropped", async () => {
  const { bot, items } = dropBot({ carried: [
    { name: "cooked_beef", count: 4, type: 1 }, { name: "cooked_beef", count: 4, type: 1 }, { name: "cooked_beef", count: 4, type: 1 },
  ] });
  const owner = new AbortController();
  abortAfterToss(bot, owner, 2);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cooked_beef", count: 12 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  items[0]!.count -= 1;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.carriedAfter], [11, 0]);
  assert.match(formatDropItemResult(result), /1 more left the inventory meanwhile/);
});

test("an item a reflex held between attempts is still dropped once the drop is under way", async () => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 5, type: 1 }, { name: "cobblestone", count: 5, type: 1 }] });
  const owner = new AbortController();
  abortAfterToss(bot, owner, 1);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  Object.assign(bot, { heldItem: { name: "cobblestone" } });
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.dropped[0]?.dropped, 10);
});

test("a second call after a finished drop returns the success without tossing again", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "cobblestone", count: 20, type: 1 }] });
  const counted = abortAfterToss(bot, new AbortController(), 99);
  const attempt = dropAttempts(bot, { items: [{ item_name: "cobblestone", count: 10 }] });

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.equal(counted.tosses, 1);
  assert.equal(items[0]?.count, 10);
  assert.equal(second.drop.dropped[0]?.dropped, 10);
});

test("an item the reflex used up entirely is reported not carried instead of being tossed again", async () => {
  const { bot, items } = dropBot({ carried: [{ name: "cooked_beef", count: 3, type: 1 }] });
  const owner = new AbortController();
  owner.abort(new Error("hunger reflex"));
  const attempt = dropAttempts(bot, { items: [{ item_name: "cooked_beef" }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  items.length = 0;
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /DROP_NOT_CARRIED/);
});

const dirtBlock = (name: string) => Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);

const DEFAULT_PIT_CARRIED = [{ name: "dirt", count: 3, type: 1 }, { name: "cobblestone", count: 2, type: 2 }];

/**
 * Open ground (dirt below y 64) the dig and the plug change cell by cell; each toss lands its item at the pit's bottom
 * (one entity per item name, its count growing) and each plug block placed is spent from the inventory.
 */
function pitWorld(carried: readonly FakeStack[] = DEFAULT_PIT_CARRIED, options: { readonly plugFails?: boolean; readonly spawnAfterMs?: number } = {}) {
  const changed = new Map<string, string>();
  const { bot, items, entities } = dropBot({
    carried: carried.map((stack) => ({ ...stack })),
    position: { x: 0.5, y: 64, z: 0.5 },
  });
  Object.assign(bot, {
    blockAt: (position: Vec3) => dirtBlock(changed.get(position.toString()) ?? (position.y < 64 ? "dirt" : "air")),
  });
  bot.entity.onGround = true;
  const lying = new Map<string, number>();
  const land = (name: string, count: number) => {
    lying.set(name, (lying.get(name) ?? 0) + count);
    const id = 77 + [...lying.keys()].indexOf(name);
    const spawn = () => {
      entities[id] = { id, name: "item", position: new Vec3(1.5, 62.2, 0.5), getDroppedItem: () => ({ name, count: lying.get(name) }) };
    };
    // The server's spawn packet can arrive after the toss resolved (a server seconds behind).
    if (options.spawnAfterMs === undefined) spawn();
    else setTimeout(spawn, options.spawnAfterMs);
  };
  const tossStack = bot.tossStack.bind(bot);
  bot.tossStack = async (stack) => {
    const { name, count } = stack;
    await tossStack(stack);
    land(name, count);
  };
  const toss = bot.toss.bind(bot);
  bot.toss = async (type, metadata, count) => {
    const name = items.find((stack) => stack.type === type)?.name ?? "";
    await toss(type, metadata, count);
    land(name, count ?? 0);
  };
  const dug: string[] = [];
  const plugged: string[] = [];
  const dependencies = deps({
    breakInPlace: async ({ position }) => {
      dug.push(`${position.x},${position.y},${position.z}`);
      changed.set(new Vec3(position.x, position.y, position.z).toString(), "air");
      return { status: "broken" };
    },
    placeInto: async (placer, cell, item) => {
      if (options.plugFails) return { kind: "failed", error: "not placed in this test" } as never;
      changed.set(new Vec3(cell.x, cell.y, cell.z).toString(), item?.name ?? "cobblestone");
      plugged.push(item?.name ?? "");
      if (item && --item.count === 0) items.splice(items.indexOf(item as unknown as FakeStack), 1);
      return { kind: "placed", block: placer.blockAt(new Vec3(cell.x, cell.y, cell.z))! } as never;
    },
    navigate: async () => {
      bot.entity.position.set(4.5, 64, 0.5);
      return { status: "completed", elapsedMs: 0 } as never;
    },
  });
  return { bot, items, changed, dug, plugged, dependencies };
}

test("a pit half dug when a reflex took the body is dug on, filled with the drop and plugged by the next attempt", async () => {
  const world = pitWorld();
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

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([result.drop.hole?.x, result.drop.hole?.y, result.drop.hole?.z], [1, 62, 0]);
  assert.deepEqual(world.dug, ["1,63,0", "1,62,0"], "each cell of the one pit is dug once");
  assert.equal(result.drop.holeClosure?.placed, 2);
  assert.equal(world.changed.get(new Vec3(1, 63, 0).toString()), "cobblestone");
  assert.equal(world.changed.get(new Vec3(1, 64, 0).toString()), "cobblestone");
});

const BURY_EVERYTHING = { items: [{ item_name: "oak_log" }, { item_name: "cobblestone" }], in_a_hole: true };

test("an \"all\" burial of the only plug-capable stack keeps 2, plugs with them and says so", async () => {
  // Run 16, Anselm: 170 cobblestone buried, nothing left to plug, the stack back 16 s later.
  const world = pitWorld([{ name: "cobblestone", count: 70, type: 1 }, { name: "oak_log", count: 16, type: 2 }]);

  const result = await dropItem(world.bot, parseDropItemRequest(BURY_EVERYTHING), {}, world.dependencies, createDiscardedItems());

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual(result.drop.dropped.map((entry) => [entry.item, entry.dropped, entry.keptForPlug]), [["oak_log", 16, undefined], ["cobblestone", 68, 2]]);
  assert.equal(result.drop.holeClosure?.placed, 2);
  assert.deepEqual(world.plugged, ["cobblestone", "cobblestone"]);
  assert.match(formatDropItemResult(result), /Kept 2 cobblestone to close the hole\./);
});

test("a resumed burial keeps the plug it planned and does not toss the kept blocks", async () => {
  const world = pitWorld([{ name: "cobblestone", count: 64, type: 1 }, { name: "cobblestone", count: 6, type: 1 }]);
  const owner = new AbortController();
  abortAfterToss(world.bot, owner, 1);
  const attempt = dropAttempts(world.bot, { items: [{ item_name: "cobblestone" }], in_a_hole: true }, world.dependencies);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.keptForPlug], [68, 2]);
  assert.deepEqual(world.plugged, ["cobblestone", "cobblestone"]);
  assert.equal(world.items.length, 0, "the two kept blocks went into the plug");
});

test("the same \"all\" drop again buries what the first one left", async () => {
  // A plug that failed leaves the kept blocks carried: the next "all" drop is another burial and keeps again.
  const failed = pitWorld([{ name: "cobblestone", count: 70, type: 1 }], { plugFails: true });
  const first = await dropItem(failed.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, failed.dependencies, createDiscardedItems());
  assert.equal(first.drop.dropped[0]?.dropped, 68);
  assert.match(first.drop.holeClosure?.error ?? "", /DROP_HOLE_OPEN/);
  assert.equal(failed.items[0]?.count, 2, "the kept blocks are still carried");

  for (const [carried, keeps, buries] of [[3, 2, 1], [2, 1, 1]] as const) {
    const world = pitWorld([{ name: "cobblestone", count: carried, type: 1 }]);
    const again = await dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, world.dependencies, createDiscardedItems());
    assert.deepEqual([again.drop.dropped[0]?.dropped, again.drop.dropped[0]?.keptForPlug, again.drop.holeClosure?.placed], [buries, keeps, keeps], `${carried} carried`);
  }
});

test("a ground drop of every plug block keeps none", async () => {
  const { bot } = dropBot({ carried: [{ name: "cobblestone", count: 70, type: 1 }] });
  const result = await dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps(), createDiscardedItems());
  assert.deepEqual([result.drop.dropped[0]?.dropped, result.drop.dropped[0]?.keptForPlug], [70, undefined]);
});

test("stacks the server spawns after the toss resolved are claimed once seen in the pit", async () => {
  // Run 16, Theo 17:18:58: collect_block took 18 logs from the pit buried 28 s before; the claim ran before the spawn.
  const world = pitWorld([{ name: "cobblestone", count: 70, type: 1 }, { name: "oak_log", count: 16, type: 2 }], { spawnAfterMs: 30 });
  const discarded = createDiscardedItems();

  const result = await dropItem(world.bot, parseDropItemRequest(BURY_EVERYTHING), {}, { ...world.dependencies, settleMs: 300 }, discarded);

  assert.equal(result.status, "succeeded", JSON.stringify(result));
  assert.deepEqual([...discarded.ignored()].sort(), [77, 78], "both stacks that landed in the pit are claimed");
});

test("a sealed burial is remembered, an open one is not", async () => {
  const sealed = pitWorld([{ name: "cobblestone", count: 70, type: 1 }]);
  await dropItem(sealed.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, sealed.dependencies, createDiscardedItems());
  assert.deepEqual(sealedPitGuarding(sealed.bot, 1, 62, 0), { x: 1, y: 62, z: 0 });

  const open = pitWorld([{ name: "cobblestone", count: 70, type: 1 }], { plugFails: true });
  await dropItem(open.bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }], in_a_hole: true }), {}, open.dependencies, createDiscardedItems());
  assert.equal(sealedPitGuarding(open.bot, 1, 62, 0), null);
});
