import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { botEventInputSchema, readLastDeath, readNotificationSummary, SqlBotData } from "../bot-data/index.js";
import { closeSqlDatabase } from "../bot-data/sql-bot-data.js";
import { persistentBotData } from "../test-support/bot-data.js";
import { createFakeBot, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { captureStderr } from "../test-support/stderr.js";
import { observePlayerEvents } from "./player-events.js";

/** A bot at (12.5, 64, -3.25); `added(event)` counts the listeners on `event` beyond the idle bot's own. */
function playerBot(username = "MineAI") {
  const { bot, chat } = createFakeBot({ username, position: { x: 12.5, y: 64, z: -3.25 } });
  return { bot, chat, added: listenersAddedSince(bot) };
}

test("records incoming and outgoing player messages while notifying only for incoming ones", (t) => {
  const { bot, added } = playerBot();
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-message-test", scope: { kind: "bot", botId: bot.username } },
  });
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(() => {
    stopObserving();
    data.close();
  });

  bot.emit("chat", "Alex", "MineAI, can you bring wood?", null, {} as never, null);
  bot.emit("chat", "MineAI", "Yes, I can.", null, {} as never, null);
  bot.emit("whisper", "Steve", "meet me at spawn", null, {} as never, null);

  assert.deepEqual(readNotificationSummary(data, bot.username), {
    unreadCount: 2,
    recentPreview: ["Alex: MineAI, can you bring wood?", "Steve: meet me at spawn"],
    hint: "Use read_recent_events to read and advance through recent events.",
  });

  const result = readRecentEvents(data, bot.username, 50);
  assert.deepEqual(
    result.events.map(({ summary, payload }) => ({ summary, payload })),
    [
      {
        summary: "Alex: MineAI, can you bring wood?",
        payload: {
          username: "Alex",
          channel: "chat",
          direction: "incoming",
          message: "MineAI, can you bring wood?",
          addressed: true,
        },
      },
      {
        summary: "MineAI: Yes, I can.",
        payload: {
          username: "MineAI",
          channel: "chat",
          direction: "outgoing",
          message: "Yes, I can.",
          addressed: false,
        },
      },
      {
        summary: "Steve: meet me at spawn",
        payload: {
          username: "Steve",
          channel: "whisper",
          direction: "incoming",
          message: "meet me at spawn",
          addressed: false,
        },
      },
    ],
  );
  assert.deepEqual(readNotificationSummary(data, bot.username), { unreadCount: 0 });

  stopObserving();
  stopObserving();
  assert.equal(added("chat"), 0);
  assert.equal(added("whisper"), 0);
  assert.equal(added("death"), 0);
  bot.emit("chat", "Alex", "after close", null, {} as never, null);
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);
});

test("the player death event requires a finite exact position", () => {
  const event = {
    type: "player_death",
    observedAt: "2026-08-30T00:00:00.000Z",
    summary: "RuntimeBot died.",
    payload: { dimension: "overworld", position: { x: 12.5, y: 64, z: -3.25 }, cause: null },
  };

  assert.deepEqual(botEventInputSchema.parse(event), event);
  for (const invalidCoordinate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() =>
      botEventInputSchema.parse({
        ...event,
        payload: { ...event.payload, position: { ...event.payload.position, x: invalidCoordinate } },
      }),
    );
  }
});

test("death requests cancellation once, records one event, and detaches without touching other listeners", (t) => {
  const { bot, added } = playerBot("RuntimeBot");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-death-test", scope: { kind: "bot", botId: bot.username } },
  });
  const cancellations: string[] = [];
  let unrelatedDeaths = 0;
  const unrelatedListener = () => {
    unrelatedDeaths += 1;
  };
  bot.on("death", unrelatedListener);
  const stopObserving = observePlayerEvents(bot, data, (reason) => {
    cancellations.push(reason);
    bot.entity.position.x = 99;
    return { kind: "idle", reason };
  });
  t.after(() => {
    stopObserving();
    data.close();
  });

  bot.emit("death");

  assert.deepEqual(cancellations, ["RuntimeBot died."]);
  assert.equal(unrelatedDeaths, 1);
  assert.deepEqual(readNotificationSummary(data, bot.username), {
    unreadCount: 1,
    recentPreview: ["RuntimeBot died at 12.5, 64, -3.25 in ov..."],
    hint: "Use read_recent_events to read and advance through recent events.",
  });
  const page = readRecentEvents(data, bot.username, 50);
  assert.equal(page.events.length, 1);
  assert.deepEqual(page.events[0]?.payload, {
    dimension: "overworld",
    position: { x: 12.5, y: 64, z: -3.25 },
    cause: null,
  });
  assert.deepEqual(readLastDeath(data, bot.username), {
    botId: "RuntimeBot", dimension: "overworld",
    position: { x: 12.5, y: 64, z: -3.25 },
    observedAt: page.events[0]!.observedAt, cause: null,
  });

  stopObserving();
  stopObserving();
  assert.equal(added("death"), 1);
  bot.emit("death");
  assert.equal(unrelatedDeaths, 2);
  assert.deepEqual(cancellations, ["RuntimeBot died."]);
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);
});

