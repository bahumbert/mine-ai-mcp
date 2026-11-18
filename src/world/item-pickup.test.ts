import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import type { MovementPolicy, Navigate } from "../navigation/index.js";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { observation } from "../test-support/navigation.js";
import { watch } from "../test-support/pending.js";
import { armSignal } from "../utils/index.js";
import * as itemPickup from "./item-pickup.js";
import {
  DROPPED_ITEM_OBSERVATION_EVENTS,
  droppedItemName,
  findNewItemEntity,
  isItemEntity,
  pickupObservedItem,
  snapshotEntityIds,
} from "./item-pickup.js";

const DROP = new Vec3(3, 64, 0);

/**
 * A bot carrying `filledSlots` full stacks, with one observed white wool drop
 * as entity 7. A route can fill the last slot the way tunnel spoil does, with
 * the server's slot update. The clock is a mocked one a test installs when the
 * pickup waits on a timer.
 */
function pickupBot(filledSlots: number) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    carried: { cobblestone: 64 * filledSlots },
    entities: { 7: { name: "item", position: DROP } },
  });
  const { bot } = harness;
  bot.entities[7]!.getDroppedItem = () => itemOf(bot.registry, "white_wool");
  return harness;
}

const OBSERVED_ITEM = { entityId: 7, movements: {} as MovementPolicy, hasArrived: () => false } as const;

/**
 * Both readings of a full inventory are the same fact for the caller: a
 * capacity refusal names the item, rather than blaming the route or arrival.
 */
const capacityCases = [
  { name: "an inventory already full before any route starts", carried: 36, fillsDuringRoute: false },
  { name: "a route whose spoil takes the last slot", carried: 35, fillsDuringRoute: true },
] as const;

for (const { name, carried, fillsDuringRoute } of capacityCases) {
  test(`${name} reports capacity rather than walking or blaming arrival`, async () => {
    const { bot, inventory } = pickupBot(carried);
    // The window's own listener (the held item's) stays; the pickup's settle listener is the one that must go.
    const listenersBefore = bot.inventory.listenerCount("updateSlot");

    const result = await pickupObservedItem(bot, {
      ...OBSERVED_ITEM,
      navigate: async () => {
        if (!fillsDuringRoute) throw new Error("No pickup route should start without capacity.");
        inventory.updateSlot(inventory.firstEmptySlotRange(9, 45)!, itemOf(bot.registry, "cobblestone", 64));
        return { status: "completed", elapsedMs: 1 };
      },
    });

    assert.equal(result.kind, "inventory_full");
    if (result.kind === "inventory_full") assert.match(result.reason, /INVENTORY_FULL.*white_wool/);
    assert.equal(bot.inventory.listenerCount("updateSlot"), listenersBefore, "the settle listener is released");
  });
}

test("an item disappearing during a stopped route is gone, not an unreachable pickup", async () => {
  const { bot, clock } = pickupBot(0);
  using _timers = clock.install();
  const listenersBefore = bot.inventory.listenerCount("updateSlot");

  const result = await clock.settle(pickupObservedItem(bot, {
      ...OBSERVED_ITEM,
      navigate: async () => {
        delete bot.entities[7];
        return { status: "stopped", reason: "Entity 7 is not currently observed.", elapsedMs: 0 };
      },
      settleTicks: { itemGone: 1 },
    }), 2_100);

  assert.deepEqual(result, { kind: "item_gone", takenBy: null });
  assert.equal(bot.inventory.listenerCount("updateSlot"), listenersBefore);
});

/** Mob pickups follow contract check item-taken-by-mob; distant items cannot auto-pick up. */
function collectorPickupBot(count = 1, ticksPerSecond = 20, pickupDelayTicks = 0) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { startAge: 1_000, ticksPerSecond } });
  const drop = harness.entities.spawn({ name: "item", position: DROP, item: { name: "gold_ingot", count }, pickupDelayTicks });
  const mob = harness.entities.spawn({ name: "piglin", position: DROP });
  const options = {
    ...OBSERVED_ITEM,
    entityId: drop.id,
    hasArrived: () => harness.inventory.count(harness.bot.registry.itemsByName.gold_ingot!.id, null) > 0,
  };
  return { ...harness, drop, mob, options };
}

test("a drop another entity takes is gone with its collector, without the settle wait", async () => {
  const { bot, clock, entities, drop, mob, options } = collectorPickupBot();
  using _timers = clock.install();
  const events = ["playerCollect", "entityGone"] as const;
  const before = events.map((event) => bot.listenerCount(event));
  const result = await clock.settle(pickupObservedItem(bot, {
    ...options,
    navigate: async () => {
      entities.takenBy(mob, drop, 1);
      return { status: "stopped", reason: "item removed", elapsedMs: 0 };
    },
  }), 0);
  assert.deepEqual(result, { kind: "item_gone", takenBy: { entityId: mob.id, name: "piglin" } });
  assert.equal(clock.now(), 0);
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before);
});

