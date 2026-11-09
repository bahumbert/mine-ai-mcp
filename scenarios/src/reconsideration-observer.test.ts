import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot, createFakeClock } from "../../src/test-support/fake-bot/index.ts";
import { observeReconsideration } from "../default/nether/reconsideration-observer.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import type { Runtime } from "./runtime.ts";

function fixture() {
  const { bot } = createFakeBot({ entities: {
    2: { name: "enderman", position: { x: 0, y: 64, z: 0 } },
    3: { name: "enderman", position: { x: 4, y: 64, z: 0 } },
  }, overrides: { chat: () => {} } });
  let selected = 2;
  const runtime = { status: () => ({ survival: { request: { evidence: { checkpoint: { selectedTargetId: selected } } } } }) } as unknown as Runtime;
  const context = { bot, log: () => {} } as unknown as MineAiScenarioContext;
  const child = new AbortController();
  const observer = observeReconsideration(context, runtime, { primary: 2, alternative: 3 }, { mode: "failed_approach", teleportTo: [10, 64, 0], returnTo: [1, 64, 0] }, child);
  return { bot, child, observer, select: (id: number) => { selected = id; } };
}

// Mineflayer entities.js:354-375 emits entityMoved after applying the server position;
// entities.js:398-400 defines damage_event source ids. These emissions stand in for those packets.
test("proof requires server-observed moves and a hit, and death remains observable until cleanup", () => {
  const { bot, child, observer, select } = fixture();
  bot.emit("physicsTick");
  assert.equal(observer.snapshot().primaryMoved, false);
  bot._client.emit("damage_event", { entityId: 2, sourceCauseId: bot.entity.id + 1, sourceDirectId: 0 });
  assert.equal(child.signal.aborted, false);
  bot.entities[2]!.position.set(10, 64, 0);
  bot.emit("entityMoved", bot.entities[2]);
  select(3);
  bot.emit("physicsTick");
  bot.entities[2]!.position.set(1, 64, 0);
  bot.emit("entityMoved", bot.entities[2]);
  assert.equal(child.signal.aborted, true);
  bot.emit("death");
  assert.equal(observer.snapshot().deaths, 1);
  observer.close();
  bot.emit("death");
  assert.equal(observer.snapshot().deaths, 1);
  assert.equal(bot._client.listenerCount("damage_event"), 0);
});

test("an unobserved move fails after 100 physics ticks and releases observers", async () => {
  const { bot, observer } = fixture();
  const rejection = assert.rejects(observer.failure, /arranged move not observed/);
  bot.emit("physicsTick");
  for (let tick = 0; tick < 100; tick++) bot.emit("physicsTick");
  await rejection;
  observer.close();
  assert.equal(bot.listenerCount("entityMoved"), 0);
  assert.equal(bot._client.listenerCount("damage_event"), 0);
});

test("a move observed after its monotonic deadline is rejected even before its timer runs", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, observer } = fixture();
  const failure = assert.rejects(observer.failure, /arranged move not observed/);
  bot.emit("physicsTick");
  const now = performance.now;
  performance.now = () => clock.now() + 5_001;
  try {
    bot.entities[2]!.position.set(10, 64, 0);
    bot.emit("entityMoved", bot.entities[2]);
    assert.equal(observer.snapshot().primaryMoved, false);
    await failure;
  } finally {
    performance.now = now;
    observer.close();
  }
});
