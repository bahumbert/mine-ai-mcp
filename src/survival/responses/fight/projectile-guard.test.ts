import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Vec3 } from "vec3";
import type { Item } from "prismarine-item";
import { type FakeBot, type FakeClock, createFakeBot, createFakeClock, flush } from "../../../test-support/fake-bot/index.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { trackArrowFlights } from "../../perception/combat/arrow-flight.js";
import { confirmShieldBlock, observeProjectileDefence } from "../../weapons/shield-facing.js";
import { listenersAddedSince } from "../../../test-support/fake-bot/index.js";

for (const rate of [20, 10]) for (const exit of ["clear", "abort", "death", "gone"])
for (const stage of exit === "clear" ? ["guard"] : ["guard", "draw"])
test(`late-hit replay keeps protection then permits the next draw: ${rate} tps ${exit} during ${stage}`, async () => {
  const { bot, clock, server, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    groundY: null, position: new Vec3(0, 64, 0), carried: { bow: 1, arrow: 4 }, slots: { 45: { name: "shield" } },
    entities: { 7: { name: "zombie", position: new Vec3(0, 64, 12) }, 8: { name: "arrow", position: new Vec3(0, 65, 10), velocity: new Vec3(0, 0, -1.7) } } });
  using _timers = clock.install();
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const pace = serverTickPace(bot);
  await clock.advance(4_000);
  const tracker = trackArrowFlights(bot);
  bot._client.emit("spawn_entity", { entityId: 8 });
  const stop = new AbortController();
  const scene = { bot, target: bot.entities[7]!, perception: { read: () => [] }, signal: stop.signal,
    dead: new Set<number>(), attacks: 0, projectileGuards: 0, footingRecovery: { needed: false },
    settled: () => bot.health <= 0 || !scene.target.isValid,
    policy: { combat: { shield: true, volley_wait_ticks: 100 } }, reportDecision: () => {},
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect(), progress: { volleyFinished: () => {} } },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const shield = bot.inventory.slots[45]!;
  Object.assign(weapons, { currentLoadout: () => ({ shield }), hasClearShot: () => true, aimBow: async () => true });
  weapons.itemUse.activateShield();
  const gameTime = server.gameTime, age = bot.time.age;
  const pending = (async () => {
    const guarded = await weapons.guardRangedAttack();
    return guarded === "volley_finished" ? weapons.shoot(shield) : guarded;
  })();
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await clock.advance(6_000 / rate);
  assert.equal(server.gameTime - gameTime, 6);
  assert.equal(bot.time.age, age);
  assert.equal(weapons.itemUse.shieldRaised, true);
  assert.equal(weapons.itemUse.drawingBow, false, "guard cannot drop before the scripted late impact");
  assert.equal(weapons.bowWindow(20).safe, false, "missing position packets cannot manufacture clearance");
  if (stage === "draw") {
    entities.remove(8); confirmShieldBlock(bot);
    await clock.advance(200);
    assert.equal(weapons.itemUse.drawingBow, true);
  }
  if (exit === "abort") stop.abort(new Error("guard aborted"));
  if (exit === "death") bot.health = 0;
  if (exit === "gone") entities.remove(7);
  if (stage === "guard") entities.remove(8);
  confirmShieldBlock(bot); // Scripted authoritative clearance input, not simulated arrow damage.
  const result = await clock.settle(outcome, 6_000);
  if (exit === "abort") assert.match(String("error" in result ? result.error : ""), /guard aborted/);
  else assert.equal("value" in result ? result.value : null, exit === "clear" ? "shot" : "fight_ended");
  if (exit !== "clear") {
    bot.health = 20;
    if (exit !== "gone") entities.remove(7);
    Object.assign(scene, { signal: new AbortController().signal, target: entities.spawn({ id: 7, name: "zombie", position: new Vec3(0, 64, 12) }) });
    assert.equal(await clock.settle(weapons.shoot(shield), 6_000), "shot", "the next clear draw releases normally");
  }
  assert.equal(scene.attacks, 1);
  weapons.itemUse.lowerShield(); tracker[Symbol.dispose](); pace[Symbol.dispose](); weapons.readiness[Symbol.dispose]();
  const attacks = scene.attacks;
  const releases = server.packets.filter(packet => packet.name === "block_dig" && (packet.data as { status: number }).status === 5).length;
  await clock.advance(10_000);
  assert.equal(scene.attacks, attacks);
  assert.equal(server.packets.filter(packet => packet.name === "block_dig" && (packet.data as { status: number }).status === 5).length, releases);
  assert.equal(weapons.itemUse.drawingBow, false);
  for (const event of ["time", "physicsTick", "entitySpawn", "respawn", "heldItemChanged", "mount", "dismount", "death", "end"]) assert.equal(added(event), 0, event);
  for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"]) assert.equal(packets(event), 0, event);
});