test("a take during the arrival settle wakes it and leaves navigation its handoff", async () => {
  const { bot, clock, entities, drop, mob, options } = collectorPickupBot();
  using _timers = clock.install();
  let finishHandoff!: () => void;
  const handoff = new Promise<void>((resolve) => { finishHandoff = resolve; });
  let arrivalEndedAt: number | undefined;
  let returned = false;
  clock.after(100, () => entities.takenBy(mob, drop, 1));
  const pickup = pickupObservedItem(bot, {
    ...options,
    navigate: async ({ onArrival }) => {
      const arrival = await onArrival!({
        signal: new AbortController().signal,
        goalRevision: "pickup",
        node: { feet: { x: 3, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" },
        observation: observation(3, 64, 0),
      });
      assert.deepEqual(arrival, { kind: "completed" });
      arrivalEndedAt = clock.now();
      await handoff;
      return { status: "completed", elapsedMs: clock.now() };
    },
  }).then((result) => { returned = true; return result; });
  await clock.advance(100);
  assert.equal(arrivalEndedAt, 100);
  assert.equal(returned, false, "the route must finish its handoff before pickup returns");
  finishHandoff();
  assert.deepEqual(await clock.settle(pickup, 0), {
    kind: "item_gone", takenBy: { entityId: mob.id, name: "piglin" },
  });
  assert.equal(clock.now(), 100);
});

for (const cause of ["no collect", "own collect", "partial take then silent removal", "own collect after a partial take"] as const) {
  for (const slot of [false, true]) {
    test(`a drop gone with ${cause} ${slot ? "waits for a late slot" : "settles without a taker"}`, async () => {
      const { bot, clock, entities, inventory, drop, mob, options } = collectorPickupBot(2);
      using _timers = clock.install();
      const slotAt = cause === "own collect" ? 300 : 1_000;
      let returned = false;
      const pickup = pickupObservedItem(bot, {
        ...options,
        navigate: async () => {
          if (cause === "own collect" || cause === "own collect after a partial take") {
            if (cause === "own collect after a partial take") entities.takenBy(mob, drop, 1);
            // Stopgap: own collect without its slot update awaits a delayed-pickup contract check (review 2026-11-16).
            entities.takenBy(bot.entity, drop, cause === "own collect" ? 2 : 1);
          }
          else {
            if (cause === "partial take then silent removal") entities.takenBy(mob, drop, 1);
            entities.remove(drop.id);
          }
          if (slot) clock.after(slotAt, () => inventory.updateSlot(36, itemOf(bot.registry, "gold_ingot")));
          return { status: "stopped", reason: "item removed", elapsedMs: 0 };
        },
      }).then((result) => { returned = true; return result; });
      const beforeAnswer = slot ? slotAt - 1 : 3_050;
      await clock.advance(beforeAnswer);
      assert.equal(returned, false, "a collect or a disappearance is not an inventory gain");
      assert.deepEqual(await clock.settle(pickup, slot ? 51 : 1, 1), slot ? { kind: "collected" } : { kind: "item_gone", takenBy: null });
      assert.equal(clock.now(), slot ? slotAt + 50 : 3_051);
    });
  }
}

test("a partial take keeps the pursuit until the bot collects the remainder", async () => {
  const { bot, clock, entities, drop, mob, options } = collectorPickupBot(2);
  using _timers = clock.install();
  const pickup = pickupObservedItem(bot, {
    ...options,
    navigate: async () => {
      entities.takenBy(mob, drop, 1);
      await clock.sleep(100);
      bot.entity.position.set(drop.position.x, drop.position.y, drop.position.z);
      await clock.sleep(100);
      return { status: "completed", elapsedMs: 200 };
    },
  });
  assert.deepEqual(await clock.settle(pickup, 200), { kind: "collected" });
});

test("listeners are released after navigation failure and an abort mid-walk", async () => {
  for (const exit of ["throw", "abort"] as const) {
    const { bot, options } = collectorPickupBot();
    const events = ["playerCollect", "entityGone"] as const;
    const before = events.map((event) => bot.listenerCount(event));
    const controller = new AbortController();
    const pickup = pickupObservedItem(bot, {
      ...options,
      signal: controller.signal,
      navigate: async ({ signal }) => {
        if (exit === "throw") throw new Error("navigation failed");
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        return { status: "stopped", reason: "cancelled", elapsedMs: 0 };
      },
    });
    if (exit === "abort") controller.abort(new Error("cancelled"));
    await assert.rejects(pickup, exit === "throw" ? /navigation failed/ : /cancelled/);
    assert.deepEqual(events.map((event) => bot.listenerCount(event)), before, exit);
  }
});

test("a caller-owned watch remembers a take before pickup; a per-call watch has no history", async () => {
  for (const callerOwned of [true, false]) {
    const { bot, clock, entities, drop, mob, options } = collectorPickupBot();
    using _timers = clock.install();
    const lifetime = new AbortController();
    const collectors = callerOwned ? itemPickup.watchItemCollectors(bot, lifetime.signal) : undefined;
    entities.takenBy(mob, drop, 1);
    const pickup = pickupObservedItem(bot, {
      ...options, collectors,
      navigate: async () => { throw new Error("an absent item needs no route"); },
    });
    const result = await clock.settle(pickup, callerOwned ? 0 : 3_100);
    assert.deepEqual(result, {
      kind: "item_gone", takenBy: callerOwned ? { entityId: mob.id, name: "piglin" } : null,
    });
    if (collectors) assert.deepEqual(await collectors.whenTaken(drop.id), { entityId: mob.id, name: "piglin" });
    lifetime.abort();
  }
});

test("a caller-owned watch releases listeners on abort and copies an unread collector name as null", async () => {
  const { bot, entities, drop, mob } = collectorPickupBot();
  const events = ["playerCollect", "entityGone"] as const;
  const before = events.map((event) => bot.listenerCount(event));
  const lifetime = new AbortController();
  const collectors = itemPickup.watchItemCollectors(bot, lifetime.signal);
  const taken = collectors.whenTaken(drop.id);
  Object.assign(mob, { name: undefined });
  entities.takenBy(mob, drop, 1);
  assert.deepEqual(await taken, { entityId: mob.id, name: null });
  assert.deepEqual(collectors.takenBy(drop.id), { entityId: mob.id, name: null });
  lifetime.abort();
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before);
  const afterAbort = entities.spawn({ name: "item", position: DROP, item: { name: "gold_ingot", count: 1 } });
  entities.takenBy(mob, afterAbort, 1);
  assert.equal(collectors.takenBy(afterAbort.id), null);
  itemPickup.watchItemCollectors(bot, lifetime.signal);
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before, "an already-ended lifetime attaches nothing");
});

