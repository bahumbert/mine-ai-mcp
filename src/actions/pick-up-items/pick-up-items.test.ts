import assert from "node:assert/strict";
import test from "node:test";
import { recordLastDeath } from "../../bot-data/index.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { Vec3 } from "vec3";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { ITEM_GONE_SETTLE_TICKS } from "../../world/item-pickup.js";
import { AGE_PACKET_TICKS, MS_PER_ON_TIME_TICK } from "../../world/world-age.js";
import { createPickUpItemsAction } from "./pick-up-items.js";

for (const cause of ["whole take", "silent removal", "partial take then silent removal"] as const) {
  test(`pickup reports ${cause} with only confirmed collector evidence`, async (t) => {
    const { bot, clock, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
    using _timers = clock.install();
    const position = new Vec3(3, 64, 0);
    const drop = entities.spawn({ name: "item", position, item: { name: "gold_ingot", count: 2 }, pickupDelayTicks: 0 });
    const mob = entities.spawn({ name: "piglin", position });
    const action = createPickUpItemsAction(bot, { navigate: async () => {
      if (cause !== "silent removal") entities.takenBy(mob, drop, 1);
      if (cause === "whole take") entities.takenBy(mob, drop, 1);
      if (cause !== "whole take") entities.remove(drop.id);
      return { status: "stopped", reason: "item removed", elapsedMs: 0 };
    } } as never, temporaryBotData({ closeAfter: t }), createDiscardedItems());
    const lifetime = new AbortController();
    t.after(() => lifetime.abort());

    // item-pickup.ts's settleOnServerTicks needs the tick budget plus world-age.ts's packet margin/metadata grace;
    // two packet intervals cover packet rounding and the final look/read on this fake's default 20-tps clock (T4, 2026-11-18).
    const metadataWaitMs = 2 * AGE_PACKET_TICKS * MS_PER_ON_TIME_TICK;
    const settleBoundMs = ITEM_GONE_SETTLE_TICKS * MS_PER_ON_TIME_TICK + metadataWaitMs;
    const result = await clock.settle(
      action.begin({ radius: 8, recoverDeathItems: false }, lifetime.signal, () => {})({}),
      cause === "whole take" ? 1_500 : settleBoundMs,
    );
    assert.equal(result.pickup.sightings[0]?.outcome, cause === "whole take" ? "taken_by_other" : "gone_unconfirmed");
    assert.equal(result.pickup.sightings[0]?.takenBy, cause === "whole take" ? "piglin" : null);
    assert.doesNotThrow(() => action.resultSchema.parse(result));
  });
}

test("death recovery returns its named no-record refusal with schema-valid current position", async (t) => {
  const { bot } = createFakeBot();
  const data = temporaryBotData({ closeAfter: t });
  const action = createPickUpItemsAction(bot, {} as never, data, createDiscardedItems());
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /NO_RECORDED_DEATH/);
  assert.deepEqual(result.pickup.center, {
    x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z,
  });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});

test("death recovery refuses another dimension before asking navigation to move", async (t) => {
  const { bot } = createFakeBot();
  const data = temporaryBotData({ closeAfter: t });
  recordLastDeath(data, {
    botId: bot.username,
    dimension: "the_nether",
    position: { x: 30.5, y: 70, z: -4.5 },
    observedAt: new Date().toISOString(),
    cause: "fell from a high place",
  });
  let navigated = false;
  const action = createPickUpItemsAction(
    bot, { navigate: async () => { navigated = true; return { status: "completed", elapsedMs: 0 }; } } as never,
    data, createDiscardedItems(),
  );
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.equal(navigated, false);
  assert.match("error" in result ? result.error : "", /DEATH_DIMENSION_MISMATCH/);
  assert.deepEqual(result.pickup.center, { x: 30.5, y: 70, z: -4.5 });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});

test("stale death refusal preserves the retained recovery facts", async (t) => {
  const { bot } = createFakeBot();
  const data = temporaryBotData({ closeAfter: t });
  recordLastDeath(data, {
    botId: bot.username,
    dimension: bot.game.dimension,
    position: { x: 12.5, y: 64, z: 8.5 },
    observedAt: new Date(Date.now() - 301_000).toISOString(),
    cause: null,
  });
  const action = createPickUpItemsAction(bot, {} as never, data, createDiscardedItems());
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());

  const result = await action.begin(
    { radius: 8, recoverDeathItems: true }, lifetime.signal, () => {},
  )({});

  assert.match("error" in result ? result.error : "", /DEATH_RECORD_STALE/);
  assert.equal(result.pickup.recovery?.dimension, bot.game.dimension);
  assert.deepEqual(result.pickup.center, { x: 12.5, y: 64, z: 8.5 });
  assert.doesNotThrow(() => action.resultSchema.parse(result));
});
