/** The walks off a toss and off a hole stop at 12 blocks of path or 5 s (live s3l 2026-11-01: 106 and 167 blocks underground). */
import assert from "node:assert/strict";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { listenersAddedSince } from "../../test-support/fake-bot/listener-counts.js";
import type { FakeBot } from "../../test-support/fake-bot/index.js";
import { sleepMs } from "../../utils/wall-timers.js";
import { parseDropItemRequest } from "./contract.js";
import { dropItem } from "./drop-item.js";
import { abortAfterToss, deps, dropBot, dropTest, pitWorld } from "./drop-item-fixtures.test.js";

const MAX_BLOCKS = 12;
const MAX_MS = 5_000;
/** The most a bounded walk may add past the bound: the tick that crosses it. */
const SLACK_BLOCKS = 1;

type RouteOptions = { stopSignal?: AbortSignal; signal?: AbortSignal };

/** A route that wanders in place, one block a client tick out to 3 blocks and back (never 4 from the toss), until stopped. */
function wander(bot: FakeBot, walked: { blocks: number }, stopSignal: AbortSignal | undefined, maxSteps = 300) {
  const startX = bot.entity.position.x;
  let step = 1;
  for (let steps = 0; steps < maxSteps && !stopSignal?.aborted; steps++) {
    bot.entity.position.x += step;
    walked.blocks += 1;
    if (Math.abs(bot.entity.position.x - startX) >= 3) step = -step;
    bot.emit("physicsTick");
  }
  return { status: stopSignal?.aborted ? "stopped" : "completed", elapsedMs: 0 } as never;
}

dropTest("a walk-off that circles never clear stops at 12 blocks: navigate saw stopSignal, no further side (live s3l: 167 blocks to y -15)", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 3 }] }, clock);
  const walked = { blocks: 0 };
  let routes = 0;
  await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_log" }] }), {}, deps({
      navigate: (async (options: RouteOptions) => {
        routes += 1;
        assert.ok(options.stopSignal, "the walk-off passes the bound as stopSignal");
        return wander(bot, walked, options.stopSignal);
      }) as never,
    }), createDiscardedItems()),
  );
  assert.ok(walked.blocks <= MAX_BLOCKS + SLACK_BLOCKS, `walked ${walked.blocks} blocks`);
  assert.equal(routes, 1, "no further side once the bound fired");
});

dropTest("four slow sides share one 5 s bound", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 3 }] }, clock);
  const starts: number[] = [];
  let lastEnd = 0;
  await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_log" }] }), {}, deps({
      navigate: (async (options: RouteOptions) => {
        starts.push(clock.now());
        await sleepMs(2_000, options.stopSignal).catch(() => undefined);
        lastEnd = clock.now();
        return { status: "completed", elapsedMs: 2_000 };
      }) as never,
    }), createDiscardedItems()),
  );
  assert.equal(starts.length, 3, "the third side was cut at 5 s and the fourth never started");
  assert.ok(lastEnd - starts[0]! <= MAX_MS + 100, `the sides took ${lastEnd - starts[0]!} ms`);
});

dropTest("a hole step-away shares the same bound", async ({ clock, run }) => {
  const world = pitWorld(clock);
  const walked = { blocks: 0 };
  const bounded: AbortSignal[] = [];
  const plain = world.dependencies.navigate;
  const result = await run(
    dropItem(world.bot, parseDropItemRequest({ items: [{ item_name: "dirt" }], in_a_hole: true }), {}, {
      ...world.dependencies,
      navigate: (async (options: RouteOptions & Parameters<typeof plain>[0]) => {
        if (!options.stopSignal) return plain(options);
        bounded.push(options.stopSignal);
        return wander(world.bot, walked, options.stopSignal);
      }) as never,
    }, createDiscardedItems()),
  );
  assert.equal(bounded.length, 1, "the step-away carries the bound");
  assert.ok(bounded[0]!.aborted);
  assert.ok(walked.blocks <= MAX_BLOCKS + SLACK_BLOCKS, `walked ${walked.blocks} blocks`);
  assert.ok(result.drop.holeClosure, "the drop still ends with its closure");
});

dropTest("cancel mid-walk rejects with the cancel, no listener left", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 3 }] }, clock);
  const owner = new AbortController();
  const added = listenersAddedSince(bot);
  await assert.rejects(
    run(
      dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_log" }] }), { signal: owner.signal }, deps({
        navigate: (async () => {
          bot.entity.position.x += 1;
          bot.emit("physicsTick");
          owner.abort(new Error("hunger reflex"));
          throw new Error("route stopped");
        }) as never,
      }), createDiscardedItems()),
    ),
    /hunger reflex/,
  );
  assert.equal(added("physicsTick"), 0);
});

dropTest("after a walk cut by the bound, the next ground drop runs and finishes", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 3 }, { name: "cobblestone", count: 3 }] }, clock);
  const walked = { blocks: 0 };
  await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_log" }] }), {}, deps({
      navigate: (async (options: RouteOptions) => wander(bot, walked, options.stopSignal)) as never,
    }), createDiscardedItems()),
  );
  const second = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "cobblestone" }] }), {}, deps({
      navigate: (async () => {
        bot.entity.position.x += 5;
        return { status: "completed", elapsedMs: 10 };
      }) as never,
    }), createDiscardedItems()),
  );
  assert.equal(second.status, "succeeded");
  assert.equal(second.drop.dropped[0]?.dropped, 3);
});

dropTest("the bound fires within 1.5 blocks of the toss (slow route search) -> an honest [DROP_PICKED_UP], one result, no retry inside drop_item", async ({ clock, run }) => {
  const { bot } = dropBot({ carried: [{ name: "oak_log", count: 3 }] }, clock);
  const tosses = abortAfterToss(bot, new AbortController(), Number.MAX_SAFE_INTEGER);
  let routes = 0;
  const result = await run(
    dropItem(bot, parseDropItemRequest({ items: [{ item_name: "oak_log" }] }), {}, deps({
      navigate: (async (options: RouteOptions) => {
        routes += 1;
        await sleepMs(10_000, options.stopSignal).catch(() => undefined);
        return { status: "stopped", elapsedMs: 5_000 };
      }) as never,
    }), createDiscardedItems()),
  );
  assert.equal(result.status, "failed");
  assert.match(result.drop.dropped[0]?.error ?? "", /\[DROP_PICKED_UP\]/);
  assert.equal(routes, 1);
  assert.equal(tosses.tosses, 1, "drop_item did not toss again");
});
