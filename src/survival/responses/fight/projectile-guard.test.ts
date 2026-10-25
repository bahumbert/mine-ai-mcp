import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { Item } from "prismarine-item";
import { type FakeClock, createFakeBot, flush } from "../../../test-support/fake-bot/index.js";
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
    policy: { combat: { shield: true, critical_health: 6 } }, reportDecision: () => {},
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
