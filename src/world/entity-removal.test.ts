import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { armSignal } from "../utils/signals.js";
import { watchEntityRemoval } from "./entity-removal.js";

test("removed() is true inside entityGone listeners, while Mineflayer still lists the entity valid", () => {
  const harness = createFakeBot();
  const { bot } = harness;
  const piglin = harness.entities.spawn({ name: "piglin", position: new Vec3(2, 64, 0) });
  const seen: [boolean, boolean][] = [];
  // Registered before the watch: the watch's listener still runs first (it is prepended).
  bot.on("entityGone", () => {
    seen.push([watch.removed(), bot.entities[piglin.id]?.isValid === true]);
  });
  using watch = watchEntityRemoval(bot, piglin.id);
  assert.equal(watch.removed(), false);
  harness.entities.remove(piglin.id);
  assert.deepEqual(seen, [[true, true]]);
  assert.equal(watch.removed(), true);
});

test("another entity's removal leaves it false", () => {
  const harness = createFakeBot();
  const piglin = harness.entities.spawn({ name: "piglin", position: new Vec3(2, 64, 0) });
  const zombie = harness.entities.spawn({ name: "zombie", position: new Vec3(4, 64, 0) });
  using watch = watchEntityRemoval(harness.bot, piglin.id);
  harness.entities.remove(zombie.id);
  assert.equal(watch.removed(), false);
});

test("a respawn with the same id reads false", () => {
  const harness = createFakeBot();
  const piglin = harness.entities.spawn({ name: "piglin", position: new Vec3(2, 64, 0) });
  using watch = watchEntityRemoval(harness.bot, piglin.id);
  harness.entities.remove(piglin.id);
  assert.equal(watch.removed(), true);
  harness.entities.spawn({ id: piglin.id, name: "piglin", position: new Vec3(2, 64, 0) });
  assert.equal(watch.removed(), false);
});

test("an id the bot does not list reads removed at once", () => {
  const harness = createFakeBot();
  using watch = watchEntityRemoval(harness.bot, 999);
  assert.equal(watch.removed(), true);
});

test("dispose removes its listener, and twice is harmless", () => {
  const harness = createFakeBot();
  const { bot } = harness;
  const piglin = harness.entities.spawn({ name: "piglin", position: new Vec3(2, 64, 0) });
  const before = bot.listenerCount("entityGone");
  const watch = watchEntityRemoval(bot, piglin.id);
  assert.equal(bot.listenerCount("entityGone"), before + 1);
  watch[Symbol.dispose]();
  assert.equal(bot.listenerCount("entityGone"), before);
  watch[Symbol.dispose]();
  assert.equal(bot.listenerCount("entityGone"), before);
});

test("a signal armed after the watch settles at the removal", async () => {
  const harness = createFakeBot();
  const { bot } = harness;
  const piglin = harness.entities.spawn({ name: "piglin", position: new Vec3(2, 64, 0) });
  using watch = watchEntityRemoval(bot, piglin.id);
  const signal = armSignal(bot, "entityGone", () => watch.removed() || null, {});
  harness.entities.remove(piglin.id);
  assert.deepEqual(await signal.promise, { kind: "signalled", value: true });
});
