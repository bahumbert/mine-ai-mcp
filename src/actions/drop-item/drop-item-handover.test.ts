import assert from "node:assert/strict";
import test from "node:test";
import type { Entity } from "prismarine-entity";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { type FakeBot, type FakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { formatDropItemResult, dropItem } from "./drop-item.js";
import { deps, dropBot, dropTest, type Stack } from "./drop-item-fixtures.test.js";
import { handOverLine, PLAYER_EYE_HEIGHT, tossAimHeight } from "./hand-over.js";

interface Collect {
  readonly by: "recipient" | "giver" | "other";
  /** Clock time after the toss at which the server announces the pickup. */
  readonly afterMs: number;
  /** The packet's `pickupItemCount`; the tossed stack's count when omitted. */
  readonly count?: number;
}

const RECIPIENT_ID = 42;
const OTHER_PLAYER_ID = 5_000;

interface HandOverOptions {
  readonly carried?: readonly Stack[];
  /** The server takes this long (clock time) to accept a toss (unmeasured: a stopgap of this test, not a game answer). */
  readonly tossDelayMs?: number;
  /** The server announces these pickups (raw `collect` packets) after the toss; the giver's also puts the items back in its inventory. */
  readonly collects?: Collect | readonly Collect[];
}

/** The giver walks off the toss, as the action's own walk does, so the server's pickup delay does not hand it back its toss. */
const stepAway = (bot: FakeBot) => {
  bot.entity.position.x -= 3;
  return { status: "completed", elapsedMs: 5 };
};

/** A giver on the shared fake with a recipient `Dev` beside it; the server announces the pickups `options.collects` lists. */
function handOver(clock: FakeClock, options: HandOverOptions = {}) {
  const made = dropBot(
    {
      carried: options.carried ?? [{ name: "oak_log", count: 3 }],
      players: {
        Dev: { id: RECIPIENT_ID, position: { x: 0, y: 64, z: 1.5 } },
        Other: { id: OTHER_PLAYER_ID, position: { x: 20, y: 64, z: 20 } },
      },
      tossWaitsForSpawn: true,
    },
    clock,
  );
  const { bot, harness } = made;
  const afterTossRuns: (() => void)[] = [];
  /** Runs `then` `afterMs` of clock after the toss went out. */
  const afterToss = (afterMs: number, then: () => void) => afterTossRuns.push(() => void setTimeout(then, afterMs));
  const seen = new Set<number>(Object.values(bot.entities).map((entity) => entity.id));
  const announce = (collect: Collect, entity: Entity, name: string, stackCount: number) => {
    const count = collect.count ?? stackCount;
    const collector = { giver: bot.entity, other: bot.entities[OTHER_PLAYER_ID]!, recipient: bot.entities[RECIPIENT_ID]! }[collect.by];
    if (collect.by === "giver") {
      const type = bot.registry.itemsByName[name]!.id;
      setCarriedCount(harness.inventory, bot.registry, type, bot.inventory.count(type, null) + count);
    }
    harness.entities.takenBy(collector, entity, count);
  };
  const tossed = () => {
    const entity = Object.values(bot.entities).find((candidate) => candidate.name === "item" && !seen.has(candidate.id) && candidate.getDroppedItem());
    if (entity) {
      seen.add(entity.id);
      const stack = entity.getDroppedItem()!;
      for (const collect of [options.collects ?? []].flat()) afterToss(collect.afterMs, () => announce(collect, entity, stack.name, stack.count));
    }
    for (const run of afterTossRuns.splice(0)) run();
  };
  const tossStack = bot.tossStack.bind(bot);
  bot.tossStack = async (stack) => {
    if (options.tossDelayMs) await clock.sleep(options.tossDelayMs);
    await tossStack(stack);
    tossed();
  };
  const toss = bot.toss.bind(bot);
  bot.toss = async (type, metadata, count) => {
    if (options.tossDelayMs) await clock.sleep(options.tossDelayMs);
    await toss(type, metadata, count);
    tossed();
  };
  return { ...made, afterToss };
}

const handOverRequest = parseDropItemRequest({ items: [{ item_name: "oak_log" }], to_player: "Dev" });
/** The dependencies of a hand-over: the giver steps away from the toss; `handoverWallMs` is the wall bound on the clock the test moves. */
const handOverDeps = (bot: FakeBot, handoverWallMs: number, navigate: () => Promise<unknown> | unknown = () => stepAway(bot)) =>
  deps({ handoverWallMs, navigate: (async () => navigate()) as never });
/** The server's age moves 20 ticks per second of clock: a wall bound above this ends no wait before the 100 ticks that settle it. */
const WELL_PAST_SETTLING_MS = 30_000;

dropTest("hand-over: the recipient collects -> succeeded, collected true", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "recipient", afterMs: 40 } });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 1_000), createDiscardedItems()));
  assert.equal(result.status, "succeeded");
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
  assert.equal(result.drop.recipient?.collectedCount, 3);
  assert.equal(result.drop.recipient?.tossedCount, 3);
  assert.match(formatDropItemResult(result), /Handed to \*\*Dev\*\*/);
});

