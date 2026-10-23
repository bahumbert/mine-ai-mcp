import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { recordContainerObservation, recordPlacedContainer } from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { parseUseContainerRequest } from "./contract.js";
import {
  beginUseContainer,
  formatUseContainerResult,
  useContainer,
  type UseContainerDependencies,
} from "./use-container.js";

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;

interface TestStack {
  slot: number;
  name: string;
  count: number;
  metadata?: number;
  nbt?: object | null;
}

interface TestContainer {
  readonly window: ContainerWindow;
  readonly state: {
    contents: TestStack[];
    cursor: TestStack | null;
    closed: boolean;
    moves: number;
  };
}

function testWindow(registry: Bot["registry"], contents: readonly TestStack[] | number): TestContainer {
  const initialContents =
    typeof contents === "number"
      ? contents === 0
        ? []
        : [{ slot: 0, name: "cobblestone", count: contents }]
      : contents;
  const state = {
    contents: initialContents.map((item) => ({ ...item })),
    cursor: null,
    closed: false,
    moves: 0,
  };
  const window = {
    inventoryStart: 27,
    containerItems: () =>
      state.contents
        .filter(({ slot }) => slot < 27)
        .map((item) => {
          const registryItem = registry.itemsByName[item.name]!;
          return { ...registryItem, type: registryItem.id, metadata: 0, nbt: null, ...item };
        }),
    items: () =>
      state.contents
        .filter(({ slot }) => slot >= 27)
        .map((item) => {
          const registryItem = registry.itemsByName[item.name]!;
          return { ...registryItem, type: registryItem.id, metadata: 0, nbt: null, ...item };
        }),
    get selectedItem() {
      return state.cursor;
    },
    deposit: async (itemType: number, _metadata: number | null, count: number) => {
      const itemName = registry.items[itemType]!.name;
      const existing = state.contents.find(({ name }) => name === itemName);
      if (existing) existing.count += count;
      else {
        const occupied = new Set(state.contents.map(({ slot }) => slot));
        const slot = Array.from({ length: 27 }, (_, index) => index).find((index) => !occupied.has(index));
        if (slot === undefined) throw new Error("container is full");
        state.contents.push({ slot, name: itemName, count });
      }
    },
    withdraw: async (itemType: number, _metadata: number | null, count: number) => {
      const itemName = registry.items[itemType]!.name;
      let remaining = count;
      for (const stack of state.contents.filter(({ name }) => name === itemName)) {
        const removed = Math.min(stack.count, remaining);
        stack.count -= removed;
        remaining -= removed;
        if (remaining === 0) break;
      }
      state.contents = state.contents.filter(({ count: stackCount }) => stackCount > 0);
    },
    firstEmptyContainerSlot: () => {
      const occupied = new Set(state.contents.map(({ slot }) => slot));
      return Array.from({ length: 27 }, (_, index) => index).find((index) => !occupied.has(index)) ?? null;
    },
    firstEmptyInventorySlot: () => (state.contents.some(({ slot }) => slot === 27) ? null : 27),
    close: () => {
      state.closed = true;
    },
  } as unknown as ContainerWindow;
  return { window, state };
}

/** The bot beside a container block at 1,64,1 opening the scripted window (stopgap until the master adds container windows: `chest.js`). */
function testBot(
  blockName: string,
  contents: readonly TestStack[] | number,
  carried: Readonly<Record<string, number>> = { cobblestone: 10 },
) {
  const harness = createFakeBot({ username: "StorageBot", position: new Vec3(0, 64, 0), cells: { "1,64,1": blockName }, carried });
  const { bot } = harness;
  const container = testWindow(bot.registry, contents);
  const { state } = container;
  const sameItemKind = (left: TestStack, right: TestStack) =>
    left.name === right.name &&
    (left.metadata ?? 0) === (right.metadata ?? 0) &&
    JSON.stringify(left.nbt ?? null) === JSON.stringify(right.nbt ?? null);
  bot.openContainer = async () => container.window;
  bot.clickWindow = async (slot: number) => {
    const slotIndex = state.contents.findIndex((item) => item.slot === slot);
    const slotItem = slotIndex === -1 ? null : state.contents[slotIndex]!;
    if (!state.cursor) {
      if (!slotItem) return;
      state.contents.splice(slotIndex, 1);
      state.cursor = { ...slotItem };
      return;
    }

    if (!slotItem) {
      state.contents.push({ ...state.cursor, slot });
      state.cursor = null;
    } else if (sameItemKind(slotItem, state.cursor)) {
      const stackSize = bot.registry.itemsByName[slotItem.name]!.stackSize;
      const moved = Math.min(stackSize - slotItem.count, state.cursor.count);
      slotItem.count += moved;
      state.cursor.count -= moved;
      if (state.cursor.count === 0) state.cursor = null;
    } else {
      state.contents[slotIndex] = { ...state.cursor, slot };
      state.cursor = { ...slotItem };
    }
    state.moves += 1;
  };
  return { harness, container };
}

