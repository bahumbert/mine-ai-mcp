import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, type FakeServerOptions } from "../../test-support/fake-bot/index.js";
import { watch as watchPending } from "../../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { changeCovers, type ServerBlockChange, subscribeServerBlockChanges, watchServerChange } from "./server-block-changes.js";

/** A 1.21.4 bot on the shared fake, subscribed to the server's block packets: its protocol client carries them. */
function wire(server: FakeServerOptions = {}) {
  const harness = createFakeBot({ server });
  const client = harness.bot._client;
  const changes: ServerBlockChange[] = [];
  const unsubscribe = subscribeServerBlockChanges(harness.bot, (change) => changes.push(change));
  return { ...harness, client, changes, unsubscribe };
}

/** One record of a 1.21.4 `multi_block_change`: block state, then the cell inside its 16-cube section. */
function record(stateId: number, cellX: number, cellY: number, cellZ: number): number {
  return (stateId << 12) | (cellX << 8) | (cellZ << 4) | cellY;
}

test("mineflayer's own air write is not a server change", () => {
  const { world, changes } = wire();
  // The fork's finished dig sets the cell to air in its own world and emits `blockUpdate`; the server has said nothing.
  world.setCell(new Vec3(3, 63, 4), "air");
  assert.deepEqual(changes, []);
});

test("a block_change packet is a server change of its cell", () => {
  const { client, changes } = wire();
  client.emit("block_change", { location: { x: 3, y: 63, z: 4 }, type: 1 });
  assert.equal(changes.length, 1);
  assert.ok(changeCovers(changes[0]!, { x: 3, y: 63, z: 4 }));
  assert.ok(!changeCovers(changes[0]!, { x: 3, y: 62, z: 4 }), "only the cell the packet names");
});

test("a multi_block_change covering the cell is a server change of that cell, and only of the cells it lists", () => {
  const { client, changes } = wire();
  // Section (0, 3, 0) is y 48..63: cell (3, 15, 4) inside it is the world cell (3, 63, 4).
  client.emit("multi_block_change", { chunkCoordinates: { x: 0, y: 3, z: 0 }, records: [record(1, 3, 15, 4), record(0, 5, 15, 4)] });
  assert.ok(changes.some((change) => changeCovers(change, { x: 3, y: 63, z: 4 })));
  assert.ok(changes.some((change) => changeCovers(change, { x: 5, y: 63, z: 4 })));
  assert.ok(!changes.some((change) => changeCovers(change, { x: 4, y: 63, z: 4 })), "a cell the packet does not list");
});

test("a resent chunk answers every cell of its column and no other column", () => {
  const { client, changes } = wire();
  client.emit("map_chunk", { x: -1, z: 2 });
  assert.equal(changes.length, 1);
  assert.ok(changeCovers(changes[0]!, { x: -16, y: 5, z: 32 }));
  assert.ok(changeCovers(changes[0]!, { x: -1, y: 120, z: 47 }));
  assert.ok(!changeCovers(changes[0]!, { x: 0, y: 5, z: 32 }), "the next column east");
});

test("the unsubscribe removes every listener it added, once or twice", () => {
  const { client, unsubscribe } = wire();
  const names = ["block_change", "multi_block_change", "map_chunk"];
  assert.ok(names.every((name) => client.listenerCount(name) === 1));
  unsubscribe();
  unsubscribe();
  assert.ok(names.every((name) => client.listenerCount(name) === 0));
});

const CELL = { x: 3, y: 63, z: 4 };

for (const ticksPerSecond of [2, 4]) {
  test(`a server at ${ticksPerSecond} tps answers after 9 s`, async () => {
    const { bot, client, clock } = wire({ ticksPerSecond });
    const watch = watchServerChange(bot, CELL);
    clock.after(9_000, () => client.emit("block_change", { location: CELL, type: 0 }));
    try {
      assert.equal(await clock.settle(watch.answer(new AbortController().signal, clock), 9_000), true);
      assert.equal(clock.now(), 9_000);
    } finally {
      watch.dispose();
    }
  });
}