dropTest("hand-over: the giver collects its toss back -> failed [DROP_PICKED_UP]", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "giver", afterMs: 40 } });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 1_000), createDiscardedItems()));
  assert.equal(result.status, "failed");
  assert.ok(result.drop.dropped[0]?.error?.startsWith("[DROP_PICKED_UP]"));
  assert.equal(result.drop.recipient?.collected, false);
});

// A toss the server accepts late (60 ms) is the case the old wall timer lost: it moved the age 30 ms after the call began,
// before the wait read its start age, and only the wall bound ended the wait.
for (const tossDelayMs of [0, 60]) {
  dropTest(`hand-over: nobody takes it (toss accepted after ${tossDelayMs} ms) and the world age moves 100 ticks -> settled, nothing taken, before the wall bound`, async ({ clock, run }) => {
    const { bot } = handOver(clock, { tossDelayMs });
    const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, WELL_PAST_SETTLING_MS), createDiscardedItems()));
    assert.equal(result.status, "succeeded");
    assert.equal(result.drop.recipient?.collected, false);
    assert.equal(result.drop.recipient?.collectedCount, 0);
    assert.equal(result.drop.recipient?.settled, true, "the server's age ended the wait, not the wall bound");
    assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 0 of 3/);
  });
}

dropTest("hand-over: the world age has not moved 100 ticks when the wall bound ends the wait -> unsettled", async ({ clock, run }) => {
  const { bot } = handOver(clock);
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 200), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, false);
  assert.match(formatDropItemResult(result), /Tossed to \*\*Dev\*\*; the server has not said yet whether they took them \(0 of 3 seen taken\)/);
});

dropTest("hand-over: no world age at the toss -> only the wall bound ends the wait, unsettled", async ({ clock, run }) => {
  const { bot } = handOver(clock);
  // Mineflayer's `time.js` reads null for everything until the first `update_time` packet (the fake answers so with `timePacketYet: false`).
  Object.defineProperty(bot, "time", { configurable: true, value: { age: null } });
  // The wait for a still recipient counts world age too: with none it would end the call before the toss, so it is answered here.
  const stillRecipient = { ...handOverDeps(bot, 150), awaitStillRecipient: async () => "still" as const };
  const result = await run(dropItem(bot, handOverRequest, {}, stillRecipient, createDiscardedItems()));
  assert.equal(result.drop.recipient?.settled, false);
});

dropTest("hand-over: a server that lags keeps the wait open until the pickup packet arrives (review B1)", async ({ clock, run }) => {
  const { bot, afterToss } = handOver(clock, { collects: { by: "recipient", afterMs: 500 } });
  let ended = false;
  let endedBeforePacket: boolean | null = null;
  // Only one jump of the server's age (20 ticks) has passed when this reads: nothing is settled, the packet has not come.
  afterToss(400, () => {
    endedBeforePacket = ended;
  });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 3_000), createDiscardedItems()).finally(() => {
    ended = true;
  }));
  assert.equal(endedBeforePacket, false, "still waiting for the server's answer");
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
});

dropTest("hand-over: a partial pickup counts what the packet says, not the whole stack (review 6)", async ({ clock, run }) => {
  const { bot } = handOver(clock, { carried: [{ name: "oak_log", count: 4 }], collects: { by: "recipient", afterMs: 30, count: 2 } });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, WELL_PAST_SETTLING_MS), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collectedCount, 2);
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, true);
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
});

dropTest("hand-over: two partial pickups of one stack add up and end the wait as taken", async ({ clock, run }) => {
  const { bot } = handOver(clock, {
    carried: [{ name: "oak_log", count: 4 }],
    collects: [{ by: "recipient", afterMs: 30, count: 2 }, { by: "recipient", afterMs: 60, count: 2 }],
  });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 5_000), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collectedCount, 4);
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.settled, true);
});

dropTest("hand-over: another player takes it all -> not the recipient's, and the wait ends at once", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "other", afterMs: 30 } });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 5_000), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(result.drop.recipient?.settled, true);
});

dropTest("hand-over: another player takes part of it -> the recipient took nothing, settled at 100 ticks", async ({ clock, run }) => {
  const { bot } = handOver(clock, { carried: [{ name: "oak_log", count: 4 }], collects: { by: "other", afterMs: 30, count: 1 } });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, WELL_PAST_SETTLING_MS), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collectedCount, 0);
  assert.equal(result.drop.recipient?.settled, true);
});

dropTest("hand-over: the giver picking back what was not taken leaves 'took X of N' at the toss, not the net drop (review 2026-10-24, 3)", async ({ clock, run }) => {
  const { bot } = handOver(clock, {
    carried: [{ name: "oak_log", count: 4 }],
    collects: [{ by: "recipient", afterMs: 30, count: 2 }, { by: "giver", afterMs: 60, count: 2 }],
  });
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, WELL_PAST_SETTLING_MS), createDiscardedItems()));
  assert.equal(result.drop.dropped[0]?.dropped, 2, "the net drop counts what came back");
  assert.equal(result.drop.recipient?.tossedCount, 4);
  assert.match(formatDropItemResult(result), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
});

