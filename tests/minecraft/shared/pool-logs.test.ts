// What the pool logs when it starts and stops a server, and the count of servers started.
import test from "node:test";
import assert from "node:assert/strict";
import { FakeFactory } from "./fake-servers.ts";
import { ServerPool } from "./pool.ts";
import { config, spec, end, setup, readyShared } from "./pool-fixtures.ts";

test("a server start logs its reason: a new key, a full key, the retired server it replaces, a probe, an own server", async () => {
  const lines: string[] = [];
  const pool = new ServerPool(new FakeFactory(), config, message => lines.push(message));
  const first = pool.startServer(spec(), 0);
  await first.ready;
  const second = pool.startServer(spec(), 0);
  await second.ready;
  pool.markSick(first.id);
  pool.startServer(spec(), 0);
  pool.startServer(spec({ key: "probe:1.21.4" }), 0);
  pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0, "own, not reusable");
  const starts = lines.filter(line => line.includes(" starting: "));
  assert.deepEqual(starts.map(line => /starting: (.*)$/u.exec(line)?.[1]), [
    "new key", "key's servers refused it (arrangement queue, tick time or size)", `replaces retired ${first.id}`, "probe", "own, not reusable",
  ]);
  assert.match(starts[0]!, /server s1 \(shared, key k1\) starting/u);
});

test("a server stop logs its reason: idle, retired, sick, own after trial", async () => {
  const lines: string[] = [];
  const pool = new ServerPool(new FakeFactory(), config, message => lines.push(message));
  const idle = await readyShared(pool, { key: "idle" });
  const retired = await readyShared(pool, { key: "retired" });
  const sick = await readyShared(pool, { key: "sick" });
  const single = pool.startServer(spec({ kind: "single", key: "own:a", heapMb: 2_048, setup: [] }), 0);
  await single.ready;
  pool.finishTrial(sick.id, pool.leaseLane(sick.id)!, end({ serverSick: true, lane: "held" }), 0);
  pool.noteSingleTrialStarted(single.id);
  pool.finishTrial(single.id, null, end(), 0, { reusable: false });
  const batch = pool.startServer(spec({ key: "k#batch5", reservedFor: 5 }), 0);
  await batch.ready;
  pool.releaseReservation(5);
  await pool.reap(config.serverIdleMs + 1, new Set(["retired"]));
  const reasons = Object.fromEntries(lines.flatMap(line => { const match = /server (s\d+) stopping: (.*)$/u.exec(line); return match ? [[match[1], match[2]]] : []; }));
  assert.deepEqual(reasons, { [idle.id]: "idle", [sick.id]: "sick", [single.id]: "own after trial", [batch.id]: "retired" });
  assert.notEqual(pool.get(retired.id), undefined, "its key is still queued: it stays");
});

test("the number of servers started is counted for the sample line", async () => {
  const { pool } = setup();
  assert.equal(pool.startedCount, 0);
  await readyShared(pool);
  await readyShared(pool, { key: "k2" });
  assert.equal(pool.startedCount, 2);
});

test("a server's start and ready lines carry its whole key, so a setting at its end (a tick rate) can be read in the log", async () => {
  const lines: string[] = [];
  const pool = new ServerPool(new FakeFactory(), config, message => lines.push(message));
  const key = `own:{"version":"1.21.4","type":"flat","seed":null,"structures":false,"generatorSettings":"x"}|{"tickRate":8}`;
  const own = pool.startServer(spec({ kind: "single", key, heapMb: 2_048, setup: [] }), 0);
  await own.ready;
  assert.ok(key.length > 60);
  assert.ok(lines.some(line => line.includes(`(single, key ${key}) starting: `)), lines.join("\n"));
  assert.ok(lines.some(line => line.includes(`(single, key ${key}) ready on port `)), lines.join("\n"));
});