for (const [from, to] of [[20, 10], [10, 20]]) test(`cadence ${from}->${to} never opens across possible contact`, async () => {
  const { bot, clock, server, entities } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: from },
    groundY: null, position: new Vec3(0, 64, 0) });
  using _timers = clock.install();
  const added = listenersAddedSince(bot), packets = listenersAddedSince(bot._client);
  const pace = serverTickPace(bot);
  await clock.advance(4_000);
  const flights = trackArrowFlights(bot);
  const arrow = entities.spawn({ id: 8, name: "arrow", position: new Vec3(0, 65, 10), velocity: new Vec3(0, 0, -1.7) });
  bot._client.emit("spawn_entity", { entityId: 8 });
  server.setTickRate(to);
  const scene = { bot, target: { id: 7 }, perception: { read: () => [] } } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  for (const ms of [350, 2_000]) {
    await clock.advance(ms);
    assert.equal(weapons.bowWindow(20).safe, false, `at clock ${clock.now()}, world ${server.gameTime}, cached ${bot.time.age}`);
  }
  server.stop();
  const age = bot.time.age, gameTime = server.gameTime;
  await clock.advance(6_000);
  assert.equal(server.gameTime, gameTime); assert.equal(bot.time.age, age);
  assert.equal(weapons.bowWindow(20).safe, false);
  arrow.position.set(20, 65, 20); arrow.velocity.set(1, 0, 0);
  bot._client.emit("sync_entity_position", { entityId: 8 }); confirmShieldBlock(bot);
  assert.equal(observeProjectileDefence(bot), null, "a confirmed correction proves clearance");
  flights[Symbol.dispose](); pace[Symbol.dispose](); weapons.readiness[Symbol.dispose]();
  await clock.advance(10_000);
  assert.equal(observeProjectileDefence(bot), null, "cleanup cannot revive a held contact");
  serverTickPace(bot)[Symbol.dispose](); // The inspection above lazily owns a new pace observer.
  for (const event of ["time", "physicsTick", "entitySpawn", "respawn", "heldItemChanged", "mount", "dismount", "death", "end"]) assert.equal(added(event), 0, event);
  for (const event of ["spawn_entity", "entity_velocity", "rel_entity_move", "entity_move_look", "entity_teleport", "sync_entity_position", "entity_destroy"]) assert.equal(packets(event), 0, event);
});

/** Run `action` while the clock turns one physics tick at a time, until it settles; its outcome is returned as it came. */
async function drive<T>(clock: FakeClock, action: Promise<T>): Promise<T> {
  let settled = false;
  action.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  for (let tick = 0; tick < 2_000 && !settled; tick++) await clock.advance(50);
  return action;
}

for (const permitted of [true, false]) test(`broken guard ${permitted ? "equips a spare and restarts readiness" : "respects disabled shields"}`, async () => {
  const { bot, clock, inventory, server } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), slots: { 45: { name: "shield" } }, carried: { shield: 1 } });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(2_000);
  const spare = bot.inventory.items()[0]!;
  let equipped = 0, readiness = 0;
  const equip = bot.equip.bind(bot);
  bot.equip = async (item, destination) => {
    assert.equal(item, spare); assert.equal(destination, "off-hand");
    await equip(item, destination); equipped++;
  };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    policy: { combat: { shield: permitted } }, reportDecision: () => {}, settled: () => false,
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { currentLoadout: () => ({ shield: spare }), holdFacing: async (ticks: number) => {
    await waitForPhysicsTicks(bot, ticks, scene.signal); readiness += ticks;
  } });
  weapons.itemUse.activateShield();
  (inventory.updateSlot as (slot: number, item: Item | null) => void).call(inventory, 45, null);
  await clock.settle(weapons.maintainGuard(), 4_000);
  assert.equal(equipped, permitted ? 1 : 0);
  assert.equal(readiness, permitted ? 5 : 0);
  assert.equal(server.packets.filter(({ name }) => name === "use_item").length, permitted ? 2 : 1);
  assert.equal(weapons.itemUse.shieldRaised, permitted);
  await weapons.maintainGuard();
  assert.equal(equipped, permitted ? 1 : 0, "do not repeatedly equip a healthy guard");
});

