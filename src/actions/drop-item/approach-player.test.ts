// Walking up to a recipient is not enough for a hand-over: the giver waits until they stand still, bounded by the wall
// clock, and tosses nothing when they never do.
import assert from "node:assert/strict";
import type { FakeBot, FakeClock } from "../../test-support/fake-bot/index.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { dropItem } from "./drop-item.js";
import { approachPlayer } from "./drop-walks.js";
import { dropBot, dropTest, deps } from "./drop-item-fixtures.test.js";

const DEV = 42;
/** The failure line of a drop result; empty for one that succeeded. */
const errorOf = (result: Awaited<ReturnType<typeof dropItem>>) => ("error" in result ? result.error ?? "" : "");
const handOverRequest = parseDropItemRequest({ items: [{ item_name: "oak_log" }], to_player: "Dev" });
const carried = [{ name: "oak_log", count: 3 }];
const recipientAt = (x: number) => ({ Dev: { id: DEV, position: { x, y: 64, z: 0 } } });
const giverAt = { x: 0, y: 64, z: 0 };

/** The recipient paces between two points 1.5 and 1 block east of the giver, every 50 ms, until the returned function stops it. */
function pace(bot: FakeBot, clock: FakeClock) {
  let x = 1.5;
  return clock.every(() => bot.entities[DEV]!.position.set((x = x === 1.5 ? 1 : 1.5), 64, 0), 50);
}

dropTest("a recipient who never stops: [DROP_RECIPIENT_MOVING] and nothing is tossed", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried, players: recipientAt(1.5), position: giverAt }, clock);
  pace(bot, clock);
  const result = await run(dropItem(bot, handOverRequest, {}, deps({ recipientWaitMs: 2_000 }), createDiscardedItems()));
  assert.equal(result.status, "failed");
  assert.ok(errorOf(result).startsWith("[DROP_RECIPIENT_MOVING] Dev did not stand still within 2 blocks for 2 s; nothing was tossed."));
  assert.deepEqual(result.drop.dropped, []);
  assert.equal(items()[0]?.count, 3, "nothing left the inventory");
});

dropTest("a recipient who walks off while waited for: the giver walks up again, then tosses once they stand still", async ({ clock, run }) => {
  const { bot } = dropBot({ carried, players: recipientAt(4), position: giverAt }, clock);
  const walkedTo: number[] = [];
  const dependencies = deps({
    navigate: (async () => {
      walkedTo.push(bot.entities[DEV]!.position.x);
      bot.entity.position.set(bot.entities[DEV]!.position.x - 1.5, 64, 0);
      return { status: "completed", elapsedMs: 5 };
    }) as never,
  });
  clock.after(400, () => bot.entities[DEV]!.position.set(bot.entity.position.x + 6, 64, 0));
  const recipient = await run(approachPlayer(bot, "Dev", dependencies, {}));
  assert.equal(recipient.name, "Dev");
  assert.equal(walkedTo.length, 2, "once to reach them, once after they walked beyond 2 blocks");
  assert.ok(bot.entity.position.distanceTo(bot.entities[DEV]!.position) <= 2);
});

dropTest("a chase cut by the deadline is [DROP_RECIPIENT_MOVING], not [DROP_PLAYER_UNREACHABLE]", async ({ clock, run }) => {
  const { bot } = dropBot({ carried, players: recipientAt(6), position: giverAt }, clock);
  const chase = (async ({ signal }: { signal: AbortSignal }) => {
    await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as never;
  const result = await run(dropItem(bot, handOverRequest, {}, deps({ navigate: chase, recipientWaitMs: 1_000 }), createDiscardedItems()));
  assert.equal(result.status, "failed");
  assert.match(errorOf(result), /^\[DROP_RECIPIENT_MOVING\]/);
});

dropTest("a cancel during the chase is not a moving recipient", async ({ clock, run }) => {
  const { bot } = dropBot({ carried, players: recipientAt(6), position: giverAt }, clock);
  const owner = new AbortController();
  const chase = (async ({ signal }: { signal: AbortSignal }) => {
    await new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }) as never;
  clock.after(200, () => owner.abort(new Error("reflex")));
  await assert.rejects(run(dropItem(bot, handOverRequest, { signal: owner.signal }, deps({ navigate: chase }), createDiscardedItems())), /reflex/);
});

dropTest("a recipient who logs out mid-wait: [DROP_PLAYER_LEFT]", async ({ clock, run }) => {
  const { bot } = dropBot({ carried, players: recipientAt(1.5), position: giverAt }, clock);
  pace(bot, clock);
  clock.after(300, () => void (bot.players.Dev!.entity = null as never));
  const result = await run(dropItem(bot, handOverRequest, {}, deps(), createDiscardedItems()));
  assert.match(errorOf(result), /^\[DROP_PLAYER_LEFT\]/);
});

/** The giver has no route to make up to a recipient in reach; the only route it takes is the walk off the toss. */
const walkOffAfterToss = (bot: FakeBot) =>
  (async () => {
    bot.entity.position.x -= 6;
    return { status: "completed", elapsedMs: 5 };
  }) as never;

dropTest("a second hand-over after a moving failure succeeds once the recipient stands still", async ({ clock, run }) => {
  const { bot, items } = dropBot({ carried, players: recipientAt(1.5), position: giverAt }, clock);
  const pacing = pace(bot, clock);
  const first = await run(dropItem(bot, handOverRequest, {}, deps({ recipientWaitMs: 1_500 }), createDiscardedItems()));
  assert.match(errorOf(first), /^\[DROP_RECIPIENT_MOVING\]/);
  pacing();
  bot.entities[DEV]!.position.set(1.5, 64, 0);
  const second = await run(
    dropItem(bot, handOverRequest, {}, deps({ navigate: walkOffAfterToss(bot) }), createDiscardedItems()),
  );
  assert.equal(second.status, "succeeded", errorOf(second));
  assert.equal(items().length, 0, "the three logs were tossed");
});

dropTest("a recipient who steps away as the route completes is walked up to again, not unreachable", async ({ clock, run }) => {
  const { bot } = dropBot({ carried, players: recipientAt(6), position: giverAt }, clock);
  let walks = 0;
  const navigate = (async () => {
    walks += 1;
    const x = bot.entities[DEV]!.position.x;
    bot.entity.position.set(x - 2, 64, 0);
    if (walks === 1) bot.entities[DEV]!.position.set(x + 0.3, 64, 0);
    return { status: "completed", elapsedMs: 5 };
  }) as never;
  const result = await run(dropItem(bot, handOverRequest, {}, deps({ navigate, recipientWaitMs: 2_000 }), createDiscardedItems()));
  assert.doesNotMatch(errorOf(result), /DROP_PLAYER_UNREACHABLE/);
  assert.ok(walks >= 2, `${walks} walks`);
});