test("a respawn into another dimension records one event; a respawn in the same dimension records none", () => {
  const { bot, added } = playerBot("RuntimeBot");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-dimension-test", scope: { kind: "bot", botId: bot.username } },
  });
  const stopObserving = observePlayerEvents(bot, data, () => undefined);

  bot.emit("respawn");
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);

  bot.game.dimension = "the_nether";
  bot.emit("respawn");
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0, "respawn still has departure coordinates");
  Object.assign(bot.entity.position, { x: 18.5, y: 56, z: 26.5 });
  bot.emit("forcedMove");
  const events = readRecentEvents(data, bot.username, 50).events;
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "player_dimension_change");
  assert.equal(events[0]?.summary, "RuntimeBot arrived in the_nether from overworld.");
  if (events[0]?.type === "player_dimension_change") {
    assert.deepEqual(events[0].payload, {
      from: "overworld",
      to: "the_nether",
      position: { x: 18.5, y: 56, z: 26.5 },
    });
  }

  stopObserving();
  assert.equal(added("respawn"), 0);
  assert.equal(added("forcedMove"), 0);
  data.close();
});

function lockedStore(t: TestContext, botId: string) {
  const storage = persistentBotData(t);
  const data = storage.open("player-events-lock", { kind: "bot", botId });
  if (data.location.kind !== "persistent") throw new Error("Expected persistent SQL bot data.");
  const writer = new DatabaseSync(data.location.file);
  storage.alsoClose(() => {
    if (writer.isTransaction) writer.exec("ROLLBACK");
    closeSqlDatabase(writer);
  });
  return { data, lock: () => writer.exec("BEGIN IMMEDIATE"), release: () => writer.exec("ROLLBACK") };
}

test("a chat message during a database lock does not throw out of the listener", (t) => {
  const { bot } = playerBot("LockedBot");
  const { data, lock, release } = lockedStore(t, bot.username);
  const stderr = captureStderr(t);
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(stopObserving);

  lock();
  assert.doesNotThrow(() => bot.emit("chat", "Alex", "first, during the lock", null, {} as never, null));
  assert.ok(stderr.some((line) => line.startsWith("[player-events] ")), "the lost event leaves a line naming the observer");
  release();
  bot.emit("chat", "Alex", "second, after the lock", null, {} as never, null);

  assert.deepEqual(readRecentEvents(data, bot.username, 50).events.map((event) => event.summary), ["Alex: second, after the lock"]);
});

test("death still cancels the foreground action when the event write fails", (t) => {
  const { bot } = playerBot("LockedBot");
  const { data, lock } = lockedStore(t, bot.username);
  captureStderr(t);
  const cancellations: string[] = [];
  const stopObserving = observePlayerEvents(bot, data, (reason) => void cancellations.push(reason));
  t.after(stopObserving);

  lock();
  assert.doesNotThrow(() => bot.emit("death"));

  assert.deepEqual(cancellations, ["LockedBot died."]);
});

test("a dimension arrival whose write fails does not throw out of the forcedMove listener", (t) => {
  const { bot } = playerBot("LockedBot");
  const { data, lock } = lockedStore(t, bot.username);
  captureStderr(t);
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(stopObserving);

  lock();
  bot.game.dimension = "the_nether";
  bot.emit("respawn");
  assert.doesNotThrow(() => bot.emit("forcedMove"));
});

test("a chat message after the store closed does not throw", (t) => {
  const { bot } = playerBot("ClosedBot");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-closed", scope: { kind: "bot", botId: bot.username } },
  });
  const stderr = captureStderr(t);
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(stopObserving);

  data.close();

  assert.doesNotThrow(() => bot.emit("chat", "Alex", "after the shutdown", null, {} as never, null));
  assert.deepEqual(stderr, ["[player-events] SqlBotData is closed.\n"]);
});

test("records talk heard through Localized Chat once, as incoming chat with its distance", (t) => {
  const { bot, chat, added } = playerBot("Theo");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-local-chat-test", scope: { kind: "bot", botId: bot.username } },
  });
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(() => data.close());

  chat.hearSystem("[From 12.0 blocks away] <Ayla> hi Theo");
  // The sender's own echo is a plain `<Name> text` system line, which Mineflayer's `chat` already reads (spike result 4).
  chat.hearSystem("<Theo> my own echo");
  chat.hearSystem("[From x blocks away] <Ayla> not a distance");
  // Vanilla talk arrives as a player's chat line: the localized pattern must not record it a second time.
  chat.hearPlayer("Ayla", "hi");

  const events = readRecentEvents(data, bot.username, 50).events.map(({ payload }) => payload);
  assert.deepEqual(events, [
    { username: "Ayla", channel: "chat", direction: "incoming", message: "hi Theo", addressed: true, distance: 12 },
    { username: "Theo", channel: "chat", direction: "outgoing", message: "my own echo", addressed: false },
    { username: "Ayla", channel: "chat", direction: "incoming", message: "hi", addressed: false },
  ]);

  stopObserving();
  assert.equal(added("chat:localChat"), 0);
  let heardAfterStop = false;
  bot.on("chat:localChat" as "chat", () => {
    heardAfterStop = true;
  });
  chat.hearSystem("[From 3.0 blocks away] <Ayla> after the stop");
  assert.equal(heardAfterStop, false, "the pattern is removed with the observer");
});

test("localized talk during a database lock does not throw out of the listener", (t) => {
  const { bot, chat } = playerBot("LockedBot");
  const { data, lock, release } = lockedStore(t, bot.username);
  const stderr = captureStderr(t);
  const stopObserving = observePlayerEvents(bot, data, () => undefined);
  t.after(stopObserving);

  lock();
  assert.doesNotThrow(() => chat.hearSystem("[From 20.0 blocks away] <Alex> first, during the lock"));
  assert.ok(stderr.some((line) => line.startsWith("[player-events] ")), "the lost event leaves a line naming the observer");
  release();
  chat.hearSystem("[From 20.0 blocks away] <Alex> second, after the lock");

  assert.deepEqual(readRecentEvents(data, bot.username, 50).events.map((event) => event.summary), ["Alex: second, after the lock"]);
});