test("guard aim is applied before the same tick's movement send and respects movement ownership", () => {
  const { bot } = createFakeBot();
  let phase = "guard";
  const controller = new AbortController();
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: controller.signal,
    execution: { snapshot: () => ({ phase }) }, footingRecovery: { needed: false },
    responseRequired: controller, reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  // A point one block east of the eye: a forced look turns the body to -π/2.
  Object.assign(weapons, { projectileDefence: () => ({ facing: bot.entity.position.offset(1, 1.62, 0) }) });
  weapons.itemUse.activateShield();
  bot.on("physicsTick", weapons.aimGuardBeforeMovement);
  bot.entity.yaw = 0;
  bot.emit("physicsTick");
  assert.equal(bot.entity.yaw, -Math.PI / 2, "rotation is ready before any promise continuation");
  for (phase of ["approach", "recover_footing", "release", "shoot"]) {
    bot.entity.yaw = 0;
    bot.emit("physicsTick");
    assert.equal(bot.entity.yaw, 0, `${phase} owns its own aim`);
  }
  phase = "guard";
  controller.abort();
  bot.emit("physicsTick");
  assert.equal(bot.entity.yaw, 0);
});

for (const abort of [false, true]) test(`terminal volley preserves guard after target death${abort ? " and remains cancellable" : " until the arrow clears"}`, async () => {
  const { bot, clock, entities } = createFakeBot({ slots: { 45: { name: "shield" } }, position: new Vec3(0, 64, 0),
    entities: { 9: { name: "arrow", position: new Vec3(0, 67.3, 8), velocity: new Vec3(0, 0, -1), metadata: [] } } });
  bot.world.raycast = () => null;
  const arrow = bot.entities[9]!;
  const controller = new AbortController();
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: controller.signal,
    responsiveness: { checkpoint: async () => {} },
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
    settled: () => true, footingRecovery: { needed: false },
    policy: { combat: { shield: true, critical_health: 6, volley_wait_ticks: 100 } }, reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  await drive(clock, weapons.itemUse.raiseShield());
  let ticks = 0;
  const onTick = () => {
    assert.equal(weapons.itemUse.shieldRaised, true);
    if (++ticks === 3) {
      if (abort) controller.abort(new Error("survival takeover"));
      else entities.remove(arrow.id);
    }
  };
  bot.on("physicsTick", onTick);
  try {
    if (abort) await drive(clock, assert.rejects(weapons.guardFinalVolley(), /survival takeover/));
    else await drive(clock, weapons.guardFinalVolley());
    assert.equal(ticks, 3);
    assert.equal(weapons.itemUse.shieldRaised, true, "only the normal release owns shield cleanup");
  } finally { bot.off("physicsTick", onTick); }
});

/**
 * A server whose physics ticks come every `tickMs` (the fake's own come every 50 ms): the clock moves `tickMs`, then the
 * bot ticks once, until `action` settles. Returns its outcome, the clock time it took and the ticks it saw.
 */
async function driveTicksOf<T>(
  { bot, clock }: { bot: FakeBot; clock: FakeClock },
  tickMs: number,
  action: Promise<T>,
  /** False: physics stopped (an unloaded chunk): the clock moves and no tick comes. */
  emitTicks = true,
): Promise<{ outcome: T; ms: number; ticks: number }> {
  let settled = false;
  action.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  const start = clock.now();
  let ticks = 0;
  for (; ticks < 1_000 && !settled; ticks++) {
    await clock.advance(tickMs, tickMs);
    if (emitTicks) bot.emit("physicsTick");
    await flush();
  }
  return { outcome: await action, ms: clock.now() - start, ticks };
}

