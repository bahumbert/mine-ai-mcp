import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { isWindingUp } from "../perception/combat/observations.js";
import { observeProjectileDefence } from "./shield-facing.js";
import { incomingShieldProjectiles } from "../perception/combat/shield-projectiles.js";
import { createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";

// Metadata is indexed exactly as the shared 1.21.4 registry indexes it: a
// fixture must never write to that registry, which every fake bot shares.
/** Blaze charge sits in the `flags` byte at sixteen. */
const charging = () => { const m: unknown[] = []; m[16] = 1; return m; };
/** A drawn bow sets bit one of `living_entity_flags` at eight. */
const drawing = () => { const m: unknown[] = []; m[8] = 1; return m; };

/** A shooter nine blocks out over open ground, facing the bot, with a clear line between them. */
function shooterFixture(name: string, held: string | null, metadata: unknown[]) {
  const { bot } = createFakeBot({
    position: new Vec3(0, 64, 0),
    entities: {
      21: {
        name,
        width: 0.6, height: 1.8, eyeHeight: 1.6,
        position: new Vec3(0, 64, 9),
        // Facing the bot: yaw zero looks down -z, from +z toward the origin.
        yaw: 0, headYaw: 0, pitch: 0,
        metadata,
      },
    },
  });
  const shooter = bot.entities[21]!;
  // The main hand the server shows of a mob (`entity_equipment`), which `heldItem` reads.
  if (held) shooter.equipment[0] = itemOf(bot.registry, held);
  return { bot, shooter };
}

test("a charging blaze raises the same projectile defence a drawing skeleton does", () => {
  // A blaze mid-charge, nine blocks out with a clear line: the shot is coming.
  const blaze = shooterFixture("blaze", null, charging());
  assert.equal(isWindingUp(blaze.bot, blaze.shooter), true, "perception sees the charge");
  assert.notEqual(
    observeProjectileDefence(blaze.bot, 0, 1000), null,
    "the guard trigger sees the same charge, because it asks perception rather than for a bow",
  );

  // The same situation with a bow holder is seen, which is why skeletons guard.
  const skeleton = shooterFixture("skeleton", "bow", drawing());
  assert.notEqual(
    observeProjectileDefence(skeleton.bot, 0, 1000), null,
    "a drawn bow does raise the defence",
  );
});

for (const ticksPerSecond of [20, 10]) {
  test(`an observed fireball keeps priority over opposite uncertain charges (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    // t00699 client.log, ages 279/299: native fireball #7's packet observations.
    // Opposing charge flags replay t00365:1779/1789; no acceleration is simulated.
    const { bot, entities } = createFakeBot({ clock, server: { ticksPerSecond }, groundY: null,
      position: new Vec3(-7.524897961090669, -60, 4.500157425151781),
      entities: {
        3: { name: "blaze", position: new Vec3(5.903960617580779, -60, 1.9367159803515928), yaw: Math.PI / 2, headYaw: Math.PI / 2, metadata: charging() },
        4: { name: "blaze", position: new Vec3(-28.362060546875, -60, 2.38818359375),
          yaw: -Math.PI / 2, headYaw: -Math.PI / 2, metadata: charging() },
      } });
    const added = listenersAddedSince(bot);
    const shot = entities.spawn({ name: "small_fireball",
      position: new Vec3(-28.362015862629868, -58.60000002384186, 2.3882521086609043),
      velocity: new Vec3(0.09925, 0, 0.0115) });
    const defence = observeProjectileDefence(bot)!;
    const direction = shot.position.minus(bot.entity.position); direction.y = 0;
    const aim = defence.facing.minus(bot.entity.position); aim.y = 0;
    assert.ok(aim.normalize().dot(direction.normalize()) >= Math.cos(70 * Math.PI / 180),
      "the incoming fireball stays inside the guard cone instead of the opposing charge");
    assert.deepEqual(incomingShieldProjectiles(bot), [shot], "admission keeps the observed shot");
    assert.equal(defence.projectiles[0]!.impactInTicks, null, "direction alone gives no acceleration-aware deadline");
    assert.ok(defence.windupForecasts.every(({ releaseInTicks, impactInTicks }) =>
      releaseInTicks === null && impactInTicks === null), "a blaze charge has no fabricated bow-flight ETA");
    await bot.lookAt(defence.facing, true);
    assert.equal(observeProjectileDefence(bot)!.aligned, true);
    assert.equal(observeProjectileDefence(bot)!.imminent, true);
    shot.position.set(-27.899613518879868, -58.60000002384186, 2.4422071867859043);
    shot.velocity.set(0.273625, 0, 0.03175);
    const updated = observeProjectileDefence(bot)!;
    assert.equal(updated.projectiles[0]!.impactInTicks, null);
    assert.ok(updated.facing.x < bot.entity.position.x, "the next measured velocity keeps the incoming side covered");
    entities.remove(shot.id);
    for (const id of [3, 4]) entities.remove(id);
    assert.equal(observeProjectileDefence(bot), null, "departure releases aim with no held non-arrow heading");
    await clock.advance(60_000);
    assert.equal(observeProjectileDefence(bot), null);
    assert.equal(added("physicsTick"), 0);
    assert.equal(clock.pendingTimers(), 0);
  });
}
