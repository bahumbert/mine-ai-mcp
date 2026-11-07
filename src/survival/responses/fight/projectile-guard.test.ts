import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Vec3 } from "vec3";
import type { Item } from "prismarine-item";
import { type FakeBot, type FakeClock, createFakeBot, createFakeClock, flush } from "../../../test-support/fake-bot/index.js";
import { FightWeapons } from "./weapons.js";
import type { FightScene } from "./scene.js";

/** Run `action` while the clock turns one physics tick at a time, until it settles; its outcome is returned as it came. */
async function drive<T>(clock: FakeClock, action: Promise<T>): Promise<T> {
  let settled = false;
  action.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  for (let tick = 0; tick < 2_000 && !settled; tick++) await clock.advance(50);
  return action;
}

for (const permitted of [true, false]) test(`broken guard ${permitted ? "equips a spare and restarts readiness" : "respects disabled shields"}`, async () => {
  const { bot, inventory, server } = createFakeBot({ slots: { 45: { name: "shield" } }, carried: { shield: 1 } });
  const spare = bot.inventory.items()[0]!;
  let equipped = 0, readiness = 0;
  const equip = bot.equip.bind(bot);
  bot.equip = async (item, destination) => {
    assert.equal(item, spare); assert.equal(destination, "off-hand");
    await equip(item, destination); equipped++;
  };
  const scene = { bot, target: { id: 8 }, perception: { read: () => [] }, signal: new AbortController().signal,
    policy: { combat: { shield: permitted } }, reportDecision: () => {},
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, { currentLoadout: () => ({ shield: spare }), holdFacing: async (ticks: number) => { readiness += ticks; } });
  weapons.itemUse.activateShield();
  (inventory.updateSlot as (slot: number, item: Item | null) => void).call(inventory, 45, null);
  await weapons.maintainGuard();
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
