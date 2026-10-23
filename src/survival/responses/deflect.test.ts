import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { onAttack } from "../../test-support/combat.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { deflectFireball } from "./deflect.js";

/** A ghast fireball 3.7 blocks away flying at the bot; the server answers a swing with `onHit` (a reversal by default). */
function fixture() {
  let swings = 0;
  let onHit = () => {
    ball.velocity.x = 1;
  };
  const harness = createFakeBot({
    position: new Vec3(0.5, 0, 0),
    entities: { 2: { name: "fireball", position: new Vec3(4.17, 1.5, 0), velocity: new Vec3(-1.06, 0, 0) } },
  });
  // Not on the shared fake: a hit on a projectile (no check measured a deflection). The test's server answers each swing it receives with `onHit`. Asked of the master: a contract check for the deflection.
  onAttack(harness.server, () => {
    swings += 1;
    harness.server.answer(() => onHit());
  });
  const ball = harness.bot.entities[2]!;
  return {
    ...harness,
    ball,
    swings: () => swings,
    answerHitWith: (answer: () => void) => {
      onHit = answer;
    },
  };
}

test("large incoming shots are threats; outbound shots, misses and blaze shots are not", () => {
  const { bot, ball } = fixture();
  assert.equal(incomingFireball(bot, 16)?.id, 2);
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
  const { bot, clock, swings } = fixture();
  const result = deflectFireball(bot, 2, new AbortController().signal);
  await clock.advance(100);
  assert.equal(swings(), 1);
  assert.equal((await result).kind, "reflected");
});

test("a swing followed by disappearance is not evidence of reflection", async () => {
  const { bot, clock, ball, swings, answerHitWith } = fixture();
  answerHitWith(() => {
    ball.isValid = false;
  });
  const result = deflectFireball(bot, 2, new AbortController().signal);
  await clock.advance(100);
  assert.equal(swings(), 1);
  assert.equal((await result).kind, "unobserved");
});

test("cancellation while aiming prevents a late swing", async () => {
  const { bot, swings } = fixture();
  const stop = new AbortController();
  bot.lookAt = async () => {
    stop.abort(new Error("cancelled"));
  };
  await assert.rejects(deflectFireball(bot, 2, stop.signal), /cancelled/);
  assert.equal(swings(), 0);
});
