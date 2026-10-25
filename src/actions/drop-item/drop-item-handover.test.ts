import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, EQUIPMENT_SLOTS, type FakeStack } from "../../test-support/bot.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { formatDropItemResult, dropItem, type DropItemDependencies } from "./drop-item.js";
import { handOverLine, PLAYER_EYE_HEIGHT, tossAimHeight } from "./hand-over.js";

interface Collect {
  readonly by: "recipient" | "giver" | "other";
  readonly afterMs: number;
  /** The packet's `pickupItemCount`; the tossed stack's count when omitted. */
  readonly count?: number;
}

const OTHER_PLAYER_ID = 5_000;

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
  /** The server announces these pickups (raw `collect` packets) after the toss; the giver's also puts the items back in its inventory. */
  readonly collects?: Collect | readonly Collect[];
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
  const removeFrom = (stack: FakeStack, count: number) => {
    stack.count -= Math.min(stack.count, count);
    if (stack.count === 0 && items.includes(stack)) items.splice(items.indexOf(stack), 1);
  };
  /** A toss the server accepts leaves the inventory, spawns an entity, may come back and may be announced picked up. */
  const tossOut = (stack: FakeStack, count: number) => {
    if (stack.name === options.rejects) throw new Error("server refused");
    if (stack.name === options.swallows) return;
    const thrown = { ...stack, count };
    removeFrom(stack, count);
    spawnTossed(stack.name);
    comeBack(thrown);
    announceCollect(thrown);
  };

  const entities: Record<number, unknown> = {};
  for (const existing of options.existingItems ?? []) {
    entities[existing.id] = itemEntity(existing.id, existing.name, options.spawnedCount, existing.distance);
  }
  /** A successful toss makes the server spawn the item beside the bot. */
  const spawnTossed = (name: string) => {
    if (options.spawnsEntityId === undefined) return;
    entities[options.spawnsEntityId] = itemEntity(options.spawnsEntityId, name, options.spawnedCount);
  };
  const client = new EventEmitter();
  const announceCollect = (stack: FakeStack) => emitCollect({ bot, client, items, entities, options }, stack);
  for (const [name, player] of Object.entries(options.players ?? {})) {
    entities[player.id] = { id: player.id, username: name, name: "player" };
  }
  entities[OTHER_PLAYER_ID] = { id: OTHER_PLAYER_ID, username: "Other", name: "player" };

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
      _client: client,
      heldItem: options.held ? { name: options.held } : null,
      lookAt: async (position: { x: number; y: number; z: number }) => {
        lookedAt.push({ x: position.x, y: position.y, z: position.z });
      },
      tossStack: async (stack: FakeStack) => tossOut(stack, stack.count),
      toss: async (type: number, _metadata: number | null, count: number) => {
        const stack = items.find((candidate) => candidate.type === type);
        if (stack) tossOut(stack, count);
      },
    },
  );
  return { bot, items, lookedAt, entities, advanceAge: (ticks: number) => advanceAge(bot, ticks) };
}

/** A dropped-item entity `distance` blocks from the bot, reporting a stack of `count`. */
function itemEntity(id: number, name: string, count = 1, distance = 1) {
  return { id, name: "item", position: new Vec3(0, 64, distance), getDroppedItem: () => ({ name, count }) };
}

interface CollectFake {
  readonly bot: ReturnType<typeof botFixture>;
  readonly client: EventEmitter;
  readonly items: FakeStack[];
  readonly entities: Record<number, unknown>;
  readonly options: DropBotOptions;
}

/** The server tells the bot who picked a tossed item up, with the count it took; the giver's pickup puts it back in its inventory. */
function emitCollect({ bot, client, items, entities, options }: CollectFake, stack: FakeStack): void {
  if (options.spawnsEntityId === undefined || !entities[options.spawnsEntityId]) return;
  for (const collect of [options.collects ?? []].flat()) {
    setTimeout(() => {
      if (collect.by === "giver") items.push({ ...stack, count: collect.count ?? stack.count });
      const collectorEntityId = { giver: 1, other: OTHER_PLAYER_ID, recipient: Object.values(bot.players)[0]?.entity?.id ?? 0 }[collect.by];
      client.emit("collect", { collectedEntityId: options.spawnsEntityId, collectorEntityId, pickupItemCount: collect.count ?? stack.count });
    }, collect.afterMs);
  }
}

