import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forgetContainerObservation, recordContainerObservation, recordPlacedContainer } from "./container-observations.js";
import { SqlBotData } from "./sql-bot-data.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { captureStderr } from "../test-support/stderr.js";

/** One complete look inside a container, as the observing bot reports it. */
const seen = (
  contents: readonly { slot: number; item: string; count: number }[],
  observedAt: string,
  blockName = "chest",
) => ({ blockName, slotCount: 27, contents, observedByBotId: "StorageBot", observedAt });

test("atomically replaces a complete container snapshot and exposes item rows", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const location = { dimension: "overworld", x: 4, y: 64, z: -2 };

  recordContainerObservation(data, {
    ...location,
    ...seen(
      [
        { slot: 0, item: "cobblestone", count: 12 },
        { slot: 8, item: "oak_log", count: 3 },
      ],
      "2026-08-24T00:00:00.000Z",
    ),
  });
  recordContainerObservation(data, {
    ...location,
    ...seen(
      [
        { slot: 2, item: "oak_log", count: 1 },
        { slot: 9, item: "oak_log", count: 2 },
      ],
      "2026-08-24T00:01:00.000Z",
    ),
  });

  assert.deepEqual(data.read("SELECT item_name, item_count, observed_at FROM observed_container_items"), [
    { item_name: "oak_log", item_count: 3, observed_at: "2026-08-24T00:01:00.000Z" },
  ]);
  assert.deepEqual(data.read("SELECT slot, item_name, item_count FROM observed_container_slots ORDER BY slot"), [
    { slot: 2, item_name: "oak_log", item_count: 1 },
    { slot: 9, item_name: "oak_log", item_count: 2 },
  ]);
  assert.deepEqual(data.read("SELECT contents_json FROM observed_containers"), [
    { contents_json: '[{"slot":2,"item":"oak_log","count":1},{"slot":9,"item":"oak_log","count":2}]' },
  ]);
});

test("represents an observed empty container and forgets a disproven location", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const location = { dimension: "overworld", x: 1, y: 2, z: 3 };
  const containers = () => data.read("SELECT COUNT(*) AS count FROM observed_containers")[0]?.count;

  recordContainerObservation(data, { ...location, ...seen([], "2026-08-24T00:00:00.000Z", "barrel") });

  assert.equal(containers(), 1);
  assert.equal(data.read("SELECT COUNT(*) AS count FROM observed_container_items")[0]?.count, 0);
  forgetContainerObservation(data, location);
  assert.equal(containers(), 0);
});

