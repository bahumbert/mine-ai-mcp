import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { attackedIds, combatTestContext, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { fightSwordAfter } from "../../test-support/swing-handoff.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { swingReadiness } from "../weapons/swing-readiness.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { deflectFireball } from "./deflect.js";
import { responseScope } from "../control/combat/scopes/response.js";
import { contextPolicy } from "../control/combat/context.js";
import { secureCombatHandoff } from "../control/combat/handoff.js";
import { createNavigationRuntime, createMovements, exactBlockGoal } from "../../navigation/index.js";

for (const rate of [20, 10]) for (const row of [
  { name: "self only", mob: null, offset: 0, withheld: false },
  { name: "neutral Enderman 0.4 off-axis", mob: "enderman", offset: 0.4, withheld: true },
  { name: "provoked Enderman 0.4 off-axis", mob: "enderman", offset: 0.4, attacker: true, withheld: false },
  { name: "neutral Enderman 3 off-axis", mob: "enderman", offset: 3, withheld: false },
  { name: "hostile on the line", mob: "zombie", offset: 0, withheld: false },
  // Player width is 0.6 (minecraft-data 1.21.4): the inflated face is at 2.3, not 2.5.
  { name: "player 2.2 off-axis inside inflation", mob: "player", offset: 2.2, withheld: true },
  { name: "player 2.4 off-axis outside inflation", mob: "player", offset: 2.4, withheld: false },
  { name: "player face 0.1 before the 64-block endpoint", mob: "player", offset: 0, along: 67.7, withheld: true },
  { name: "player face 0.1 beyond the 64-block endpoint", mob: "player", offset: 0, along: 67.9, withheld: false },
]) test(`return line: ${row.name} at ${rate} tps`, async () => {
  const { bot, clock, combat, server, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    position: new Vec3(0.5, 64, 0.5), groundY: 63 });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  if (row.mob) entities.spawn({ id: 61, name: row.mob,
    position: new Vec3(0.5 + (row.along ?? 4.3), 64, 0.5 + row.offset) });
  const added = listenersAddedSince(bot);
  const ball = combat.launchFireball(new Vec3(2, 65.5, 0.5), new Vec3(-0.2, 0, 0));
  const started = server.gameTime;
  const knowledge = { resolvedIds: new Set<number>(), attackerIds: new Set("attacker" in row ? [61] : []) };
  const result = await clock.settle(deflectFireball(bot, ball.id, new AbortController().signal, knowledge), 1_000);
  assert.equal(result.kind, row.withheld ? "withheld" : "reflected");
  assert.equal(result.attacks, row.withheld ? 0 : 1);
  assert.deepEqual(attackedIds(server), row.withheld ? [] : [ball.id]);
  assert.equal(server.gameTime - started, row.withheld || rate === 10 ? 0 : 1);
  assert.equal(clock.now(), row.withheld ? 0 : 50, "the client sees the immediate reversal at its next look");
  if (row.withheld) assert.equal(result.observation, `Deflection withheld: ${row.mob}#61 stands on the return line.`);
  assert.equal(added("physicsTick"), 0);
  entities.remove(ball.id);
  await clock.advance(5_000);
  assert.deepEqual(attackedIds(server), row.withheld ? [] : [ball.id]);
});

test("a stopped server still withholds immediately without leaving a wait or a control", async () => {
  const { bot, clock, server, combat, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
  using _timers = clock.install();
  entities.spawn({ id: 61, name: "enderman", position: bot.entity.position.offset(4.3, 0, 0.4) });
  const ball = combat.launchFireball(bot.entity.position.offset(1.5, 1.5, 0), new Vec3(-0.2, 0, 0));
  server.stop();
  const added = listenersAddedSince(bot);
  const stop = new AbortController();
  const pending = deflectFireball(bot, ball.id, stop.signal);
  try {
    const result = await clock.settle(pending, 1_000);
    assert.equal(result.kind, "withheld");
    assert.equal(clock.now(), 0);
    assert.deepEqual(attackedIds(server), []);
  } finally {
    stop.abort(new Error("retire stopped-server proof"));
    await pending.catch(() => {});
  }
  await clock.advance(50_000, 1_000);
  assert.equal(added("physicsTick"), 0);
  assert.ok(Object.values(bot.controlState).every((held) => !held));
});

for (const rate of [20, 10]) for (const cancel of [false, true])
test(`withheld handoff ${cancel ? "cancels" : "evades then navigates"} at ${rate} tps`, async () => {
  const { bot, clock, combat, entities, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }),
    simulatePhysics: true, server: { ticksPerSecond: rate }, position: new Vec3(0.5, 64, 0.5), groundY: 63 });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  const runtimeNavigation = createNavigationRuntime(bot);
  const navigate = runtimeNavigation.navigate.bind(runtimeNavigation);
  const navigation = { ...runtimeNavigation, navigate };
  const context = combatTestContext(bot);
  const added = listenersAddedSince(bot);
  const clientAdded = listenersAddedSince(bot._client);
  const stop = new AbortController();
  entities.spawn({ id: 61, name: "enderman", position: new Vec3(4.8, 64, 0.9) });
  const ball = combat.launchFireball(new Vec3(2, 65.5, 0.5), new Vec3(-0.2, 0, 0));
  const decisions: unknown[] = [];
  let routes = 0;
  navigation.navigate = async ({ signal }) => {
    routes++;
    if (cancel) {
      stop.abort(new Error("cancel during handoff"));
      signal?.throwIfAborted();
    }
    if (bot.entities[ball.id]) entities.remove(ball.id);
    return { status: "completed", elapsedMs: 0 };
  };
  const pending = secureCombatHandoff(bot, navigation, context, stop.signal, (evidence) => decisions.push(evidence));
  if (cancel) await assert.rejects(clock.settle(pending, 5_000), /cancel during handoff/);
  else {
    assert.equal((await clock.settle(pending, 5_000)).kind, "safe");
  }
  const scope = responseScope(bot, contextPolicy(context), "deflect", ball.id);
  assert.deepEqual(context.survival.answered.find(scope.capability, scope.scope)?.failure,
    { kind: "deflection_unobserved", why: "Deflection withheld: enderman#61 stands on the return line." });
  assert.equal(context.survival.answered.find(scope.capability, `target:${ball.id + 1}`), null);
  assert.ok(routes > 0, JSON.stringify(decisions));
  for (const event of ["physicsTick", "time", "entityGone", "entityDead"]) assert.equal(added(event), 0, event);
  assert.equal(clientAdded("explosion"), 0);
  assert.ok(Object.values(bot.controlState).every((held) => !held));
  if (bot.entities[ball.id]) entities.remove(ball.id);
  assert.equal((await clock.settle(navigate({ goal: exactBlockGoal({ x: 0, y: 64, z: -1 }),
    movements: createMovements(bot, { allowDigging: false, scaffolding: false }) }), 5_000)).status, "completed");
  await clock.settle(runtimeNavigation.close(), 1_000);
  const attacks = attackedIds(server);
  await clock.advance(50_000, 1_000);
  assert.deepEqual(attackedIds(server), attacks);
});

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