const testDependencies = {
  navigate: async () => ({ status: "completed", elapsedMs: 0 }),
  createMovements: () => ({}),
  now: () => new Date("2026-08-24T00:00:00.000Z"),
} as unknown as UseContainerDependencies;

/** One container, one bot and one disposable store, with the call the subject is asked to make. */
function scene(
  t: TestContext,
  {
    block = "chest",
    contents = 0,
    carried,
  }: { block?: string; contents?: readonly TestStack[] | number; carried?: Readonly<Record<string, number>> } = {},
) {
  const data = temporaryBotData({ closeAfter: t });
  const { harness, container } = testBot(block, contents, carried);
  const { bot, inventory } = harness;
  const use = (
    request: Parameters<typeof useContainer>[2],
    options: Parameters<typeof useContainer>[3] = {},
    dependencies: UseContainerDependencies = testDependencies,
  ) => useContainer(bot, data, request, options, dependencies);
  const carriedOf = (name: string) => inventory.count(bot.registry.itemsByName[name]!.id, null);
  /** Change what the bot carries of `name` by `delta`, as the server redraws the slots (`setCarriedCount`). */
  const addCarried = (name: string, delta: number) => setCarriedCount(inventory, bot.registry, bot.registry.itemsByName[name]!.id, carriedOf(name) + delta);
  return { data, container, bot, use, carried: carriedOf, addCarried };
}

test("parses bulk transfers and item ordering into an exhaustive domain union", () => {
  assert.deepEqual(parseUseContainerRequest({ x: 1, y: 64, z: 2 }), {
    operation: "inspect",
    x: 1,
    y: 64,
    z: 2,
  });
  assert.deepEqual(
    parseUseContainerRequest({
      operation: "deposit",
      x: 1,
      y: 64,
      z: 2,
      items: [
        { item_name: "Cobblestone", count: 2 },
        { item_name: "cobblestone", count: 3 },
      ],
    }),
    { operation: "deposit", x: 1, y: 64, z: 2, items: [{ itemName: "cobblestone", count: 5 }] },
  );
  assert.deepEqual(
    parseUseContainerRequest({
      operation: "organize",
      x: 1,
      y: 64,
      z: 2,
      item_order: ["Oak Log", "Cobblestone"],
    }),
    { operation: "organize", x: 1, y: 64, z: 2, itemOrder: ["oak_log", "cobblestone"] },
  );
  assert.throws(() => parseUseContainerRequest({ operation: "withdraw", x: 1, y: 64, z: 2 }), /requires items/);
  assert.throws(
    () =>
      parseUseContainerRequest({
        operation: "deposit",
        x: 1,
        y: 64,
        z: 2,
        item_name: "cobblestone",
        count: 1,
      }),
    /Unrecognized keys/,
  );
  assert.throws(
    () =>
      parseUseContainerRequest({
        operation: "organize",
        x: 1,
        y: 64,
        z: 2,
        item_order: ["cobblestone", "Cobblestone"],
      }),
    /requires each item once/,
  );
});

