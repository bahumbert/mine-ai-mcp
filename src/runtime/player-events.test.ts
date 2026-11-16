import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { botEventInputSchema, readLastDeath, readNotificationSummary, SqlBotData } from "../bot-data/index.js";
import { closeSqlDatabase } from "../bot-data/sql-bot-data.js";
import { persistentBotData } from "../test-support/bot-data.js";
import { recordPersonalRespawn } from "../actions/portal-entry/respawn-knowledge.js";
import { Vec3 } from "vec3";
import { type FakeBot, type FakeBotOptions, createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { captureStderr } from "../test-support/stderr.js";
import { ChatCommandRing } from "./chat-commands.js";
import { observePlayerEvents } from "./player-events.js";

/** A bot at (12.5, 64, -3.25); `added(event)` counts the listeners on `event` beyond the idle bot's own. */
function playerBot(username = "MineAI") {
  const { bot } = createFakeBot({ username, position: { x: 12.5, y: 64, z: -3.25 } });
  return { bot, added: listenersAddedSince(bot) };
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
    context: {
      lastAlive: null,
      food: 20,
      held: null,
      armour: { head: null, chest: null, legs: null, feet: null },
      carriesWeapon: false,
      bestMelee: null,
      enclosed: false,
      respawn: null,
    },
  });
  assert.deepEqual(readLastDeath(data, bot.username), {
    botId: "RuntimeBot", dimension: "overworld",
    position: { x: 12.5, y: 64, z: -3.25 },
    observedAt: page.events[0]!.observedAt, cause: null,
  });

  stopObserving();
  stopObserving();
  assert.equal(added("death"), 1);
  assert.equal(added("health"), 0);
  bot.emit("death");
  assert.equal(unrelatedDeaths, 2);
  assert.deepEqual(cancellations, ["RuntimeBot died."]);
  assert.equal(readRecentEvents(data, bot.username, 50).events.length, 0);
});

/** A bot with a sword in hand and a helmet on, observed; `deathContext()` reads the context of the one death it records. */
function armedBot(username: string, options: Partial<FakeBotOptions> = {}, whenCancelled: () => void = () => undefined) {
  const harness = createFakeBot({
    username,
    position: { x: 12.5, y: 64, z: -3.25 },
    slots: { 36: { name: "iron_sword" }, 5: { name: "iron_helmet" } },
    ...options,
  });
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: `player-events-context-${username}`, scope: { kind: "bot", botId: username } },
  });
  const stopObserving = observePlayerEvents(harness.bot, data, whenCancelled);
  return {
    ...harness,
    data,
    deathContext() {
      const events = readRecentEvents(data, username, 50).events.filter((event) => event.type === "player_death");
      assert.equal(events.length, 1, "one death event");
      const event = events[0];
      return event?.type === "player_death" ? event.payload.context : undefined;
    },
    close() {
      stopObserving();
      data.close();
    },
  };
}

test("records the last alive vitals and the gear at death", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = armedBot("Gear", { clock, position: { x: 1, y: 64, z: 1 } });
  t.after(() => f.close());

  f.combat.setHealth(14, 9);
  await clock.advance(1_200);
  f.combat.setHealth(0, 9);

  // Review 2026-11-07 S4: the event's summary carries the state line; the notification preview stays on the first line.
  assert.deepEqual(readNotificationSummary(f.data, "Gear").recentPreview, ["Gear died at 1, 64, 1 in overworld."]);
  const [event] = readRecentEvents(f.data, "Gear", 50).events;
  assert.equal(
    event?.summary,
    "Gear died at 1, 64, 1 in overworld.\n" +
      "State at death: held iron_sword; armour head iron_helmet; food 9; last health 14 (1.2 s before); in the open; respawn unknown",
  );

  assert.deepEqual(event?.type === "player_death" ? event.payload.context : undefined, {
    lastAlive: { health: 14, food: 9, saturation: 5, msBefore: 1_200 },
    food: 9,
    held: "iron_sword",
    armour: { head: "iron_helmet", chest: null, legs: null, feet: null },
    carriesWeapon: true,
    bestMelee: "iron_sword",
    enclosed: false,
    respawn: null,
  });
  assert.equal(f.bot.heldItem, null, "the server cleared the hands after the cause packet, as measured");
});

