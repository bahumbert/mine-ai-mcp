import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { attackedIds, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { fightSwordAfter } from "../../test-support/swing-handoff.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { deflectFireball } from "./deflect.js";

/** A ghast fireball 3.7 blocks away flying at the bot: the server flies it (measured, `deflect-fireball`) and answers a hit in reach with the new heading along the bot's look. */
function fixture() {
  const harness = createFakeBot({ position: new Vec3(0.5, 0, 0) });
  const ball = harness.combat.launchFireball(new Vec3(4.17, 1.5, 0), new Vec3(-1.06, 0, 0));
  return { ...harness, ball, swings: () => attackedIds(harness.server).length };
}

for (const rate of [20, 10]) test(`a deflection leaves its recovery for the next fight sword at ${rate} tps`, async () => {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    slots: { 36: { name: "iron_sword" } },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 2.5) } },
  });
  const { bot, clock, server } = harness;
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  await clock.advance(4_000);
  const ball = harness.combat.launchFireball(new Vec3(4.17, 65.5, 0.5), new Vec3(-1.06, 0, 0));
  const start = server.gameTime;
  const result = await clock.settle(deflectFireball(bot, ball.id, new AbortController().signal), 1_000);
  assert.equal(result.kind, "reflected");
  await clock.advance(5_000 / rate - (clock.now() - 4_000));
  assert.equal(server.gameTime - start, 5);
  assert.equal(await clock.settle(fightSwordAfter(bot, 7), 5_000), true);
  assert.equal(server.gameTime - start, 13, "the fight waits thirteen server ticks from deflection");
  assert.deepEqual(attackedIds(server), [ball.id, 7]);
});
test("large incoming shots are threats; outbound shots, misses and blaze shots are not", () => {
  const { bot, ball } = fixture();
  assert.equal(incomingFireball(bot, 16)?.id, ball.id);
  ball.velocity.x = 1;
  assert.equal(incomingFireball(bot, 16), undefined);
  ball.velocity.x = -1;
  ball.position.z = 5;
  assert.equal(incomingFireball(bot, 16), undefined);
  ball.position.z = 0;
  ball.name = "small_fireball";
  assert.equal(incomingFireball(bot, 16), undefined);
});

test("a server update outside reach can require a swing before the next position packet", async () => {
  const { bot, clock, ball, swings } = fixture();
  const result = deflectFireball(bot, ball.id, new AbortController().signal);
  await clock.advance(100);
  assert.equal(swings(), 1);
  assert.equal((await result).kind, "reflected");
});

test("a swing followed by disappearance is not evidence of reflection", async () => {
  const { bot, clock, ball, swings, server, entities } = fixture();
  onAttack(server, () => entities.remove(ball.id));
  const result = deflectFireball(bot, ball.id, new AbortController().signal);
  await clock.advance(100);
  assert.equal(swings(), 1);
  assert.equal((await result).kind, "unobserved");
});

test("a cancel ends the wait for the next tick at once when physics has stopped, not at Mineflayer's 5 s tick timeout", async () => {
  const { bot, clock, ball } = fixture();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  const added = listenersAddedSince(bot);
  const stop = new AbortController();
  bot.physicsEnabled = false; // a death turns physics off (`physics.js:480`)
  clock.after(100, () => stop.abort(new Error("bot died")));
  await assert.rejects(clock.settle(deflectFireball(bot, ball.id, stop.signal), 1_000), /bot died/);
  assert.equal(added("physicsTick"), 0, "the aborted wait left no tick listener");
});

test("cancellation while aiming prevents a late swing", async () => {
  const { bot, ball, swings } = fixture();
  const stop = new AbortController();
  bot.lookAt = async () => {
    stop.abort(new Error("cancelled"));
  };
  await assert.rejects(deflectFireball(bot, ball.id, stop.signal), /cancelled/);
  assert.equal(swings(), 0);
});