test("inspect records the complete slot layout and closes the window", async (t) => {
  const { data, container, use } = scene(t, {
    contents: [
      { slot: 2, name: "cobblestone", count: 12 },
      { slot: 8, name: "oak_log", count: 3 },
    ],
  });
  const result = await use({ operation: "inspect", x: 1, y: 64, z: 1 });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.container.contents, [
    { slot: 2, item: "cobblestone", count: 12 },
    { slot: 8, item: "oak_log", count: 3 },
  ]);
  assert.equal(container.state.closed, true);
  assert.deepEqual(data.read("SELECT slot, item_name, item_count FROM observed_container_slots ORDER BY slot"), [
    { slot: 2, item_name: "cobblestone", item_count: 12 },
    { slot: 8, item_name: "oak_log", item_count: 3 },
  ]);
  assert.match(formatUseContainerResult(result), /\[2\] cobblestone x12/);
});

test("cancellation propagates from navigation, and from observation with the opened window closed", async (t) => {
  const observing = scene(t);
  const observeStop = new AbortController();
  await assert.rejects(
    observing.use(
      { operation: "inspect", x: 1, y: 64, z: 1 },
      { signal: observeStop.signal },
      {
        ...testDependencies,
        now: () => {
          observeStop.abort(new Error("observation cancelled"));
          return new Date("2026-08-24T00:00:00.000Z");
        },
      },
    ),
    /observation cancelled/,
  );
  assert.equal(observing.container.state.closed, true, "an opened container must not be left open");

  const routing = scene(t);
  const routeStop = new AbortController();
  await assert.rejects(
    routing.use(
      { operation: "inspect", x: 10, y: 64, z: 0 },
      { signal: routeStop.signal },
      {
        ...testDependencies,
        navigate: async () => {
          routeStop.abort(new Error("action cancelled"));
          throw routeStop.signal.reason;
        },
      },
    ),
    /action cancelled/,
  );
});

test("a stop before the container is opened is reported as what was actually observed", async (t) => {
  const stopped = await scene(t).use(
    { operation: "inspect", x: 10, y: 64, z: 0 },
    {},
    {
      ...testDependencies,
      navigate: async () => ({ status: "stopped", reason: "no path", elapsedMs: 12 }),
    },
  );
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error, /stopped after 12 ms: no path/);

  const locked = scene(t);
  locked.bot.openContainer = async () => {
    throw new Error("container is locked");
  };
  const refused = await locked.use({ operation: "inspect", x: 1, y: 64, z: 1 });
  assert.equal(refused.status, "failed");
  assert.match(refused.error, /CONTAINER_OPEN_FAILED.*container is locked/);
});

const depositRows = [
  {
    name: "every requested item is carried",
    carried: { cobblestone: 3, oak_log: 2 },
    contents: [{ slot: 0, name: "cobblestone", count: 5 }] as TestStack[],
    status: "succeeded",
    transfers: [
      { status: "succeeded", item: "cobblestone", requested: 3, transferred: 3 },
      { status: "succeeded", item: "oak_log", requested: 2, transferred: 2 },
    ],
    stored: [
      { item_name: "cobblestone", item_count: 8 },
      { item_name: "oak_log", item_count: 2 },
    ],
  },
  {
    name: "only part of one requested item is carried",
    carried: { cobblestone: 2 },
    contents: [] as TestStack[],
    status: "partial",
    transfers: [
      { status: "partial", item: "cobblestone", requested: 3, transferred: 2 },
      { status: "failed", item: "oak_log", requested: 2, transferred: 0 },
    ],
    stored: [{ item_name: "cobblestone", item_count: 2 }],
  },
] as const;

test("bulk deposit reports the transfer observed for each requested item", async (t) => {
  for (const row of depositRows) {
    const { data, use } = scene(t, { block: "barrel", contents: row.contents, carried: row.carried });
    const result = await use({
      operation: "deposit",
      x: 1,
      y: 64,
      z: 1,
      items: [
        { itemName: "cobblestone", count: 3 },
        { itemName: "oak_log", count: 2 },
      ],
    });

    assert.equal(result.status, row.status, row.name);
    if (result.container.operation !== "deposit") assert.fail(`${row.name}: expected deposit evidence`);
    assert.deepEqual(
      result.container.transfers.map(({ status, item, requested, transferred }) => ({
        status,
        item,
        requested,
        transferred,
      })),
      row.transfers,
      row.name,
    );
    assert.deepEqual(
      data.read("SELECT item_name, item_count FROM observed_container_items ORDER BY item_name"),
      row.stored,
      row.name,
    );
  }
});