const SLOW_TICK_MS = 200;

/** Weapons over a stub scene on a mocked clock (installed by the caller before this runs), with the volley budget of the policy. */
function slowWeapons(options: { volleyTicks: number; shield?: boolean }) {
  const mocked = createFakeClock({ mode: "mocked" });
  const installed = mocked.install();
  const { bot, clock } = createFakeBot({ clock: mocked, slots: { 45: { name: "shield" } }, position: new Vec3(0, 64, 0),
    entities: { 9: { name: "arrow", position: new Vec3(0, 67.3, 8), velocity: new Vec3(0, 0, -1), metadata: [] } } });
  bot.world.raycast = () => null;
  // The test sends every tick itself, at the pace of the slow server it stands for.
  bot.physicsEnabled = false;
  bot.lookAt = async () => {};
  const progress = { volleyFinished: () => {} };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    responsiveness: { checkpoint: async () => {} },
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect(), progress },
    projectileGuards: 0, settled: () => false, footingRecovery: { needed: false },
    policy: { combat: { shield: options.shield ?? true, critical_health: 6, volley_wait_ticks: options.volleyTicks } },
    reportDecision: () => {},
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  return { bot, clock, weapons, installed };
}

test("the projectile guard loop ends at its 10 s wall twin when ticks come every 200 ms", async () => {
  const slow = slowWeapons({ volleyTicks: 100 });
  using _installed = slow.installed;
  const { weapons } = slow;
  Object.assign(weapons, { raiseGuard: async () => {}, maintainGuard: async () => {}, projectileDefence: () => ({
    imminent: true, aligned: false, windingUp: [], windupForecasts: [], projectiles: [], facing: new Vec3(0, 65, 8),
  }) });
  const { outcome, ms, ticks } = await driveTicksOf(slow, SLOW_TICK_MS, weapons.guardIncoming());
  assert.equal(outcome, false);
  assert.ok(ms <= 10_000 + SLOW_TICK_MS, `the 100-tick wait took ${ms} ms of clock`);
  assert.ok(ticks >= 45 && ticks < 100, `${ticks} ticks: the wall twin ended it, not the 100 ticks`);
});

test("the projectile guard loop still counts its 100 ticks when ticks come every 50 ms", async () => {
  const slow = slowWeapons({ volleyTicks: 100 });
  using _installed = slow.installed;
  const { weapons } = slow;
  Object.assign(weapons, { raiseGuard: async () => {}, maintainGuard: async () => {}, projectileDefence: () => ({
    imminent: true, aligned: false, windingUp: [], windupForecasts: [], projectiles: [], facing: new Vec3(0, 65, 8),
  }) });
  const { outcome, ticks } = await driveTicksOf(slow, 50, weapons.guardIncoming());
  assert.equal(outcome, false);
  assert.ok(ticks >= 99 && ticks <= 101, `${ticks} ticks`);
});

test("the ranged guard's windup limit ends at its 10 s wall twin when ticks come every 200 ms", async () => {
  const slow = slowWeapons({ volleyTicks: 100 });
  using _installed = slow.installed;
  const { weapons } = slow;
  Object.assign(weapons, { raiseGuard: async () => {}, bowWindow: () => ({ safe: false }), projectileDefence: () => null });
  const { outcome, ms } = await driveTicksOf(slow, SLOW_TICK_MS, weapons.guardRangedAttack());
  assert.equal(outcome, "windup_limit");
  assert.ok(ms <= 10_000 + 2 * SLOW_TICK_MS, `the 100-tick wait took ${ms} ms of clock`);
});

test("the facing hold ends at the wall twin of its ticks when ticks come every 200 ms", async () => {
  const slow = slowWeapons({ volleyTicks: 100 });
  using _installed = slow.installed;
  const { weapons } = slow;
  Object.assign(weapons, { maintainGuard: async () => {}, face: async () => {} });
  const { ms } = await driveTicksOf(slow, SLOW_TICK_MS, weapons.holdFacing(100));
  assert.ok(ms <= 10_000 + SLOW_TICK_MS, `the 100-tick hold took ${ms} ms of clock`);
  const normal = await driveTicksOf(slow, 50, weapons.holdFacing(10));
  assert.equal(normal.ticks, 10, "a hold on a normal server still takes all its ticks");
});