/** The world age moves in jumps of 20 ticks, each announced by a `time` packet, as the server sends them. */
function advanceAge(bot: ReturnType<typeof botFixture>, ticks: number): void {
  for (let moved = 0; moved < ticks; moved += 20) {
    (bot.time as { age: number }).age += 20;
    bot.emit("time");
  }
}

function deps(overrides: Partial<DropItemDependencies> = {}): DropItemDependencies {
  return {
    navigate: async () => ({ status: "completed", elapsedMs: 10 }) as never,
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "not placed in this test" }),
    createMovements: (() => ({})) as never,
    settleMs: 50,
    pickupWaitMs: 150,
    handoverWallMs: 100,
    ...overrides,
  };
}

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
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 1_000 }), createDiscardedItems());
  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
  assert.equal(result.drop.recipient?.collectedCount, 3);
  assert.equal(result.drop.recipient?.tossedCount, 3);
  assert.match(formatDropItemResult(result), /Handed to \*\*Dev\*\*/);
});

test("hand-over: the giver collects its toss back -> failed [DROP_PICKED_UP]", async () => {
  const { bot } = handOver({ collects: { by: "giver", afterMs: 40 } });
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 1_000 }), createDiscardedItems());
  assert.equal(result.status, "failed");
  assert.ok(result.drop.dropped[0]?.error?.startsWith("[DROP_PICKED_UP]"));
  assert.equal(result.drop.recipient?.collected, false);
});

test("hand-over: nobody takes it and the world age moves 100 ticks -> settled, nothing taken, before the wall bound", async () => {
  const { bot, advanceAge } = handOver();
  const startedAt = Date.now();
  const run = dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  setTimeout(() => advanceAge(100), 30);
  const result = await run;
  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.equal(result.drop.recipient?.settled, true);
  assert.ok(Date.now() - startedAt < 1_000, "the server's age ended the wait, not the wall clock");
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 0 of 3/);
});

test("hand-over: the world age never moves -> the wall bound ends the wait unsettled", async () => {
  const { bot } = handOver();
  const startedAt = Date.now();
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 200 }), createDiscardedItems());
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, false);
  assert.ok(Date.now() - startedAt < 1_000, "the wait is bounded on the wall clock");
  assert.match(formatDropItemResult(result), /Tossed to \*\*Dev\*\*; the server has not said yet whether they took them \(0 of 3 seen taken\)/);
});

test("hand-over: no world age at the toss -> only the wall bound ends the wait, unsettled", async () => {
  const { bot } = handOver();
  (bot.time as { age?: number }).age = undefined;
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 150 }), createDiscardedItems());
  assert.equal(result.drop.recipient?.settled, false);
});

test("hand-over: a server that lags keeps the wait open until the pickup packet arrives (review B1)", async () => {
  const { bot, advanceAge } = handOver({ collects: { by: "recipient", afterMs: 500 } });
  let ended = false;
  const run = dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 3_000 }), createDiscardedItems()).finally(() => {
    ended = true;
  });
  // Time went by on the wall clock, but the server's age moved only one jump: nothing is settled.
  setTimeout(() => advanceAge(20), 100);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(ended, false, "still waiting for the server's answer");
  const result = await run;
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
});

test("hand-over: a partial pickup counts what the packet says, not the whole stack (review 6)", async () => {
  const { bot, advanceAge } = handOver({ carried: [{ name: "oak_log", count: 4, type: 1 }], spawnedCount: 4, collects: { by: "recipient", afterMs: 30, count: 2 } });
  const run = dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  setTimeout(() => advanceAge(100), 80);
  const result = await run;
  assert.equal(result.drop.recipient?.collectedCount, 2);
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, true);
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
});

test("hand-over: two partial pickups of one stack add up and end the wait as taken", async () => {
  const { bot } = handOver({
    carried: [{ name: "oak_log", count: 4, type: 1 }],
    spawnedCount: 4,
    collects: [{ by: "recipient", afterMs: 30, count: 2 }, { by: "recipient", afterMs: 60, count: 2 }],
  });
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  assert.equal(result.drop.recipient?.collectedCount, 4);
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
});

