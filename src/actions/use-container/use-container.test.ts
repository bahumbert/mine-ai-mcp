import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { recordContainerObservation, recordPlacedContainer } from "../../bot-data/index.js";
import { type ContainerStack, stackText } from "../../test-support/fake-bot/index.js";
import { CELL, scene } from "../../test-support/use-container-scene.js";
import { parseUseContainerRequest } from "./contract.js";
import { formatUseContainerResult } from "./use-container.js";

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
  assert.equal(container.closed, true);
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
        ...observing.dependencies,
        now: () => {
          observeStop.abort(new Error("observation cancelled"));
          return new Date("2026-08-24T00:00:00.000Z");
        },
      },
    ),
    /observation cancelled/,
  );
  assert.equal(observing.container.closed, true, "an opened container must not be left open");

  const routing = scene(t);
  const routeStop = new AbortController();
  await assert.rejects(
    routing.use(
      { operation: "inspect", x: 10, y: 64, z: 0 },
      { signal: routeStop.signal },
      {
        ...routing.dependencies,
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
  const stopping = scene(t);
  const stopped = await stopping.use(
    { operation: "inspect", x: 10, y: 64, z: 0 },
    {},
    {
      ...stopping.dependencies,
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
    contents: [{ slot: 0, name: "cobblestone", count: 5 }],
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
    contents: [],
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

test("settles an observed partial deposit after the transfer fails mid-way", async (t) => {
  // A barrel full but for room for 2 more cobblestone: the third item has nowhere to go.
  const full = [...Array.from({ length: 26 }, (_, slot): ContainerStack => ({ slot, name: "dirt", count: 64 })), { slot: 26, name: "cobblestone", count: 62 }];
  const { data, use, carried } = scene(t, { block: "barrel", contents: full, carried: { cobblestone: 10 } });
  const result = await use({ operation: "deposit", x: 1, y: 64, z: 1, items: [{ itemName: "cobblestone", count: 3 }] });

  assert.equal(result.status, "partial");
  if (result.container.operation !== "deposit") assert.fail("expected deposit evidence");
  assert.equal(result.container.transfers[0]?.transferred, 2);
  const transfer = result.container.transfers[0];
  if (!transfer || transfer.status === "succeeded") assert.fail("expected an incomplete transfer");
  assert.match(transfer.error, /CONTAINER_TRANSFER_FAILED.*destination full/);
  assert.equal(data.read("SELECT item_count FROM observed_container_items WHERE item_name = 'cobblestone'")[0]?.item_count, 64);
  assert.equal(carried("cobblestone"), 8, "the third item went back to the inventory");
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
  // Mineflayer's transfer on a server (contract `chest-open-take-close`): it picks the first stack up, puts the 2 down and puts the rest back, merging into the other stack, so the 4 left over sit in the first slot.
  assert.deepEqual(result.container.contents, [
    { slot: 0, item: "cobblestone", count: 4 },
    { slot: 4, item: "cobblestone", count: 64 },
    { slot: 5, item: "oak_log", count: 64 },
    { slot: 8, item: "oak_log", count: 6 },
  ]);
  assert.equal(
    data.read("SELECT item_count FROM observed_container_items WHERE item_name = 'cobblestone'")[0]?.item_count,
    68,
  );
});

/** The stacks the bot carries as these rows read them, by name: `oak_log x3`, a renamed one with its custom name. */
function inventoryStacks(bot: Bot): string[] {
  return bot.inventory.items().map((item) => stackText(item)!);
}

test("a deposit does not merge into a renamed stack of the same item: the plain stack goes to an empty slot and the renamed one keeps its 5", async (t) => {
  const { container, use, carried } = scene(t, { contents: [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }], carried: { cobblestone: 10 } });
  const result = await use({ operation: "deposit", x: 1, y: 64, z: 1, items: [{ itemName: "cobblestone", count: 10 }] });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(container.contents, [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "cobblestone", count: 10 }]);
  assert.equal(carried("cobblestone"), 0);
});

test("a withdrawal by name takes the plain stacks first, then the renamed one, as separate stacks in the inventory", async (t) => {
  const { container, bot, use } = scene(t, { contents: [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "cobblestone", count: 4 }], carried: {} });
  const result = await use({ operation: "withdraw", x: 1, y: 64, z: 1, items: [{ itemName: "cobblestone", count: 6 }] });

  assert.equal(result.status, "succeeded");
  assert.deepEqual(inventoryStacks(bot).sort(), ['cobblestone x2 "first"', "cobblestone x4"]);
  assert.deepEqual(container.contents, [{ slot: 0, name: "renamed_first_cobblestone", count: 3 }]);
});

test("a transfer that ends with another player's stack in hand: the close gives it to the inventory, and the next deposit of that item completes", async (t) => {
  const filler = Array.from({ length: 26 }, (_, slot): ContainerStack => ({ slot: slot + 1, name: "dirt", count: 64 }));
  const scenery = scene(t, { contents: [{ slot: 0, name: "cobblestone", count: 10 }, ...filler], carried: {} });
  let received = 0;
  // The chest is full, and another player puts an oak log stack on slot 0 as soon as our stack was picked up: the 2 left over cannot go back there.
  scenery.harness.windows.onClickReceived(() => {
    if (++received === 1) scenery.harness.server.answer(() => scenery.harness.windows.setContainerStacks(CELL, [{ slot: 0, name: "oak_log", count: 3 }, ...filler]));
  });
  const first = await scenery.use({ operation: "withdraw", x: 1, y: 64, z: 1, items: [{ itemName: "cobblestone", count: 8 }] });

  assert.equal(first.status, "succeeded", "the 8 moved whatever the hand was left holding");
  assert.equal(scenery.carried("cobblestone"), 8);
  assert.equal(scenery.carried("oak_log"), 3, "the stack in hand went to the inventory when the window closed");
  scenery.container.contents = scenery.container.contents.filter(({ slot }) => slot !== 5); // another player makes room
  const second = await scenery.use({ operation: "deposit", x: 1, y: 64, z: 1, items: [{ itemName: "oak_log", count: 3 }] });

  assert.equal(second.status, "succeeded");
  assert.equal(scenery.carried("oak_log"), 0);
  assert.equal(scenery.container.contents.find(({ name }) => name === "oak_log")?.count, 3);
});

const organizeRows = [
  {
    name: "fragmented stacks compact into the requested item order",
    contents: [
      { slot: 0, name: "cobblestone", count: 40 },
      { slot: 3, name: "oak_log", count: 2 },
      { slot: 8, name: "cobblestone", count: 30 },
    ],
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
    ],
    itemOrder: ["cobblestone"],
    matchedSlots: 1,
    organized: [{ slot: 0, item: "cobblestone", count: 64 }],
  },
  {
    // Stacks of one item the server will never merge: a custom name, an enchantment, nothing.
    name: "incompatible variants of one item stay in separate stacks",
    contents: [
      { slot: 3, name: "renamed_first_cobblestone", count: 5 },
      { slot: 8, name: "renamed_second_cobblestone", count: 7 },
      { slot: 10, name: "cobblestone", count: 4 },
      { slot: 12, name: "enchanted_cobblestone", count: 3 },
    ],
    itemOrder: ["cobblestone"],
    matchedSlots: 4,
    organized: [
      { slot: 0, item: "cobblestone", count: 5 },
      { slot: 1, item: "cobblestone", count: 7 },
      { slot: 2, item: "cobblestone", count: 4 },
      { slot: 3, item: "cobblestone", count: 3 },
    ],
    server: [
      { slot: 0, name: "renamed_first_cobblestone", count: 5 },
      { slot: 1, name: "renamed_second_cobblestone", count: 7 },
      { slot: 2, name: "cobblestone", count: 4 },
      { slot: 3, name: "enchanted_cobblestone", count: 3 },
    ],
  },
  {
    // The planks go first, onto the renamed stack's slot; the renamed stack then wants the plain one's slot, which the client would predict as a merge.
    name: "a stack moves onto the slot of another variant of its item through a buffer slot, never a click onto it",
    contents: [
      { slot: 0, name: "renamed_first_cobblestone", count: 5 },
      { slot: 1, name: "cobblestone", count: 4 },
      { slot: 2, name: "oak_planks", count: 3 },
    ],
    itemOrder: ["oak_planks", "cobblestone"],
    matchedSlots: 3,
    organized: [
      { slot: 0, item: "oak_planks", count: 3 },
      { slot: 1, item: "cobblestone", count: 5 },
      { slot: 2, item: "cobblestone", count: 4 },
    ],
    server: [
      { slot: 0, name: "oak_planks", count: 3 },
      { slot: 1, name: "renamed_first_cobblestone", count: 5 },
      { slot: 2, name: "cobblestone", count: 4 },
    ],
  },
  {
    name: "an empty order organizes an empty container",
    contents: [],
    itemOrder: [],
    matchedSlots: 0,
    organized: [],
  },
] as const;

test("organize lays the container out as planned, preserving every stack it moved", async (t) => {
  for (const row of organizeRows) {
    const scenery = scene(t, { contents: row.contents });
    const result = await scenery.use({
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
    // The server's own chest, where a variant has its name: a merge the server refused would show here.
    if ("server" in row) assert.deepEqual(scenery.container.contents, row.server, `${row.name}: the server's layout`);
  }
});

test("organize rejects an order that does not name the observed items exactly once", async (t) => {
  const { container, use } = scene(t, { contents: [{ slot: 0, name: "cobblestone", count: 4 }] });
  const result = await use({ operation: "organize", x: 1, y: 64, z: 1, itemOrder: ["oak_log"] });

  assert.equal(result.status, "failed");
  assert.match(result.error, /CONTAINER_ITEM_ORDER_MISMATCH/);
  assert.equal(container.moves, 0);
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