test("keeps observing until dropped-item metadata can identify the entity", async () => {
  const { bot } = createFakeBot({ entities: { 2: { name: "item", position: DROP } } });
  const entity = bot.entities[2]!;
  let itemName: string | null = null;
  entity.getDroppedItem = () => {
    if (!itemName) throw new Error("metadata not ready");
    return itemOf(bot.registry, itemName);
  };
  const sighting = armSignal(
    bot,
    [...DROPPED_ITEM_OBSERVATION_EVENTS],
    () =>
      findNewItemEntity(bot, {
        baseline: new Set(),
        itemName: "dirt",
        source: new Vec3(2, 64, 0),
        maxDistance: 4,
      }),
    {},
  );

  bot.emit("entitySpawn", entity);
  itemName = "dirt";
  bot.emit("entityUpdate", entity);

  assert.deepEqual(await sighting.promise, { kind: "signalled", value: { id: 2, position: DROP } });
});

test("attributes only a new matching item near the source, and unread metadata is no evidence yet", () => {
  const wool = (x: number) => ({ name: "item", position: new Vec3(x, 64, 0) });
  // The bot's own entity is 1: the drops are 2 (seen before the act), 3 (new, matching) and 4 (new, unread).
  const { bot } = createFakeBot({ entities: { 2: wool(1), 3: wool(3), 4: { name: "item", position: DROP } } });
  const [seen, matching, pending] = [2, 3, 4].map((id) => bot.entities[id]!);
  for (const drop of [seen!, matching!]) drop.getDroppedItem = () => itemOf(bot.registry, "white_wool");
  pending!.getDroppedItem = () => {
    throw new Error("metadata not ready");
  };

  assert.equal(droppedItemName(seen!), "white_wool");
  assert.equal(droppedItemName(pending!), null, "metadata that has not arrived is not a name");

  // The two new drops spawn after the snapshot.
  delete bot.entities[3];
  delete bot.entities[4];
  const baseline = snapshotEntityIds(bot);
  bot.entities[3] = matching!;
  bot.entities[4] = pending!;

  assert.deepEqual(
    findNewItemEntity(bot, { baseline, itemName: "white_wool", source: new Vec3(2, 64, 0), maxDistance: 4 }),
    { id: 3, position: DROP },
  );
});