test("hand-over: another player takes it all -> not the recipient's, and the wait ends at once", async () => {
  const { bot } = handOver({ collects: { by: "other", afterMs: 30 } });
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, true);
});

test("hand-over: another player takes part of it -> the recipient took nothing, settled at 100 ticks", async () => {
  const { bot, advanceAge } = handOver({ carried: [{ name: "oak_log", count: 4, type: 1 }], spawnedCount: 4, collects: { by: "other", afterMs: 30, count: 1 } });
  const run = dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  setTimeout(() => advanceAge(100), 80);
  const result = await run;
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.equal(result.drop.recipient?.settled, true);
});

test("hand-over: the giver picking back what was not taken leaves 'took X of N' at the toss, not the net drop (review 2026-10-24, 3)", async () => {
  const { bot, advanceAge } = handOver({
    carried: [{ name: "oak_log", count: 4, type: 1 }],
    spawnedCount: 4,
    collects: [{ by: "recipient", afterMs: 30, count: 2 }, { by: "giver", afterMs: 60, count: 2 }],
  });
  const run = dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  setTimeout(() => advanceAge(100), 120);
  const result = await run;
  assert.equal(result.drop.dropped[0]?.dropped, 2, "the net drop counts what came back");
  assert.equal(result.drop.recipient?.tossedCount, 4);
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
});

test("hand-over lines: settled partial, unsettled and collected", () => {
  const at = { x: 0, y: 64, z: 0 };
  const recipient = { name: "Dev", distance: 1.5, position: at, collected: false, collectedCount: 2, tossedCount: 4, settled: true };
  assert.match(handOverLine(recipient, at), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
  assert.match(handOverLine({ ...recipient, settled: false }, at), /Tossed to \*\*Dev\*\*; the server has not said yet whether they took them \(2 of 4 seen taken\)/);
  assert.match(handOverLine({ ...recipient, collected: true, collectedCount: 4 }, at), /Handed to \*\*Dev\*\* from 1.5 blocks away/);
});

test("hand-over: the giver aims the toss at the recipient", async () => {
  const { bot, lookedAt } = handOver({ collects: { by: "recipient", afterMs: 10 } });
  await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 500 }), createDiscardedItems());
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
      handoverWallMs: 500,
      navigate: (async () => {
        routes += 1;
        return { status: "completed", elapsedMs: 5 };
      }) as never,
    }),
    createDiscardedItems(),
  );
  assert.ok(routes > 0, "the giver routed away from the toss (the recipient was already in reach, so no approach route)");
});

test("hand-over: abort during the wait removes the collect and time listeners", async () => {
  const { bot } = handOver();
  const controller = new AbortController();
  const run = dropItem(bot, handOverRequest, { signal: controller.signal }, deps({ handoverWallMs: 5_000 }), createDiscardedItems());
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(run);
  assert.equal((bot as unknown as { _client: EventEmitter })._client.listenerCount("collect"), 0);
  assert.equal(bot.listenerCount("time"), 0);
});

test("hand-over: a pickup announced while the giver walks away still counts", async () => {
  const { bot } = handOver({ collects: { by: "recipient", afterMs: 20 } });
  const result = await dropItem(
    bot,
    handOverRequest,
    {},
    deps({
      handoverWallMs: 1_000,
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

test("hand-over: a toss nobody took is no deliberate discard any more, so pick_up_items can take it back (F6, trade s1d)", async () => {
  const { bot } = handOver();
  const discarded = createDiscardedItems();
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 100 }), discarded);
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(discarded.ignored().size, 0);
});

test("hand-over: a toss the recipient took stays a remembered discard", async () => {
  const { bot } = handOver({ collects: { by: "recipient", afterMs: 40 } });
  const discarded = createDiscardedItems();
  const result = await dropItem(bot, handOverRequest, {}, deps({ handoverWallMs: 1_000 }), discarded);
  assert.equal(result.drop.recipient?.collected, true);
  assert.ok(discarded.ignored().size > 0);
});

