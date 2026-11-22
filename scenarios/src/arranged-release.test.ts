/** Arranged mobs require server removal/release answers and release ambiguity needs a full server window. */
import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { watch } from "../../src/test-support/pending.ts";
import { changesObserved, releaseByTag, removeArrangedEntities, waitForReleaseAnswers } from "./arranged-release.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

const targets = [{ tag: "primary", id: 2 }, { tag: "alternative", id: 3 }];

/** Packet ages follow world-age-per-second; flags follow scenario-fixture-pitfalls.md's W3 NoAI measurement.
 * Movement/removal events mirror Mineflayer entities.js:313,330 after server packets. */
function fixture(rate = 20, signal = new AbortController().signal, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { startAge: 1_000, ticksPerSecond: rate, timePacketYet }, entities: {
    2: { name: "enderman", position: { x: 0, y: 64, z: 0 } },
    3: { name: "enderman", position: { x: 2, y: 64, z: 0 } },
  }, overrides: { chat: () => {} } });
  const { bot, server } = harness;
  const added = listenersAddedSince(bot);
  const clientAdded = listenersAddedSince(bot._client);
  const logs: string[] = [];
  const commands: string[] = [];
  bot.chat = (command) => { commands.push(command); };
  const context = { bot, signal, log: (message: string) => { logs.push(message); } } as unknown as MineAiScenarioContext;
  const answer = (id: number, flags = 0) => bot._client.emit("entity_metadata", { entityId: id, metadata: [{ key: 15, value: flags }] });
  const gone = harness.entities.remove;
  return { context, bot, server, clock, answer, gone, logs, commands, async assertClean() {
    for (const event of ["entityGone", "entityMoved", "messagestr", "physicsTick", "time"]) assert.equal(added(event), 0, event);
    assert.equal(clientAdded("entity_metadata"), 0);
    assert.equal(getEventListeners(signal, "abort").length, 0);
    assert.equal(clock.pendingTimers(), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
    await clock.advance(100_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } };
}

for (const rate of [20, 10]) {
  test(`removal accepts both server answers at +60 ticks at ${rate} tps`, async () => {
    const { context, bot, clock, gone, assertClean } = fixture(rate);
    using _timers = clock.install();
    const result = removeArrangedEntities(context, targets);
    const state = watch(result);
    bot.emit("entityGone", bot.entity);
    await clock.advance(60_000 / rate);
    assert.equal(bot.time.age, 1_060);
    gone(2);
    await clock.advance(50);
    assert.equal(state.over, false);
    gone(3);
    await assert.doesNotReject(clock.settle(result, 50));
    await assertClean();
  });

  test(`removal without an answer fails only after the +120 packet at ${rate} tps`, async () => {
    const { context, bot, clock, assertClean } = fixture(rate);
    using _timers = clock.install();
    const result = removeArrangedEntities(context, targets);
    const state = watch(result);
    await clock.advance(120_000 / rate);
    assert.equal(bot.time.age, 1_120);
    assert.equal(state.over, false, "the packet follows the deadline look");
    await clock.advance(50);
    await assert.rejects(result, (error: Error) => {
      assert.match(error.message, /arranged Endermen not removed/);
      assert.match(error.message, /"end":"ticks"/);
      assert.match(error.message, /"elapsedTicks":120/);
      assert.ok(error.message.includes(`"elapsedMs":${120_000 / rate + 50}`));
      return true;
    });
    await assertClean();
  });

  test(`release answers at +30 ticks finish at ${rate} tps`, async () => {
    const { context, bot, clock, answer, assertClean } = fixture(rate);
    using _timers = clock.install();
    const result = waitForReleaseAnswers(context, new Set([2, 3]), "/release");
    const state = watch(result);
    await clock.advance(30_000 / rate);
    assert.equal(bot.time.age, 1_020);
    answer(2, 1);
    answer(99);
    answer(2);
    await clock.advance(50);
    assert.equal(state.over, false);
    answer(3);
    await assert.doesNotReject(clock.settle(result, 50));
    await assertClean();
  });

  for (const offset of [0, 500]) {
    test(`tag release keeps its full window and ignores late answers at ${rate} tps, offset ${offset}`, async () => {
      const { context, bot, clock, answer, assertClean } = fixture(rate);
      using _timers = clock.install();
      await clock.advance(offset);
      const result = releaseByTag(context, "primary", "enderman");
      const state = watch(result);
      await clock.advance(10_000 / rate - offset);
      answer(3, 1);
      answer(99);
      answer(2);
      await clock.advance(30_000 / rate);
      assert.equal(bot.time.age, 1_040);
      assert.equal(state.over, false, "one answer cannot close the ambiguity window");
      await clock.advance(20_000 / rate);
      assert.equal(bot.time.age, 1_060);
      assert.equal(state.over, false);
      await clock.advance(50);
      assert.equal(await clock.settle(result, 0), 2);
      answer(3);
      await assertClean();
    });
  }

  test(`tag release catches a second answer at +50 ticks at ${rate} tps`, async () => {
    const { context, clock, answer, assertClean } = fixture(rate);
    using _timers = clock.install();
    const result = releaseByTag(context, "primary", "enderman");
    watch(result);
    await clock.advance(10_000 / rate);
    answer(2);
    await clock.advance(40_000 / rate);
    answer(3);
    await assert.rejects(clock.settle(result, 50), /ambiguous release/);
    await assertClean();
  });

  for (const row of [
    { name: "release answers missing fail after the +60 packet", run: (context: MineAiScenarioContext) => waitForReleaseAnswers(context, new Set([2]), "/release"), logExpected: true },
    { name: "tag release without an answer fails at the completed window", run: (context: MineAiScenarioContext) => releaseByTag(context, "primary", "enderman"), logExpected: false },
  ]) {
    test(`${row.name} at ${rate} tps`, async () => {
      const { context, bot, clock, logs, assertClean } = fixture(rate);
      using _timers = clock.install();
      const result: Promise<unknown> = row.run(context);
      const state = watch(result);
      await clock.advance(60_000 / rate);
      assert.equal(bot.time.age, 1_060);
      assert.equal(state.over, false);
      await clock.advance(50);
      await assert.rejects(result, (error: Error) => {
        assert.match(error.message, /release not answered \(ticks\)/);
        assert.match(error.message, /"end":"ticks"/);
        assert.match(error.message, /"elapsedTicks":60/);
        assert.ok(error.message.includes(`"elapsedMs":${60_000 / rate + 50}`));
        return true;
      });
      if (row.logExpected) assert.ok(logs.some(line => line.includes('"elapsedTicks":60') && line.includes('"end":"ticks"') && line.includes('"elapsedMs":')));
      await assertClean();
    });
  }
}

const waits: readonly { name: string; run: (context: MineAiScenarioContext) => Promise<unknown>; wall: number; unobserved: number }[] = [
  { name: "removal", run: (context: MineAiScenarioContext) => removeArrangedEntities(context, targets), wall: 18_000, unobserved: 5_000 },
  { name: "release answers", run: (context: MineAiScenarioContext) => waitForReleaseAnswers(context, new Set([2]), "/release"), wall: 9_000, unobserved: 2_000 },
  { name: "tag release", run: (context: MineAiScenarioContext) => releaseByTag(context, "primary", "enderman"), wall: 9_000, unobserved: 2_000 },
];
for (const wait of waits) {
  for (const noAge of [false, true]) {
    test(`${wait.name} fails bounded with ${noAge ? "unobserved" : "stopped"} server time`, async () => {
      const { context, bot, clock, server, assertClean } = fixture(10, undefined, !noAge);
      using _timers = clock.install();
      server.stop();
      const result = wait.run(context);
      const state = watch(result);
      const finishMs = noAge ? wait.unobserved : wait.wall;
      await clock.advance(finishMs - 1);
      assert.equal(state.over, false);
      await clock.advance(1);
      assert.equal(bot.time.age, noAge ? null : 1_000);
      await assert.rejects(clock.settle(result, 0), new RegExp(noAge ? "unobserved" : "wall"));
      await assertClean();
    });
  }

  for (const before of [true, false]) {
    test(`${wait.name} propagates cancellation ${before ? "before" : "during"} the wait`, async () => {
      const controller = new AbortController();
      const reason = new Error("trial cancelled");
      const { context, clock, assertClean } = fixture(10, controller.signal);
      using _timers = clock.install();
      if (before) controller.abort(reason);
      const result = wait.run(context);
      watch(result);
      if (!before) { await clock.advance(500); controller.abort(reason); }
      await assert.rejects(clock.settle(result, 0), error => error === reason);
      await assertClean();
    });
  }

  test(`${wait.name} cleans up when sending the command throws`, async () => {
    const { context, bot, clock, assertClean } = fixture();
    using _timers = clock.install();
    const reason = new Error("chat failed");
    bot.chat = () => { throw reason; };
    await assert.rejects(wait.run(context), error => error === reason);
    await assertClean();
  });
}

test("removal reports server-moved positions, presence and command answers", async () => {
  const { context, bot, clock, assertClean } = fixture();
  using _timers = clock.install();
  const result = removeArrangedEntities(context, targets);
  watch(result);
  bot.entities[2]!.position.set(4, 65, 6);
  bot.emit("entityMoved", bot.entities[2]!);
  delete bot.entities[2];
  bot.emit("messagestr", "Killed primary", "system", null as never);
  bot.emit("messagestr", "Killed alternative", "system", null as never);
  await clock.advance(6_050);
  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /"id":2,"present":false,"position":\{"x":4,"y":65,"z":6\}/);
    assert.match(error.message, /Killed primary/);
    assert.match(error.message, /Killed alternative/);
    assert.ok(error.message.includes("/kill @e[tag=primary]"));
    return true;
  });
  await assertClean();
});

