import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeWorld, createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { projectileReachesBody } from "../../positioning/combat/exposure.js";
import { confirmShieldBlock, observeProjectileDefence, projectileShieldFacing } from "../../weapons/shield-facing.js";
import { CombatPerception } from "./observations.js";
import { arrowImpact, arrowImpactInTicks, incomingShieldProjectiles, isIncomingArrow } from "./shield-projectiles.js";

/**
 * A bot in open air with arrow #8 flying at it; `later` arrows exist but the bot has not seen them yet: `arrive(id)`
 * announces one, at its position and velocity.
 */
function fixture(later: Record<number, { position: Vec3; velocity: Vec3 }> = {}) {
  const { bot, world } = createFakeBot({
    position: { x: 0, y: 64, z: 0 },
    groundY: null,
    entities: {
      8: { name: "arrow", position: { x: 0, y: 67.3, z: 8 } },
      ...Object.fromEntries(Object.entries(later).map(([id, { position }]) => [id, { name: "arrow", position }])),
    },
  });
  const arrow = bot.entities[8]!;
  arrow.velocity.set(0, 0, -1);
  const unseen = new Map(Object.entries(later).map(([id, { velocity }]) => {
    const entity = bot.entities[Number(id)]!;
    entity.velocity.set(velocity.x, velocity.y, velocity.z);
    delete bot.entities[Number(id)];
    return [Number(id), entity];
  }));
  const arrive = (id: number) => (bot.entities[id] = unseen.get(id)!);
  return { bot, world, arrow, arrive };
}

/** Stone across x -1..1 at `z`, `ys` high: what the line from the bot to something beyond it now meets. */
function wallAt(world: FakeWorld, z: number, ys: readonly number[], block = "stone"): void {
  for (const x of [-1, 0, 1]) for (const y of ys) world.setCell(new Vec3(x, y, z), block);
}

test("a reflected arrow inside the hit margin cannot reacquire guard", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 65, 0.4);
  arrow.velocity.set(0, 0, -1);
  assert.equal(observeProjectileDefence(bot, 0, 1000)!.heldProjectileId, arrow.id);
  arrow.velocity.set(0, 0, 0.1);
  assert.equal(isIncomingArrow(bot, arrow), false);
  confirmShieldBlock(bot);
  assert.equal(observeProjectileDefence(bot, 0, 1001), null, "confirmed contact needs no estimated grace");
});

test("contacts two ticks apart share a protective heading, including a newly observed second shot", () => {
  for (const arrivesLater of [false, true]) {
    const angle = 134 * Math.PI / 180;
    const direction = new Vec3(Math.sin(angle), 0, Math.cos(angle));
    const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(0, 65, 0).plus(direction.scaled(3)), velocity: direction.scaled(-1) } });
    arrow.position.set(0, 65, 1.4);
    if (arrivesLater) observeProjectileDefence(bot, 0, 1000);
    arrive(9);
    const defence = observeProjectileDefence(bot, 0, 1001)!;
    assert.equal(defence.projectiles[0]!.impactInTicks, 1);
    assert.equal(defence.projectiles[1]!.impactInTicks, 3);
    const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0)).normalize();
    for (const shot of defence.projectiles) {
      const bearing = shot.contact.minus(bot.entity.position); bearing.y = 0;
      assert.ok(heading.dot(bearing.normalize()) >= Math.cos(70 * Math.PI / 180));
    }
  }
});

test("grazing arrow guard uses the collision bearing and retains it through estimated contact", () => {
  const { bot, arrow } = fixture();
  // Server probe attempt 15: the arrow crossed the bot's front during its
  // last movement segment. Facing its earlier position exposed the contact.
  bot.entity.position.set(2.7194334786, -60, -4.6995768174);
  arrow.position.set(3.1257581415, -58.9264723955, -3.6741039384);
  arrow.velocity.set(-1.361514457, -0.275710276, -0.629843159);
  const impact = arrowImpact(bot, arrow)!;
  assert.equal(impact.ticks, 1);
  assert.ok(impact.position.x < bot.entity.position.x, "collision is on the opposite side from the old arrow position");
  const defence = observeProjectileDefence(bot, 0, 1000)!;
  const heading = defence.facing.minus(bot.entity.position.offset(0, 1.62, 0));
  assert.ok(heading.x < 0 && heading.z > 0);
  assert.equal(defence.heldProjectileId, arrow.id);
  arrow.position.set(1, -60, -5); // locally predicted past the body, before confirmation
  assert.deepEqual(observeProjectileDefence(bot, 0, 1050)!.facing, defence.facing);
  assert.equal(observeProjectileDefence(bot, 0, 1200), null, "the impact window is bounded");
});

test("a new incoming arrow can replace the grace window of a shot that has passed", () => {
  const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(0, 65, -2), velocity: new Vec3(0, 0, 1) } });
  arrow.position.set(0, 65, 2);
  const first = observeProjectileDefence(bot, 0, 1000)!;
  assert.equal(first.heldProjectileId, arrow.id);
  arrow.position.set(0, 65, -3);
  arrive(9);
  const defence = observeProjectileDefence(bot, 0, 1050)!;
  assert.equal(defence.heldProjectileId, 9);
  assert.ok(defence.facing.z < bot.entity.position.z);
});

test("retreat and shield facing detect an arrow which falls into the body below its original ray", () => {
  const { bot, arrow } = fixture();
  assert.equal(projectileReachesBody(bot.world, arrow, bot.entity), false);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.deepEqual(incomingShieldProjectiles(bot), [arrow]);
  assert.ok(projectileShieldFacing(bot)!.z > 0);
});