test("settles an observed partial deposit after the transfer promise rejects", async (t) => {
  const { data, container, use } = scene(t, { block: "barrel", contents: 5 });
  container.window.deposit = async (_itemType: number, _metadata: number | null, _count: number) => {
    container.state.contents[0]!.count += 2;
    throw new Error("connection closed");
  };
  const result = await use({ operation: "deposit", x: 1, y: 64, z: 1, items: [{ itemName: "cobblestone", count: 3 }] });

  assert.equal(result.status, "partial");
  if (result.container.operation !== "deposit") assert.fail("expected deposit evidence");
  assert.equal(result.container.transfers[0]?.transferred, 2);
  const transfer = result.container.transfers[0];
  if (!transfer || transfer.status === "succeeded") assert.fail("expected an incomplete transfer");
  assert.match(transfer.error, /CONTAINER_TRANSFER_FAILED.*connection closed/);
  assert.equal(data.read("SELECT item_count FROM observed_container_items")[0]?.item_count, 7);
});

test("bulk withdrawal compacts what remains and reports missing requested items", async (t) => {
  const { data, use } = scene(t, {
    contents: [
      { slot: 0, name: "cobblestone", count: 64 },
      { slot: 4, name: "cobblestone", count: 6 },
      { slot: 5, name: "oak_log", count: 60 },
      { slot: 8, name: "oak_log", count: 10 },
    ],
  });
  const result = await use({
    operation: "withdraw",
    x: 1,
    y: 64,
    z: 1,
    items: [
      { itemName: "cobblestone", count: 2 },
      { itemName: "dirt", count: 1 },
    ],
  });

  assert.equal(result.status, "partial");
  if (result.container.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.deepEqual(
    result.container.transfers.map(({ status, item, transferred }) => ({ status, item, transferred })),
    [
      { status: "succeeded", item: "cobblestone", transferred: 2 },
      { status: "failed", item: "dirt", transferred: 0 },
    ],
  );
  assert.deepEqual(result.container.contents, [
    { slot: 0, item: "cobblestone", count: 64 },
    { slot: 4, item: "cobblestone", count: 4 },
    { slot: 5, item: "oak_log", count: 64 },
    { slot: 8, item: "oak_log", count: 6 },
  ]);
  assert.equal(
    data.read("SELECT item_count FROM observed_container_items WHERE item_name = 'cobblestone'")[0]?.item_count,
    68,
  );
});

const organizeRows = [
  {
    name: "fragmented stacks compact into the requested item order",
    contents: [
      { slot: 0, name: "cobblestone", count: 40 },
      { slot: 3, name: "oak_log", count: 2 },
      { slot: 8, name: "cobblestone", count: 30 },
    ] as TestStack[],
    itemOrder: ["oak_log", "cobblestone"],
    matchedSlots: 3,
    organized: [
      { slot: 0, item: "oak_log", count: 2 },
      { slot: 1, item: "cobblestone", count: 64 },
      { slot: 2, item: "cobblestone", count: 6 },
    ],
  },
  {
    name: "fragments of one item pack into a single full stack",
    contents: [
      { slot: 0, name: "cobblestone", count: 12 },
      { slot: 3, name: "cobblestone", count: 5 },
      { slot: 8, name: "cobblestone", count: 47 },
    ] as TestStack[],
    itemOrder: ["cobblestone"],
    matchedSlots: 1,
    organized: [{ slot: 0, item: "cobblestone", count: 64 }],
  },
  {
    // Two stacks share one item name but the server will never merge them.
    name: "incompatible variants of one item stay in separate stacks",
    contents: [
      { slot: 3, name: "cobblestone", count: 5, nbt: { value: { custom: "first" } } },
      { slot: 8, name: "cobblestone", count: 7, nbt: { value: { custom: "second" } } },
    ] as TestStack[],
    itemOrder: ["cobblestone"],
    matchedSlots: 2,
    organized: [
      { slot: 0, item: "cobblestone", count: 5 },
      { slot: 1, item: "cobblestone", count: 7 },
    ],
  },
  {
    name: "an empty order organizes an empty container",
    contents: [] as TestStack[],
    itemOrder: [],
    matchedSlots: 0,
    organized: [],
  },
] as const;

test("organize lays the container out as planned, preserving every stack it moved", async (t) => {
  for (const row of organizeRows) {
    const result = await scene(t, { contents: row.contents }).use({
      operation: "organize",
      x: 1,
      y: 64,
      z: 1,
      itemOrder: [...row.itemOrder],
    });

    assert.equal(result.status, "succeeded", row.name);
    if (result.container.operation !== "organize") assert.fail(`${row.name}: expected organize evidence`);
    assert.deepEqual(result.container.contents, row.organized, row.name);
    // Planned stacks observed in place afterwards, not slots the plan touched.
    assert.equal(result.container.matchedSlots, row.matchedSlots, row.name);
    assert.deepEqual(result.container.plannedContents, result.container.contents, row.name);
    assert.equal(result.container.contentsPreserved, true, row.name);
    assert.equal(result.container.playerInventoryPreserved, true, row.name);
    assert.equal(result.container.cursorEmpty, true, row.name);
  }
});

test("organize rejects an order that does not name the observed items exactly once", async (t) => {
  const { container, use } = scene(t, { contents: [{ slot: 0, name: "cobblestone", count: 4 }] });
  const result = await use({ operation: "organize", x: 1, y: 64, z: 1, itemOrder: ["oak_log"] });

  assert.equal(result.status, "failed");
  assert.match(result.error, /CONTAINER_ITEM_ORDER_MISMATCH/);
  assert.equal(container.state.moves, 0);
});

test("a loaded non-container removes stale memory for that exact location", async (t) => {
  const { data, use } = scene(t, { block: "stone" });
  recordContainerObservation(data, {
    dimension: "overworld",
    x: 1,
    y: 64,
    z: 1,
    blockName: "chest",
    slotCount: 27,
    contents: [{ slot: 0, item: "cobblestone", count: 4 }],
    observedByBotId: "StorageBot",
    observedAt: "2026-08-24T00:00:00.000Z",
  });
  const result = await use({ operation: "inspect", x: 1, y: 64, z: 1 });

  assert.equal(result.status, "failed");
  assert.match(result.error, /CONTAINER_NOT_PRESENT/);
  assert.equal(data.read("SELECT COUNT(*) AS count FROM observed_containers")[0]?.count, 0);
});

test("a chest the bot placed and found gone is forgotten as a placed container too", async (t) => {
  const { data, use } = scene(t, { block: "stone" });
  recordPlacedContainer(data, { username: "Builder", game: { dimension: "overworld" } }, { name: "chest", position: { x: 1, y: 64, z: 1 } });
  recordPlacedContainer(data, { username: "Builder", game: { dimension: "overworld" } }, { name: "chest", position: { x: 5, y: 64, z: 5 } });

  const result = await use({ operation: "inspect", x: 1, y: 64, z: 1 });

  assert.equal(result.status, "failed");
  assert.deepEqual(data.read("SELECT container_key FROM placed_containers"), [{ container_key: "overworld|5|64|5" }]);
});

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function containerAttempts(
  scenery: ReturnType<typeof scene>,
  request: Parameters<typeof useContainer>[2],
  dependencies: UseContainerDependencies = testDependencies,
) {
  const run = beginUseContainer(scenery.bot, scenery.data, request, undefined, dependencies);
  return (signal?: AbortSignal) => run({ signal });
}

/**
 * Makes the window's transfer behave as the server does: the carried count moves with the container, and the
 * first call stops after `takes` items (a reflex took the body) by aborting `owner` and failing; with no `stopping` every call completes.
 */
function transferOnServer(
  scenery: ReturnType<typeof scene>,
  operation: "deposit" | "withdraw",
  owner: AbortController,
  stopping: { readonly takes: number } | null,
): number[] {
  const asked: number[] = [];
  const original = scenery.container.window[operation].bind(scenery.container.window);
  scenery.container.window[operation] = (async (itemType: number, metadata: number | null, count: number) => {
    asked.push(count);
    const item = scenery.bot.registry.items[itemType]!.name;
    const stops = stopping !== null && asked.length === 1;
    const moving = stops ? Math.min(count, stopping.takes) : count;
    await original(itemType, metadata, moving);
    scenery.addCarried(item, operation === "withdraw" ? moving : -moving);
    if (stops) {
      owner.abort(new Error("hunger reflex"));
      throw new Error("window closed under the transfer");
    }
  }) as never;
  return asked;
}

const CHEST = { x: 1, y: 64, z: 1 } as const;

test("a withdrawal of three stacks cut off after the first asks only for the other two", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [0, 1, 2].map((slot) => ({ slot, name: "cobblestone", count: 64 })), carried });
  const owner = new AbortController();
  const asked = transferOnServer(scenery, "withdraw", owner, { takes: 64 });
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 192 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.deepEqual(asked, [192, 128]);
  assert.equal(scenery.carried("cobblestone"), 192);
  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 192);
  assert.equal(scenery.container.state.closed, true);
});