test("hand-over lines: settled partial, unsettled and collected", () => {
  const at = { x: 0, y: 64, z: 0 };
  const recipient = { name: "Dev", distance: 1.5, position: at, collected: false, collectedCount: 2, tossedCount: 4, settled: true };
  assert.match(handOverLine(recipient, at), /Left at \*\*Dev\*\*'s feet: they took 2 of 4/);
  assert.match(handOverLine({ ...recipient, settled: false }, at), /Tossed to \*\*Dev\*\*; the server has not said yet whether they took them \(2 of 4 seen taken\)/);
  assert.match(handOverLine({ ...recipient, collected: true, collectedCount: 4 }, at), /Handed to \*\*Dev\*\* from 1.5 blocks away/);
});

dropTest("hand-over: the giver aims the toss at the recipient", async ({ clock, run }) => {
  const { bot, lookedAt } = handOver(clock, { collects: { by: "recipient", afterMs: 10 } });
  await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 500), createDiscardedItems()));
  assert.equal(lookedAt.length, 1);
  assert.equal(lookedAt[0]!.y, 64 + tossAimHeight(Math.hypot(0.5, 1)), "aimed at the height that lands the toss at their feet");
});

dropTest("hand-over: the giver steps away after the toss", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "recipient", afterMs: 10 } });
  let routes = 0;
  await run(
    dropItem(
      bot,
      handOverRequest,
      {},
      handOverDeps(bot, 500, () => {
        routes += 1;
        return stepAway(bot);
      }),
      createDiscardedItems(),
    ),
  );
  assert.ok(routes > 0, "the giver routed away from the toss (the recipient was already in reach, so no approach route)");
});

dropTest("hand-over: abort during the wait removes the collect and time listeners", async ({ clock, run }) => {
  const { bot, afterToss } = handOver(clock);
  const controller = new AbortController();
  const addedToClient = listenersAddedSince(bot._client);
  const addedToBot = listenersAddedSince(bot);
  let listeningWhenAborted = 0;
  afterToss(50, () => {
    listeningWhenAborted = addedToBot("time");
    controller.abort();
  });
  await assert.rejects(run(dropItem(bot, handOverRequest, { signal: controller.signal }, handOverDeps(bot, 5_000), createDiscardedItems())));
  assert.equal(listeningWhenAborted, 1, "the abort came while the wait was listening");
  assert.equal(addedToClient("collect"), 0);
  assert.equal(addedToBot("time"), 0);
});

dropTest("hand-over: a pickup announced while the giver walks away still counts", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "recipient", afterMs: 20 } });
  const walk = async () => {
    await clock.sleep(80);
    return stepAway(bot);
  };
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 1_000, walk), createDiscardedItems()));
  assert.equal(result.drop.recipient?.collected, true);
  assert.equal(result.drop.recipient?.collectedCount, 3);
});

test("hand-over: the aim height makes the toss land at the recipient's feet, from 0.5 to 2 blocks", () => {
  const pitchDown = (distance: number) => (Math.atan2(PLAYER_EYE_HEIGHT - tossAimHeight(distance), distance) * 180) / Math.PI;
  // Measured toss reach (Mine Labs 2026-10-20, simulated and live): level it slides about 4.3 blocks, 60 degrees down 1.5.
  for (const [distance, expected] of [[0.5, 79.5], [1, 69], [1.47, 59], [2, 48]] as const) {
    assert.ok(Math.abs(pitchDown(distance) - expected) < 1, `${distance} blocks: ${pitchDown(distance).toFixed(1)} degrees down`);
  }
  assert.ok(tossAimHeight(0.5) < tossAimHeight(1) && tossAimHeight(1) < tossAimHeight(2), "the farther they are, the higher the aim");
  assert.equal(tossAimHeight(6), PLAYER_EYE_HEIGHT, "beyond the toss reach the aim is level");
});

dropTest("hand-over: a toss nobody took is no deliberate discard any more, so pick_up_items can take it back (F6, trade s1d)", async ({ clock, run }) => {
  const { bot } = handOver(clock);
  const discarded = createDiscardedItems();
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 100), discarded));
  assert.equal(result.drop.recipient?.collected, false);
  assert.equal(discarded.ignored().size, 0);
});

dropTest("hand-over: a toss the recipient took stays a remembered discard", async ({ clock, run }) => {
  const { bot } = handOver(clock, { collects: { by: "recipient", afterMs: 40 } });
  const discarded = createDiscardedItems();
  const result = await run(dropItem(bot, handOverRequest, {}, handOverDeps(bot, 1_000), discarded));
  assert.equal(result.drop.recipient?.collected, true);
  assert.ok(discarded.ignored().size > 0);
});