test("one defensive assessment orders impacts and covers shots independently of the quarry", () => {
  const { bot, arrow, arrive } = fixture({ 9: { position: new Vec3(8, 65, 0), velocity: new Vec3(-1.5, 0, 0) } });
  bot.entity.yaw = 0;
  arrive(9);
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles[0]!.entity.id, 9);
  assert.equal(defence.coversAll, true);
  assert.equal(defence.aligned, false);
  assert.equal(defence.imminent, true);
  assert.ok(defence.facing.x > 0 && defence.facing.z > 0);
  assert.equal(arrowImpactInTicks(bot, arrow), 8);
  assert.equal(isIncomingArrow(bot, arrow, 0, { ...bot.entity, position: new Vec3(30, 64, 0) }), false,
    "a projectile threatening the current body does not invalidate distant protected cover");
});

test("an aimed bow draw contributes defensive facing before its arrow exists", () => {
  const { bot, world, arrow: shooter } = fixture();
  shooter.name = "skeleton";
  shooter.kind = "Hostile mobs";
  shooter.height = 1.99;
  shooter.position.set(0, 64, 8);
  shooter.pitch = 0;
  Reflect.set(shooter, "headYaw", 0);
  shooter.setEquipment(0, itemOf(bot.registry, "bow"));
  Reflect.set(shooter.metadata, 8, 1);
  bot.entity.yaw = -Math.PI / 2;
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.projectiles.length, 0);
  assert.deepEqual(defence.windingUp.map((entity) => entity.id), [8]);
  assert.equal(defence.aligned, false);
  assert.ok(defence.facing.z > bot.entity.position.z);
  wallAt(world, 4, [64, 65, 66]);
  assert.equal(observeProjectileDefence(bot), null, "a draw flag behind cover must not retain guard");
  wallAt(world, 4, [64, 65, 66], "air");
  assert.ok(observeProjectileDefence(bot), "restored sight makes the ongoing draw a threat again");
  Reflect.set(shooter, "headYaw", Math.PI);
  assert.equal(observeProjectileDefence(bot), null, "drawing toward someone else is not our guard cue");
});

test("opposed shots admit the best achievable heading without demanding impossible coverage", () => {
  const { bot, arrive } = fixture({ 9: { position: new Vec3(0, 65, -8), velocity: new Vec3(0, 0, 1) } });
  arrive(9);
  const defence = observeProjectileDefence(bot)!;
  assert.equal(defence.coversAll, false);
  const direction = defence.facing.minus(bot.entity.position);
  bot.entity.yaw = Math.atan2(-direction.x, -direction.z);
  assert.equal(observeProjectileDefence(bot)!.aligned, true);
});

test("arrows that pass, hit terrain, or remain embedded cannot retain the retreat guard", () => {
  const { bot, world, arrow } = fixture();
  arrow.velocity.z = 1;
  assert.equal(isIncomingArrow(bot, arrow), false);
  arrow.velocity.z = -1;
  wallAt(world, 4, [66, 67]);
  assert.equal(isIncomingArrow(bot, arrow), false);
  wallAt(world, 4, [66, 67], "air");
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("in_ground"), true);
  assert.equal(isIncomingArrow(bot, arrow), false, "embedded arrows can retain stale velocity");
});

test("movement allowance warns before crossing an arrow; stationary facing still prioritises an actual hit", () => {
  const { bot, arrive } = fixture({ 9: { position: new Vec3(-2.2, 65, 2), velocity: new Vec3(0, 0, -1) } });
  const miss = arrive(9);
  assert.equal(isIncomingArrow(bot, miss), false);
  assert.equal(isIncomingArrow(bot, miss, 2), true);
  assert.ok(projectileShieldFacing(bot, 2)!.z > 0);
});

test("a piercing arrow cannot be answered by the shield guard", () => {
  const { bot, arrow } = fixture();
  Reflect.set(arrow.metadata, bot.registry.entitiesByName.arrow!.metadataKeys!.indexOf("pierce_level"), 1);
  assert.deepEqual(incomingShieldProjectiles(bot), []);
});

test("a vertical arrow with a zero-speed apex still falls into the body", () => {
  const { bot, arrow } = fixture();
  arrow.position.set(0, 67, 0);
  arrow.velocity.set(0, 0.05 / 0.99, 0);
  const raycast = bot.world.raycast;
  bot.world.raycast = (origin, direction, range) => {
    assert.ok(Number.isFinite(direction.x) && Number.isFinite(direction.y) && Number.isFinite(direction.z));
    return raycast(origin, direction, range);
  };
  assert.equal(isIncomingArrow(bot, arrow), true);
});

test("perception retains native arrow spawn velocity for immediate guarding and releases its listeners", () => {
  const { bot, arrow } = fixture();
  arrow.velocity.set(0, 0, 0);
  const before = bot._client.listenerCount("spawn_entity");
  const perception = new CombatPerception(bot);
  assert.equal(isIncomingArrow(bot, arrow), false);
  bot._client.emit("spawn_entity", {
    entityId: arrow.id,
    type: bot.registry.entitiesByName.arrow!.id,
    objectData: 123,
    velocity: { x: 0, y: 0, z: -8000 },
  });
  assert.equal(arrow.velocity.z, -1);
  assert.equal(isIncomingArrow(bot, arrow), true);
  assert.equal(perception.attackerIds.size, 0, "do not guess an arrow owner from an unverified packet field");
  perception[Symbol.dispose]();
  assert.equal(bot._client.listenerCount("spawn_entity"), before);
});