test("retains legacy item totals without inventing their unknown slots", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  data.transaction((database) => {
    database
      .prepare(
        `
        INSERT INTO observed_containers (
          container_key, dimension, block_x, block_y, block_z, block_name,
          slot_count, contents_json, observed_by_bot_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        "overworld|7|64|9",
        "overworld",
        7,
        64,
        9,
        "chest",
        27,
        '[{"item":"cobblestone","count":12}]',
        "StorageBot",
        "2026-08-23T00:00:00.000Z",
      );
  });

  assert.deepEqual(data.read("SELECT item_name, item_count FROM observed_container_items"), [
    { item_name: "cobblestone", item_count: 12 },
  ]);
  assert.deepEqual(data.read("SELECT slot, item_name, item_count FROM observed_container_slots"), []);
});

/** The bot that places a block and the block it reads back at the target, as the placers hand them over. */
const placer = (username = "Builder", dimension = "overworld") => ({ username, game: { dimension } });
const placedBlock = (name: string, x = 4, y = 64, z = -2) => ({ name, position: { x, y, z } });
const placedRows = (data: ReturnType<typeof temporaryBotData>) =>
  data.read(
    "SELECT container_key, dimension, block_x, block_y, block_z, block_name, placed_by_bot_id, placed_at FROM placed_containers",
  );

test("a chest the bot placed is recorded with its dimension, position, maker and time", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  recordPlacedContainer(data, placer(), placedBlock("chest"), "2026-10-20T00:00:00.000Z");

  assert.deepEqual(placedRows(data), [
    {
      container_key: "overworld|4|64|-2",
      dimension: "overworld",
      block_x: 4,
      block_y: 64,
      block_z: -2,
      block_name: "chest",
      placed_by_bot_id: "Builder",
      placed_at: "2026-10-20T00:00:00.000Z",
    },
  ]);
});

test("a placed block that is no container records nothing", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  recordPlacedContainer(data, placer(), placedBlock("dirt"));
  recordPlacedContainer(data, placer(), placedBlock("crafting_table"));

  assert.deepEqual(placedRows(data), []);
});

test("every location-owned container kind is recorded, a shulker box of any colour included", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const kinds = ["chest", "trapped_chest", "barrel", "hopper", "dropper", "dispenser", "red_shulker_box"];

  kinds.forEach((kind, index) => recordPlacedContainer(data, placer(), placedBlock(kind, index)));

  assert.deepEqual(
    placedRows(data).map((row) => row.block_name),
    kinds,
  );
});

test("placing a chest again where one was recorded keeps one row, with the new maker", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  recordPlacedContainer(data, placer("First"), placedBlock("chest"), "2026-10-20T00:00:00.000Z");
  recordPlacedContainer(data, placer("Second"), placedBlock("barrel"), "2026-10-20T00:05:00.000Z");

  assert.deepEqual(
    placedRows(data).map((row) => [row.block_name, row.placed_by_bot_id, row.placed_at]),
    [["barrel", "Second", "2026-10-20T00:05:00.000Z"]],
  );
});

test("the same coordinates in two dimensions are two placed containers", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  recordPlacedContainer(data, placer("Builder", "overworld"), placedBlock("chest"));
  recordPlacedContainer(data, placer("Builder", "the_nether"), placedBlock("chest"));

  assert.deepEqual(
    placedRows(data).map((row) => row.container_key),
    ["overworld|4|64|-2", "the_nether|4|64|-2"],
  );
});

test("a container seen gone forgets both its observation and its placed row", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const location = { dimension: "overworld", x: 4, y: 64, z: -2 };
  recordPlacedContainer(data, placer(), placedBlock("chest"));
  recordContainerObservation(data, { ...location, ...seen([], "2026-10-20T00:00:00.000Z") });
  recordPlacedContainer(data, placer(), placedBlock("chest", 9, 64, 9));

  forgetContainerObservation(data, location);

  assert.deepEqual(
    placedRows(data).map((row) => row.container_key),
    ["overworld|9|64|9"],
  );
  assert.equal(data.read("SELECT COUNT(*) AS count FROM observed_containers")[0]?.count, 0);
});

test("a database file made before the table existed gets it on the next start", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "mine-ai-placed-containers-"));
  const options = {
    storage: { kind: "persistent" as const, root },
    identity: { worldId: "placed-containers-upgrade", scope: { kind: "shared" as const } },
  };
  let data = SqlBotData.create(options);
  t.after(() => {
    data.close();
    rmSync(root, { recursive: true, force: true });
  });
  data.transaction((database) => {
    database.prepare("DROP TABLE placed_containers").run();
  });
  data.close();

  data = SqlBotData.create(options);
  recordPlacedContainer(data, placer(), placedBlock("chest"));

  assert.equal(placedRows(data).length, 1);
});

test("the data dictionary tells a model that placed_containers is only what the bot itself placed", (t) => {
  const data = temporaryBotData({ closeAfter: t });

  const rows = data.read(
    "SELECT description FROM data_dictionary WHERE table_name = 'placed_containers' AND column_name IS NULL",
  );

  assert.equal(rows.length, 1);
  assert.match(String(rows[0]?.description), /placed/u);
});

test("a store that refuses the write loses the record and never throws into the placement", (t) => {
  const lines = captureStderr(t);
  const data = temporaryBotData();
  data.close();

  assert.doesNotThrow(() => recordPlacedContainer(data, placer(), placedBlock("chest")));

  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[placed-containers\] /u);
});
