// The occupied-fire contract and its failures run through the same native plugin as the real server.
import assert from "node:assert/strict";
import test from "node:test";
import { useNativeDigging } from "../../../../src/test-support/fake-bot/native-digging.ts";
import { listenersAddedSince } from "../../../../src/test-support/fake-bot/listener-counts.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { SERVER_CLOCK_STOPPED_MS } from "../../../../src/world/world-age.ts";
import { holdsWithin } from "../subject.ts";
import { occupiedFireDig } from "./occupied-fire-dig.ts";
import { type FakeHarness, runOnFake, withShiftedReads } from "./run-on-fake.ts";

for (const ticksPerSecond of [20, 10]) {
  test(`occupied feet/head fire is removed by native digging at ${ticksPerSecond} tps`, async () => {
    let checkCleanup: () => void;
    await runOnFake({ ...occupiedFireDig, run: async subject => {
      const result = await occupiedFireDig.run(subject);
      checkCleanup();
      await subject.wait(SERVER_CLOCK_STOPPED_MS + 25);
      checkCleanup();
      return result;
    } }, { ticksPerSecond }, (subject, harness) => {
      useNativeDigging(harness);
      const bot = listenersAddedSince(harness.bot);
      const client = listenersAddedSince(harness.bot._client);
      const timers = harness.clock.pendingGlobalTimers();
      checkCleanup = () => {
        assertDigListenersGone(bot, client);
        assert.equal(harness.clock.pendingGlobalTimers(), timers);
      };
      return subject;
    });
  });

  test(`occupied fire tick window includes 0 and 4, excludes -1 and 5 at ${ticksPerSecond} tps`, async () => {
    for (const ticks of [-1, 0, 4, 5]) {
      const run = runOnFake(occupiedFireDig, { ticksPerSecond }, (subject, harness) => {
        useNativeDigging(harness);
        // A planted faulty tick read, not a claimed server answer: the unshifted dig measures 1 tick.
        return withShiftedReads(subject, index => index % 2 === 1 ? ticks - 1 : 0);
      });
      if (ticks < 0 || ticks > 4) await assert.rejects(run, /expected 0\.\.4/);
      else await run;
    }
  });

  test(`occupied fire rejects client air when the authoritative answer is false at ${ticksPerSecond} tps`, async () => {
    await assert.rejects(runOnFake(occupiedFireDig, { ticksPerSecond }, (subject, harness) => {
      useNativeDigging(harness);
      let airQueries = 0;
      return { ...subject, blockIs: async (cell, block) => {
        const answer = await subject.blockIs(cell, block);
        return block === "air" && ++airQueries === 3 ? false : answer;
      } };
    }), /predicted air but the server kept the block/);
  });

  for (const exit of ["cancel", "stalled"] as const) {
    test(`occupied fire ${exit} releases native listeners and the next dig settles at ${ticksPerSecond} tps`, async () => {
      let harness: FakeHarness;
      await runOnFake({ ...occupiedFireDig, run: async subject => {
        const { bot } = subject;
        const cell = subject.world([0, -60, 0]);
        await subject.setBlock(cell, "fire");
        const addedBot = listenersAddedSince(bot);
        const addedClient = listenersAddedSince(bot._client);
        const timers = harness.clock.pendingGlobalTimers();
        const initialAge = bot.time.age;
        harness.server.stop();
        const started = subject.now();
        const dig = bot.dig(bot.blockAt(cell)!, true);
        const ended = assert.rejects(dig, exit === "cancel" ? /Digging aborted/ : /DIG_SERVER_CLOCK_STOPPED/);
        assert.ok(await holdsWithin(subject, () => bot.targetDigBlock !== null, ANSWER_WALL_MS));
        if (exit === "cancel") bot.stopDigging();
        await harness.clock.settle(ended, SERVER_CLOCK_STOPPED_MS);
        assert.equal(bot.time.age, initialAge, "stopped server supplies no progress");
        assert.ok(subject.now() - started <= SERVER_CLOCK_STOPPED_MS + 25);
        assert.equal(bot.targetDigBlock, null);
        assertDigListenersGone(addedBot, addedClient);
        assert.equal(harness.clock.pendingGlobalTimers(), timers);
        await subject.wait(SERVER_CLOCK_STOPPED_MS + 25);
        assertDigListenersGone(addedBot, addedClient);
        assert.equal(harness.clock.pendingGlobalTimers(), timers);
        harness.server.resume();
        // A refused/cancelled dig may leave fire; the next action inspects and clears it.
        if (await subject.blockIs(cell, "fire")) await harness.clock.settle(bot.dig(bot.blockAt(cell)!, true), ANSWER_WALL_MS);
        assert.equal(await subject.blockIs(cell, "air"), true);
        await subject.setBlock(cell, "fire");
        await harness.clock.settle(bot.dig(bot.blockAt(cell)!, true), ANSWER_WALL_MS);
        assert.equal(await subject.blockIs(cell, "air"), true, "the next actual dig settles from the cleared state");
        assertDigListenersGone(addedBot, addedClient);
      } }, { ticksPerSecond }, (subject, built) => {
        harness = built;
        useNativeDigging(harness);
        return subject;
      });
    });
  }

  test(`occupied contract cleanup survives a throwing cancel and the next dig at ${ticksPerSecond} tps`, async () => {
    let harness: FakeHarness;
    await runOnFake({ ...occupiedFireDig, run: async subject => {
      const { bot } = subject;
      const addedBot = listenersAddedSince(bot);
      const addedClient = listenersAddedSince(bot._client);
      const timers = harness.clock.pendingGlobalTimers();
      const write = bot._client.write;
      const digTime = bot.digTime;
      const failingWrite: typeof write = (name, data) => {
        if (name === "block_dig" && (data as { status: number }).status === 1) throw new Error("cancel transport failed");
        return write.call(bot._client, name, data);
      };
      bot._client.write = failingWrite;
      // Planted non-settlement, not a game answer: fire normally measures one tick.
      bot.digTime = () => 60_000;
      try {
        await assert.rejects(occupiedFireDig.run(subject), /cancel transport failed/);
        assert.equal(bot._client.write, failingWrite, "the contract restored its borrowed write method even when stop threw");
        assertDigListenersGone(addedBot, addedClient);
        assert.equal(harness.clock.pendingGlobalTimers(), timers);
        await subject.wait(SERVER_CLOCK_STOPPED_MS + 25);
        assertDigListenersGone(addedBot, addedClient);
        assert.equal(harness.clock.pendingGlobalTimers(), timers);
      } finally {
        bot._client.write = write;
        bot.digTime = digTime;
      }
      const cell = subject.world([0, -60, 0]);
      assert.equal(await subject.blockIs(cell, "fire"), true, "the cancelled long dig left fire to inspect");
      await harness.clock.settle(bot.dig(bot.blockAt(cell)!, true), ANSWER_WALL_MS);
      assert.equal(await subject.blockIs(cell, "air"), true, "the next actual dig finishes after transport recovery");
      assertDigListenersGone(addedBot, addedClient);
    } }, { ticksPerSecond }, (subject, built) => {
      harness = built;
      useNativeDigging(harness);
      return subject;
    });
  });
}

/** Every packet and per-block listener the native dig clock can add is removed on each exit. */
function assertDigListenersGone(bot: (event: string) => number, client: (event: string) => number): void {
  for (const event of ["blockUpdate:(0, -60, 0)", "time"]) assert.equal(bot(event), 0, event);
  for (const event of ["block_change", "multi_block_change", "map_chunk", "end"]) assert.equal(client(event), 0, event);
}
