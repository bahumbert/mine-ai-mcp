import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { attackedIds, onAttack } from "../../test-support/combat.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { deflectFireball } from "./deflect.js";

/** A ghast fireball 3.7 blocks away flying at the bot: the server flies it (measured, `deflect-fireball`) and answers a hit in reach with the new heading along the bot's look. */
function fixture() {
  const harness = createFakeBot({ position: new Vec3(0.5, 0, 0) });
  const ball = harness.combat.launchFireball(new Vec3(4.17, 1.5, 0), new Vec3(-1.06, 0, 0));
  return { ...harness, ball, swings: () => attackedIds(harness.server).length };
}
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

test("cancellation while aiming prevents a late swing", async () => {
  const { bot, ball, swings } = fixture();
  const stop = new AbortController();
  bot.lookAt = async () => {
    stop.abort(new Error("cancelled"));
  };
  await assert.rejects(deflectFireball(bot, ball.id, stop.signal), /cancelled/);
  assert.equal(swings(), 0);
});