test("an item entity is one even before its stack metadata arrives; a mob is not", () => {
  const { bot } = createFakeBot({
    entities: {
      2: { name: "item", position: DROP },
      3: { name: "item", position: DROP },
      4: { name: "zombie", position: DROP },
      5: { name: "arrow", position: DROP },
      6: { name: "item", position: DROP },
    },
  });
  const unreadable = () => {
    throw new Error("metadata not arrived");
  };
  bot.entities[2]!.getDroppedItem = unreadable;
  bot.entities[3]!.getDroppedItem = () => itemOf(bot.registry, "dirt");
  assert.equal(isItemEntity(bot.entities[2]!), true);
  assert.equal(isItemEntity(bot.entities[3]!), true);
  assert.equal(isItemEntity(bot.entities[4]!), false);
  assert.equal(isItemEntity(bot.entities[5]!), false);
  // An entity the server has told nothing about yet has no name.
  assert.equal(isItemEntity(Object.assign(bot.entities[6]!, { name: undefined })), false);
});

/** The route's arrival owns its signal; cancelling it must leave the attempt's inventory watcher alive. */
function pickupArrival(signal = new AbortController().signal) {
  return {
    signal, goalRevision: "pickup",
    node: { feet: { x: 3, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" },
    observation: observation(3, 64, 0),
  };
}

/** Reach the item without predicting its inventory gain; the fake server decides the pickup. */
function arriveAtItem(harness: ReturnType<typeof collectorPickupBot>): Navigate {
  return async ({ onArrival }) => {
    harness.bot.entity.position.set(3, 64, 0);
    assert.deepEqual(await onArrival!(pickupArrival()), { kind: "completed" });
    return { status: "completed", elapsedMs: harness.clock.now() };
  };
}

/** Every pickup exit releases its listeners and timers, including after the abandoned deadlines. */
function pickupCleanup(harness: ReturnType<typeof collectorPickupBot>) {
  const { bot, clock } = harness;
  const added = listenersAddedSince(bot);
  const inventoryAdded = listenersAddedSince(bot.inventory);
  return async (signal?: AbortSignal) => {
    for (const event of ["playerCollect", "entityGone"]) assert.equal(added(event), 0, event);
    assert.equal(inventoryAdded("updateSlot"), 0);
    if (signal) assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(10_000);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  };
}

for (const rate of [20, 10]) {
  test(`arrival keeps the watcher until a delayed server pickup at ${rate} tps`, async () => {
    const harness = collectorPickupBot(1, rate, rate === 10 ? 30 : 10);
    const { bot, clock, options, server } = harness;
    using _timers = clock.install();
    const clean = pickupCleanup(harness);
    const pending = pickupObservedItem(bot, { ...options, navigate: arriveAtItem(harness) });
    const state = watch(pending);
    const gainMs = rate === 10 ? 3_000 : 500;
    await clock.advance(gainMs - 1);
    assert.equal(state.over, false, "arrival must not retire the attempt before the server's gain");
    assert.equal(server.gameTime, rate === 10 ? 1_029 : 1_009);
    assert.deepEqual(await clock.settle(pending, 101, 1), { kind: "collected" });
    assert.equal(bot.time.age, rate === 10 ? 1_020 : 1_000);
    await clean();
  });

  for (const path of ["arrival", "gone", "stopped"] as const) {
    test(`${path} without a gain waits for the packet margin at ${rate} tps`, async () => {
      const harness = collectorPickupBot(path === "stopped" ? 2 : 1, rate, 32_767);
      const { bot, clock, entities, drop, mob, options } = harness;
      using _timers = clock.install();
      const clean = pickupCleanup(harness);
      if (path === "gone") entities.remove(drop.id);
      const route = { status: "stopped", reason: "no path", elapsedMs: 0 } as const;
      const pending = pickupObservedItem(bot, {
        ...options, navigate: path === "arrival" ? arriveAtItem(harness) : async () => {
          if (path === "stopped") entities.takenBy(mob, drop, 1);
          return route;
        },
      });
      const state = watch(pending);
      const packetMs = path === "gone" ? (rate === 10 ? 6_000 : 3_000) : (rate === 10 ? 4_000 : 2_000);
      const endAge = path === "gone" ? 1_060 : 1_040;
      await clock.advance(packetMs);
      assert.equal(bot.time.age, endAge, "started at cached age 1000; the packet follows this look");
      assert.equal(state.over, false);
      await clock.advance(50);
      assert.equal(state.over, false, "the first look takes the final zero-ms inventory read");
      const result = await clock.settle(pending, 1, 1);
      assert.equal(clock.now(), packetMs + 51);
      if (path === "stopped") assert.deepEqual(result, { kind: "not_collected", route });
      else assert.equal(result.kind, path === "gone" ? "item_gone" : "not_collected");
      await clean();
    });

    test(`${path} with a stopped server uses its wall backstop at ${rate} tps`, async () => {
      const harness = collectorPickupBot(1, rate, 32_767);
      const { bot, clock, entities, drop, options, server } = harness;
      using _timers = clock.install();
      const clean = pickupCleanup(harness);
      server.stop();
      if (path === "gone") entities.remove(drop.id);
      const pending = pickupObservedItem(bot, {
        ...options,
        navigate: path === "arrival" ? arriveAtItem(harness) : async () => ({ status: "stopped", reason: "no path", elapsedMs: 0 }),
      });
      const state = watch(pending);
      // serverPacedWallMs: 3 * (budget + packet margin 20) * 50; plus the final zero-ms read.
      const wallMs = path === "gone" ? 7_500 : 5_700;
      await clock.advance(wallMs - 1);
      assert.equal(state.over, false);
      const result = await clock.settle(pending, 51, 1);
      assert.equal(clock.now(), wallMs + 1);
      assert.equal(bot.time.age, 1_000);
      assert.equal(result.kind, path === "gone" ? "item_gone" : "not_collected");
      await clean();
    });
  }

  test(`a rolling item gets a fresh arrival settle and a later gain at ${rate} tps`, async () => {
    const harness = collectorPickupBot(1, rate, 60);
    const { bot, clock, options } = harness;
    using _timers = clock.install();
    const clean = pickupCleanup(harness);
    const arrivals: string[] = [];
    const pending = pickupObservedItem(bot, {
      ...options,
      navigate: async ({ onArrival }) => {
        bot.entity.position.set(3, 64, 0);
        clock.after(100, () => harness.drop.position.set(6, 64, 0));
        const first = await onArrival!(pickupArrival());
        arrivals.push(first.kind);
        assert.equal(first.kind, "continue", "the drop rolled beyond reach during settlement");
        bot.entity.position.set(6, 64, 0);
        arrivals.push((await onArrival!(pickupArrival())).kind);
        return { status: "completed", elapsedMs: clock.now() };
      },
    });
    const packetMs = rate === 10 ? 4_000 : 2_000;
    await clock.advance(packetMs);
    assert.deepEqual(arrivals, [], "the first arrival has not spent its server-tick window yet");
    assert.deepEqual(await clock.settle(pending, 2_200, 1), { kind: "collected" });
    assert.deepEqual(arrivals, ["continue", "completed"]);
    await clean();
  });

  for (const cancel of ["arrival", "outer"] as const) {
    test(`${cancel} abort ends the arrival settle immediately at ${rate} tps`, async () => {
      const harness = collectorPickupBot(1, rate, 32_767);
      const { bot, clock, options, entities } = harness;
      using _timers = clock.install();
      const clean = pickupCleanup(harness);
      const outer = new AbortController();
      const arrival = new AbortController();
      let arrivalEnds = 0;
      const pending = pickupObservedItem(bot, {
        ...options, signal: outer.signal,
        navigate: async ({ onArrival, signal }) => {
          try {
            await onArrival!(pickupArrival(arrival.signal));
          } finally {
            arrivalEnds++;
          }
          if (!signal!.aborted) {
            await new Promise<void>((resolve) => {
              const onSlot = () => { bot.inventory.off("updateSlot", onSlot); resolve(); };
              bot.inventory.on("updateSlot", onSlot);
            });
          }
          return { status: "completed", elapsedMs: clock.now() };
        },
      });
      const state = watch(pending);
      await clock.advance(100);
      (cancel === "outer" ? outer : arrival).abort(new Error("takeover"));
      if (cancel === "outer") await assert.rejects(clock.settle(pending, 0), /takeover/);
      else {
        await clock.advance(0);
        assert.equal(state.over, false, "arrival cancellation preserves the attempt-wide watcher");
        entities.spawn({ name: "item", position: bot.entity.position, item: { name: "gold_ingot", count: 1 }, pickupDelayTicks: 0 });
        assert.deepEqual(await clock.settle(pending, 200), { kind: "collected" });
      }
      assert.equal(arrivalEnds, 1);
      assert.equal(getEventListeners(arrival.signal, "abort").length, 0);
      await clean(outer.signal);
      assert.equal(arrivalEnds, 1);
    });
  }
}
