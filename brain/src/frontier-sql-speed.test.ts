// The brain's five frontier queries (bot-data-sql.ts) over a bot file with 31 355 seen chunks, built from the runtime's own
// SQL files (the world file attached read-only, the TEMP views over both), as runtime-client.test.ts builds its schema.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exploredChunksSql, nearestLandSql, seenAtSql, seenPlacesSql, waterShareSql } from "./bot-data-sql.ts";

const CHUNKS = 31_355;
const DIMENSION = "overworld";
const FROM = { x: 1600, y: 64, z: 1200 };

test("the brain's five frontier queries stay under 50 ms over 31 355 seen chunks", () => {
  const sql = (name: string) => readFileSync(new URL(`../../src/bot-data/${name}`, import.meta.url), "utf8");
  const directory = mkdtempSync(path.join(tmpdir(), "brain-speed-"));
  const worldFile = path.join(directory, "world-data.sqlite");
  const world = new DatabaseSync(worldFile);
  const database = new DatabaseSync(":memory:");
  try {
    world.exec(sql("world-data.sql"));
    database.exec(sql("bot-data.sql"));
    const keyAt = (i: number) => `${DIMENSION}|${i % 200}|${Math.floor(i / 200)}`;
    world.exec("BEGIN");
    const chunk = world.prepare("INSERT INTO frontier_chunks VALUES (?, ?, ?, ?, 't', 't', ?)");
    const material = world.prepare("INSERT INTO frontier_chunk_materials VALUES (?, 'oak_log')");
    const seen = database.prepare("INSERT INTO frontier_seen VALUES ('Ayla', ?, ?, ?, ?, 't')");
    database.exec("BEGIN");
    for (let i = 0; i < CHUNKS; i += 1) {
      chunk.run(keyAt(i), DIMENSION, i % 200, Math.floor(i / 200), (i % 10) / 10);
      if (i % 7 === 0) material.run(keyAt(i));
      seen.run(keyAt(i), DIMENSION, i % 200, Math.floor(i / 200));
    }
    world.exec("COMMIT");
    database.exec("COMMIT");
    world.close();
    database.prepare("ATTACH DATABASE ? AS world").run(`file:${worldFile}?mode=ro`);
    database.exec(sql("frontier-views.sql"));

    const chunks = [[100, 75], [101, 75], [100, 76]] as const;
    const queries: ReadonlyArray<readonly [string, string | null]> = [
      ["seenAtSql", seenAtSql("oak_log", FROM, 32, DIMENSION)],
      ["seenPlacesSql", seenPlacesSql("oak_log", FROM, 32, 5, DIMENSION)],
      ["waterShareSql", waterShareSql(chunks, DIMENSION)],
      ["exploredChunksSql", exploredChunksSql(chunks, DIMENSION)],
      ["nearestLandSql", nearestLandSql(FROM, DIMENSION)],
    ];
    const times: string[] = [];
    const slow: string[] = [];
    for (const [name, text] of queries) {
      assert.ok(text !== null, `${name} built no SQL`);
      // The query's own cost: CPU time of this process (best of five), not wall time, which on a loaded machine counts the
      // slices other processes took (8 CPU burners made the wall time 3 x as long, review 2026-11-19).
      let ms = Infinity;
      for (let run = 0; run < 5; run += 1) {
        const began = process.cpuUsage();
        database.prepare(text).all();
        const used = process.cpuUsage(began);
        ms = Math.min(ms, (used.user + used.system) / 1000);
      }
      times.push(`${name} ${ms.toFixed(1)} ms`);
      if (ms >= 50) slow.push(`${name} ${ms.toFixed(1)} ms`);
    }
    console.log(`[speed] ${times.join("; ")}`);
    assert.deepEqual(slow, []);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