test("a hold does not lose its ticks to work between them, such as a shield re-equip taking 1 s", async () => {
  const slow = slowWeapons({ volleyTicks: 100 });
  using _installed = slow.installed;
  const { weapons, clock } = slow;
  let faces = 0;
  Object.assign(weapons, {
    maintainGuard: () => clock.sleep(1_000),
    face: async () => { faces++; },
  });
  await driveTicksOf(slow, 50, weapons.holdFacing(5));
  assert.equal(faces, 5, "5 ticks held although the work between them took 5 s, ten times the 500 ms twin");
});

describe("with no physics tick at all (an unloaded chunk) a wait ends at its 10 s wall twin", () => {
  const loops: Record<string, (weapons: FightWeapons) => Promise<unknown>> = {
    holdFacing: (weapons) => weapons.holdFacing(100),
    guardIncoming: (weapons) => weapons.guardIncoming(),
    guardFinalVolley: (weapons) => weapons.guardFinalVolley(),
  };
  for (const [name, run] of Object.entries(loops))
    test(name, async () => {
      const slow = slowWeapons({ volleyTicks: 100 });
      using _installed = slow.installed;
      const { weapons } = slow;
      Object.assign(weapons, { raiseGuard: async () => {}, maintainGuard: async () => {}, face: async () => {}, projectileDefence: () => ({
        imminent: true, aligned: false, windingUp: [], windupForecasts: [], projectiles: [], facing: new Vec3(0, 65, 8),
      }) });
      const { ms } = await driveTicksOf(slow, SLOW_TICK_MS, run(weapons), false);
      assert.ok(ms >= 9_000 && ms <= 10_000 + 2 * SLOW_TICK_MS, `ended after ${ms} ms of clock with no tick`);
    });
});

for (const [tickMs, label] of [[SLOW_TICK_MS, "its 10 s wall twin"], [50, "its 100 ticks"]] as const)
  test(`the final volley guard ends at ${label} when an arrow never clears`, async () => {
    const slow = slowWeapons({ volleyTicks: 100 });
    using _installed = slow.installed;
    const { weapons } = slow;
    await driveTicksOf(slow, tickMs, weapons.itemUse.raiseShield());
    const { ms } = await driveTicksOf(slow, tickMs, weapons.guardFinalVolley());
    const bound = tickMs === SLOW_TICK_MS ? 10_000 : 5_000;
    assert.ok(ms <= bound + 2 * tickMs, `took ${ms} ms of clock at ${tickMs} ms a tick`);
    assert.ok(ms >= bound - 4 * tickMs, `a bound that held the shield for its whole budget: ${ms} ms`);
  });

test("guard returns an aligned visible bow draw to shielded approach", async () => {
  const { bot, clock } = createFakeBot();
  let ticks = 0;
  let aimed = 0;
  const decisions: unknown[] = [];
  const lookAt = bot.lookAt.bind(bot);
  bot.lookAt = async (point, force) => { aimed++; await lookAt(point, force); };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    execution: { run: async (_phase: string, effect: () => Promise<boolean>) => effect() },
    projectileGuards: 0, settled: () => false, footingRecovery: { needed: false },
    policy: { combat: { volley_wait_ticks: 100 } }, reportDecision: (event: unknown) => decisions.push(event),
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { raiseGuard: async () => {}, projectileDefence: () => ticks < 3 ? {
    imminent: false, aligned: true, windingUp: [{ id: 8 }], windupForecasts: [], projectiles: [], facing: new Vec3(0, 65, 8),
  } : null });
  const onTick = () => { ticks++; };
  bot.on("physicsTick", onTick);
  try {
    assert.equal(await drive(clock, weapons.guardIncoming()), true);
    assert.equal(ticks, 0, "an aligned guard can move while the bow is drawn");
    assert.equal(aimed, 1);
    assert.match(JSON.stringify(decisions), /aligned_guard_can_advance/);
  } finally { bot.off("physicsTick", onTick); }
});
