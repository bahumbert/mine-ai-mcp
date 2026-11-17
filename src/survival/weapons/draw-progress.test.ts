// Bow draw timing and cancellation through the fight's shared draw owner.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { FightWeapons } from "../responses/fight/weapons.js";
import type { FightScene } from "../responses/fight/scene.js";

/** An open shot; tactics and aiming are seams, item use and server answers are real shared-fake behavior. */
function shotScene(ticksPerSecond: number) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond },
    carried: { bow: 1, arrow: 3 }, entities: { 7: { name: "skeleton", position: new Vec3(12, 64, 0) } } });
  const owner = new AbortController();
  const state = { ended: false, cover: false };
  const scene = { bot: harness.bot, target: harness.bot.entities[7]!, signal: owner.signal, attacks: 0,
    perception: { read: () => [] }, reportDecision: () => {}, settled: () => state.ended,
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
  } as unknown as FightScene;
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => state.cover });
  Object.assign(weapons, { hasClearShot: () => true, aimBow: async () => true });
  return { ...harness, weapons, state, owner };
}

for (const rate of [20, 10]) {
  for (const mode of ["running", "warm stopped", "cold stopped"] as const)
  test(`a ${mode} ${rate} tps draw ends at full server charge, D1's cap or its backstop`, async () => {
    const { bot, clock, server, weapons } = shotScene(rate);
    using _timers = clock.install();
    using _pace = serverTickPace(bot);
    if (mode !== "cold stopped") await clock.advance(40_000 / rate);
    if (mode !== "running") server.stop();
    const added = listenersAddedSince(bot);
    const started = clock.now(), age = bot.time.age, gameTime = server.gameTime;
    const arrow = mode === "running" ? new Promise<number>(resolve => bot.once("entitySpawn", entity => resolve(entity.velocity.norm()))) : null;
    assert.equal(await clock.settle(weapons.shoot(null), 7_000), "shot");
    assert.equal(clock.now() - started, mode === "cold stopped" ? 6_000 : 20_000 / rate);
    if (arrow) {
      assert.equal(server.gameTime - gameTime, 20);
      assert.ok(Math.abs(await clock.settle(arrow, 1_000) - 3) < 0.01, "T1a's measured full-charge launch speed");
    } else assert.equal(bot.time.age, age);
    assert.equal(weapons.itemUse.drawingBow, false);
    assert.equal(added("physicsTick"), 0);
  });

  for (const exit of ["volley", "gone", "cover", "abort"] as const) {
    test(`a ${exit} interrupts a ${rate} tps draw without releasing or leaving listeners`, async () => {
      const { bot, clock, weapons, state, owner } = shotScene(rate);
      using _timers = clock.install();
      using _pace = serverTickPace(bot);
      await clock.advance(40_000 / rate);
      const added = listenersAddedSince(bot);
      const started = clock.now();
      let remaining = 0;
      Object.assign(weapons, {
        bowWindow: (ticks: number) => { remaining = ticks; return { safe: clock.now() - started < 500 }; },
        guardRangedAttack: async () => "volley_finished",
      });
      clock.after(500, () => {
        if (exit === "gone") state.ended = true;
        if (exit === "cover") state.cover = true;
        if (exit === "abort") owner.abort(new Error("draw cancelled"));
      });
      const shot = weapons.shoot(exit === "volley" ? bot.inventory.items()[0]! : null);
      if (exit === "abort") await clock.settle(assert.rejects(shot, /draw cancelled/), 7_000);
      else assert.equal(await clock.settle(shot, 7_000), { volley: "volley_finished", gone: "fight_ended", cover: "return_to_cover" }[exit]);
      if (exit === "volley") assert.equal(remaining, 20 - rate / 2, "guard forecasts the remaining server ticks");
      assert.equal(clock.now() - started, 500);
      assert.equal(weapons.itemUse.drawingBow, false);
      await clock.advance(7_000);
      assert.equal(bot.inventory.count(bot.registry.itemsByName.arrow!.id, null), 3);
      assert.equal(Object.values(bot.entities).some(entity => entity.name === "arrow"), false);
      assert.equal(added("physicsTick"), 0);
      assert.equal(added("entitySpawn"), 0);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }
}