test("a death with no cause packet reads what it finds, before the cancel empties the hands", (t) => {
  let emptied = false;
  const f = armedBot("NoPacket", {}, () => {
    emptied = true;
    f.inventory.clearAll();
  });
  t.after(() => f.close());

  f.bot.emit("death");

  assert.equal(emptied, true);
  const context = f.deathContext();
  assert.equal(context?.lastAlive, null, "no health reading came before");
  assert.equal(context?.held, "iron_sword");
  assert.equal(context?.armour.head, "iron_helmet");
});

test("a second life starts with its own last alive reading and the gear it has then", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = armedBot("Twice", { clock });
  t.after(() => f.close());

  f.combat.setHealth(0, 20);
  f.combat.setHealth(20, 20);
  await clock.advance(300);
  f.combat.setHealth(0, 20);

  const deaths = readRecentEvents(f.data, "Twice", 50).events.flatMap((event) => (event.type === "player_death" ? [event.payload.context] : []));
  assert.deepEqual(deaths.map((context) => context?.lastAlive), [null, { health: 20, food: 20, saturation: 5, msBefore: 300 }]);
  assert.deepEqual(deaths.map((context) => context?.held), ["iron_sword", null], "the first death cleared the hands");
});

test("the second death's context carries the first wake", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = armedBot("WakeTwice", { clock });
  t.after(() => f.close());
  f.server.setRespawnPoint(new Vec3(40.5, 64, 40.5));
  f.combat.setHealth(0, 20);
  await clock.advance(2_000);
  f.bot.entity.position.x += 12;
  f.combat.setHealth(0, 20);
  const deaths = readRecentEvents(f.data, "WakeTwice", 50).events.filter((event) => event.type === "player_death");
  const second = deaths[1];
  assert.equal(second?.type, "player_death");
  if (second?.type === "player_death") {
    assert.deepEqual(second.payload.context?.respawn, { kind: "last_wake", dimension: "overworld", x: 40.5, y: 64, z: 40.5, distance: 12 });
    assert.match(second.summary, /respawn where it last woke, 12 blocks away/);
  }
});

test("a cause packet no death followed does not describe the next death", (t) => {
  const f = armedBot("Stale");
  t.after(() => f.close());

  f.bot._client.emit("death_combat_event", { playerId: f.bot.entity.id, message: undefined });
  f.combat.setHealth(20, 20);
  f.inventory.clearAll();
  f.bot.emit("death");

  assert.equal(f.deathContext()?.held, null, "read at the death, not kept from the packet");
});

const BED = { x: 20.5, y: 64, z: -3.25 };
for (const [name, options, setUp, expected] of [
  [
    "the world spawn when no bed is known",
    {},
    (bot: FakeBot) => void (bot.spawnPoint = new Vec3(0, 70, 0)),
    { kind: "world_spawn", dimension: "overworld", x: 0, y: 70, z: 0, distance: Math.hypot(12.5, 6, 3.25) },
  ],
  [
    "a known bed, with its distance",
    {},
    (bot: FakeBot) => {
      recordPersonalRespawn(bot, BED);
      bot.spawnPoint = new Vec3(0, 70, 0);
    },
    { kind: "bed", dimension: "overworld", ...BED, distance: 8 },
  ],
  [
    "a bed in another dimension than the death, with no distance",
    { dimension: "the_nether" },
    (bot: FakeBot) => recordPersonalRespawn(bot, BED),
    { kind: "bed", dimension: "overworld", ...BED, distance: null },
  ],
] as const) {
  test(`the respawn of a death is ${name}`, (t) => {
    const f = armedBot("Spawns", options);
    t.after(() => f.close());
    setUp(f.bot);

    f.combat.setHealth(0, 20);

    assert.deepEqual(f.deathContext()?.respawn, expected);
  });
}