test("a deposit cut off mid-transfer moves only the rest next time", async (t) => {
  const carried = { cobblestone: 40 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  const asked = transferOnServer(scenery, "deposit", owner, { takes: 10 });
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "cobblestone", count: 30 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.deepEqual(asked, [30, 20]);
  assert.equal(scenery.carried("cobblestone"), 10);
  assert.equal(result.status, "succeeded");
});

test("a chest another bot emptied between attempts gives what it had left, as a partial", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [0, 1, 2].map((slot) => ({ slot, name: "cobblestone", count: 64 })), carried });
  const owner = new AbortController();
  transferOnServer(scenery, "withdraw", owner, { takes: 64 });
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 192 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.container.state.contents = [];
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "partial");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 64);
  assert.equal(scenery.carried("cobblestone"), 64);
});

test("a second call after a completed withdrawal returns the success without moving anything", async (t) => {
  const carried = { cobblestone: 0 };
  const scenery = scene(t, { contents: [{ slot: 0, name: "cobblestone", count: 64 }], carried });
  const asked = transferOnServer(scenery, "withdraw", new AbortController(), null);
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "cobblestone", count: 64 }] });

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.deepEqual(asked, [64]);
  assert.equal(scenery.carried("cobblestone"), 64);
  if (second.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(second.container.transfers[0]?.transferred, 64);
});

