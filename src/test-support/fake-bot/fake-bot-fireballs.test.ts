/**
 * A fireball's reach is the server's: the fake server moves the ball each tick and tells the client rarely (2nd tick, then every
 * 10th), so the client's view of the ball is stale in between and a hit is judged on where the server has it
 * (`fake-bot-entity-reach.ts` `inEntityReach`; contract check `deflect-fireball`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeHarness, createFakeBot } from "./fake-bot.js";

const FEET = new Vec3(0.5, -60, 0.5);
const TICK_MS = 50;
/** The ball is 1 block wide; the reach is 6 from the eye to its box (`ENTITY_REACH`). */
const FAR_EAST = new Vec3(9.5, -59.1, 0.5);
const FLIES_WEST = new Vec3(-0.5, 0, 0);
const NEAR_EAST = new Vec3(4.5, -59.1, 0.5);
const FLIES_EAST = new Vec3(0.5, 0, 0);

function watcher(options: FakeBotOptions = {}): FakeHarness {
  const harness = createFakeBot({ position: FEET, ...options });
  harness.bot.entity.yaw = -Math.PI / 2;
  harness.bot.entity.pitch = 0;
  return harness;
}

/** The ball launched at `launchAt`, hit by the bot once the server has run `ticks` ticks of it; the clock runs one more tick for the answer. */
async function hitAfterTicks(harness: FakeHarness, launchAt: Vec3, motion: Vec3, ticks: number) {
  const ball = harness.combat.launchFireball(launchAt, motion);
  await harness.clock.advance(ticks * TICK_MS);
  harness.bot.attack(ball);
  await harness.clock.advance(TICK_MS);
  return ball;
}

test("a ball in reach on the server and out of reach on the client is deflected: the server judges the hit", async () => {
  const harness = watcher();
  const ball = await hitAfterTicks(harness, FAR_EAST, FLIES_WEST, 7);
  assert.ok(ball.position.x > 7.5, `the client was told of it at tick 2 only: ${ball.position.x}`);
  assert.ok(ball.velocity.x > 0, `the ball flies along the look: ${ball.velocity.x}; the server has it at ${harness.server.serverPositionOf(ball.id)?.x}`);
});

test("a ball in reach on the client only is not touched: the server has flown it away", async () => {
  const harness = watcher();
  const ball = await hitAfterTicks(harness, NEAR_EAST, FLIES_EAST, 6);
  assert.ok(ball.position.x < 6, `the client has it at ${ball.position.x}`);
  assert.ok(ball.velocity.x > 0 && ball.velocity.x < 1, `its velocity is the flight's, not the deflection's (1): ${ball.velocity.x}`);
  await harness.clock.advance(TICK_MS * 4);
  assert.ok((harness.server.serverPositionOf(ball.id)?.x ?? 0) > 8, "it flies on away from her");
});

test("a server lagging 200 ms judges the hit when it hears it: the ball sent at 3 ticks out of reach has come into reach by the 7th", async () => {
  const harness = watcher({ lagMs: 200 });
  const ball = harness.combat.launchFireball(FAR_EAST, FLIES_WEST);
  await harness.clock.advance(TICK_MS * 3);
  harness.bot.attack(ball);
  await harness.clock.advance(TICK_MS * 12);
  assert.equal(harness.bot.health, 20, "the hit turned the ball away before it met her");
  assert.ok(ball.velocity.x > 0, `deflected by the late hit: ${ball.velocity.x}`);
});

test("a ball that was removed and then hit is answered by nothing: no throw, and it does not reach her", async () => {
  const harness = watcher();
  const ball = harness.combat.launchFireball(NEAR_EAST, new Vec3(-0.5, 0, 0));
  await harness.clock.advance(TICK_MS * 3);
  harness.entities.remove(ball.id);
  assert.doesNotThrow(() => harness.bot.attack(ball));
  await harness.clock.advance(2_000);
  assert.equal(harness.bot.entities[ball.id], undefined);
  assert.equal(harness.bot.health, 20, "a removed ball flies no more");
});