test("old death payloads without context still parse", () => {
  const event = {
    type: "player_death",
    observedAt: "2026-08-30T00:00:00.000Z",
    summary: "RuntimeBot died.",
    payload: { dimension: "overworld", position: { x: 1, y: 64, z: 2 }, cause: "Ayla was slain by Zombie" },
  };

  assert.deepEqual(botEventInputSchema.parse(event), event);
  assert.throws(() => botEventInputSchema.parse({ ...event, payload: { ...event.payload, context: { held: 3 } } }));
});

test("two bots keep their own last alive readings", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const first = armedBot("First", { clock });
  const second = armedBot("Second", { clock });
  t.after(() => {
    first.close();
    second.close();
  });

  first.combat.setHealth(7, 4);
  second.combat.setHealth(18, 20);
  await clock.advance(500);
  first.combat.setHealth(0, 4);
  second.combat.setHealth(0, 20);

  assert.deepEqual(first.deathContext()?.lastAlive, { health: 7, food: 4, saturation: 5, msBefore: 500 });
  assert.deepEqual(second.deathContext()?.lastAlive, { health: 18, food: 20, saturation: 5, msBefore: 500 });
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

/** A bot observed with command lines on (`commands`), or off; `events()` is what `read_recent_events` would give. */
function commandBot(t: TestContext, commands: boolean) {
  const { bot } = playerBot();
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "player-events-commands-test", scope: { kind: "bot", botId: bot.username } },
  });
  const ring = new ChatCommandRing();
  const stopObserving = observePlayerEvents(bot, data, () => undefined, commands ? { prefix: "!", ring } : undefined);
  t.after(() => {
    stopObserving();
    data.close();
  });
  return {
    bot,
    data,
    ring,
    events: () => readRecentEvents(data, bot.username, 50).events.map(({ summary }) => summary),
    ringed: () => ring.after(undefined).commands.map(({ username, channel, message }) => `${channel}:${username}:${message}`),
  };
}

test("an incoming command line goes to the ring and is not recorded, so no brain reads it; the bot's own line is", (t) => {
  const { bot, data, events, ringed } = commandBot(t, true);

  bot.emit("chat", "Tom", "!bots", null, {} as never, null);
  bot.emit("whisper", "Tom", "!bot stop ayla", null, {} as never, null);
  bot.emit("chat", "Tom", "  !BOT stop x", null, {} as never, null);
  bot.emit("chat", "Ayla", "!bot", null, {} as never, null);
  bot.emit("chat", "MineAI", "!bots", null, {} as never, null);

  assert.deepEqual(ringed(), ["chat:Tom:!bots", "whisper:Tom:!bot stop ayla", "chat:Tom:  !BOT stop x", "chat:Ayla:!bot"]);
  assert.deepEqual(events(), ["MineAI: !bots"]);
  assert.deepEqual(readNotificationSummary(data, bot.username), { unreadCount: 0 });
});

test("a line that only holds or resembles a command is ordinary chat", (t) => {
  const { bot, events, ringed } = commandBot(t, true);

  bot.emit("chat", "Tom", "hello !bots", null, {} as never, null);
  bot.emit("chat", "Tom", "!botany", null, {} as never, null);

  assert.deepEqual(ringed(), []);
  assert.deepEqual(events(), ["Tom: hello !bots", "Tom: !botany"]);
});

test("without command lines on, !bots is recorded as it always was", (t) => {
  const { bot, events, ringed } = commandBot(t, false);

  bot.emit("chat", "Tom", "!bots", null, {} as never, null);

  assert.deepEqual(events(), ["Tom: !bots"]);
  assert.deepEqual(ringed(), []);
});