test("a deposit resumed after the hunger reflex ate some of the same food still puts the full count in the chest", async (t) => {
  const carried = { bread: 20 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  transferOnServer(scenery, "deposit", owner, { takes: 3 });
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "bread", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.addCarried("bread", -2); // the reflex ate two between the attempts: the inventory fell, the chest did not
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "deposit") assert.fail("expected deposit evidence");
  assert.equal(result.container.transfers[0]?.transferred, 10);
  assert.equal(scenery.container.state.contents.find(({ name }) => name === "bread")?.count, 10);
  assert.equal(scenery.carried("bread"), 8);
});

test("a withdrawal resumed after planks were picked up from the ground still takes the full count from the chest", async (t) => {
  const carried = { oak_planks: 0 };
  const scenery = scene(t, { contents: [{ slot: 0, name: "oak_planks", count: 20 }], carried });
  const owner = new AbortController();
  transferOnServer(scenery, "withdraw", owner, { takes: 3 });
  const attempt = containerAttempts(scenery, { operation: "withdraw", ...CHEST, items: [{ itemName: "oak_planks", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.addCarried("oak_planks", 4); // picked up during the rescue: the inventory rose, the chest did not
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  if (result.container?.operation !== "withdraw") assert.fail("expected withdraw evidence");
  assert.equal(result.container.transfers[0]?.transferred, 10);
  assert.equal(scenery.container.state.contents.find(({ name }) => name === "oak_planks")?.count, 10);
  assert.equal(scenery.carried("oak_planks"), 14);
});

test("a resumed deposit while another bot also puts items in the chest credits no more than the inventory lost", async (t) => {
  const carried = { bread: 20 };
  const scenery = scene(t, { block: "barrel", contents: 0, carried });
  const owner = new AbortController();
  const asked = transferOnServer(scenery, "deposit", owner, { takes: 3 });
  const attempt = containerAttempts(scenery, { operation: "deposit", ...CHEST, items: [{ itemName: "bread", count: 10 }] });

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  scenery.container.state.contents.push({ slot: 5, name: "bread", count: 5 }); // another bot's own deposit
  await attempt(new AbortController().signal);

  assert.deepEqual(asked, [10, 7]);
});