test("a 2 tps server behind schedule answers after two packets 10 500 ms apart", async () => {
  const { bot, client, clock, server } = wire({ ticksPerSecond: 2 });
  const watch = watchServerChange(bot, CELL);
  const packets: number[] = [];
  const unsubscribe = server.onTimePacket(() => {
    packets.push(clock.now());
    if (packets.length === 2) client.emit("block_change", { location: CELL, type: 0 });
  });
  server.stop();
  clock.after(500, () => server.resume());
  clock.after(10_550, () => server.stop());
  clock.after(11_000, () => server.resume());
  try {
    assert.equal(await clock.settle(watch.answer(new AbortController().signal, clock), 21_050), true);
    assert.deepEqual(packets, [10_500, 21_000]);
  } finally {
    unsubscribe();
    watch.dispose();
  }
});

for (const { ticksPerSecond, boundMs } of [{ ticksPerSecond: 20, boundMs: 2_000 }, { ticksPerSecond: 10, boundMs: 4_000 }, { ticksPerSecond: 2, boundMs: 20_000 }]) {
  test(`40 ticks with no answer at ${ticksPerSecond} tps gives up at the second jump, ignoring another cell`, async () => {
    const { bot, client, clock } = wire({ ticksPerSecond });
    const watch = watchServerChange(bot, CELL);
    client.emit("block_change", { location: { ...CELL, x: 9 }, type: 0 });
    const started = bot.time.age;
    const answer = watch.answer(new AbortController().signal, clock);
    const over = watchPending(answer);
    try {
      await clock.advance(boundMs - 25);
      assert.equal(over.over, false);
      assert.equal(await clock.settle(answer, 25), false);
      assert.equal(clock.now(), boundMs);
      assert.equal(bot.time.age - started, 40);
    } finally {
      watch.dispose();
    }
  });
}

test("a stopped clock gives up after 20 s, not before", async () => {
  const { bot, clock, server } = wire();
  const watch = watchServerChange(bot, CELL);
  server.stop();
  const started = bot.time.age;
  const answer = watch.answer(new AbortController().signal, clock);
  const over = watchPending(answer);
  await clock.advance(SERVER_CLOCK_STOPPED_MS - 25);
  assert.equal(over.over, false, "still waiting inside the wall bound");
  assert.equal(await clock.settle(answer, 25), false);
  assert.equal(clock.now(), 20_000);
  assert.equal(bot.time.age, started, "the server clock never moved");
  watch.dispose();
});

test("disposing a watch removes its listeners", () => {
  const { bot, client } = wire();
  const before = client.listenerCount("block_change");
  const watch = watchServerChange(bot, CELL);
  assert.equal(client.listenerCount("block_change"), before + 1);
  watch.dispose();
  watch.dispose();
  assert.equal(client.listenerCount("block_change"), before);
});

test("next skips unbroken states, retains packet state despite client writes, and keeps a later landing", async () => {
  const { bot, world, client, clock } = wire();
  const cell = new Vec3(CELL.x, CELL.y, CELL.z);
  world.setCell(cell, "sand");
  const sand = world.blockAt(cell)!.stateId;
  const watch = watchServerChange(bot, CELL);
  const packet = (state: string) => {
    world.setCell(cell, state);
    client.emit("block_change", { location: CELL, type: world.blockAt(cell)?.stateId ?? 0 });
  };
  packet("sand");
  assert.equal(await watch.answer(new AbortController().signal, clock), true, "an unbroken resend answers resync even before a wait");
  world.setCell(cell, "air"); // Mineflayer's prediction cannot revise the kept packet.
  const removal = watch.next(new AbortController().signal, -1, state => state.stateId !== null && state.stateId !== sand, clock);
  const pending = watchPending(removal);
  await clock.advance(100);
  assert.equal(pending.over, false);
  packet("air");
  packet("sand"); // both packets before the next poll
  const removed = await clock.settle(removal, 50);
  assert.notEqual(removed, "none");
  assert.notEqual(removed, "stalled");
  if (typeof removed === "string") assert.fail(removed);
  assert.equal(removed.index, 1);
  assert.equal(removed.state.stateId, 0);
  const landed = await watch.next(new AbortController().signal, removed.index, state => state.solid, clock);
  assert.equal(typeof landed === "object" && landed.index, 2);
  assert.equal(typeof landed === "object" && landed.state.stateId, sand);
  assert.equal(await watch.answer(new AbortController().signal, clock), true);
  watch.dispose();
});