test("removal sends both kills when a bound entity has already gone", async () => {
  const { context, clock, gone, logs, commands, assertClean } = fixture();
  using _timers = clock.install();
  delete context.bot.entities[2];
  const result = removeArrangedEntities(context, targets);
  gone(3);
  await clock.settle(result, 50);
  assert.deepEqual(commands, ["/kill @e[tag=primary]", "/kill @e[tag=alternative]"]);
  assert.ok(logs.includes("arranged primary id 2 already gone before removal"));
  await assertClean();
});

test("target changes are an ordered subsequence independent of diagnostic reasons", () => {
  const changes = [
    { fromTargetId: 1, toTargetId: 2, reason: "Target priority changed" },
    { fromTargetId: 2, toTargetId: 9, reason: "shield preparation" },
    { fromTargetId: 2, toTargetId: 1, reason: "Target priority changed" },
  ];
  const ids = { primary: 1, alternative: 2 };
  assert.equal(changesObserved(changes, [["primary", "alternative"], ["alternative", "primary"]], ids), true);
  assert.equal(changesObserved(changes, [["alternative", "primary"], ["primary", "alternative"]], ids), false);
  assert.equal(changesObserved(changes.slice(0, 2), [["primary", "alternative"], ["alternative", "primary"]], ids), false);
});
