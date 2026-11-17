import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { swingReadiness } from "../../weapons/swing-readiness.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";
import type { FightScene } from "../../responses/fight/scene.js";
import type { FightWeapons } from "../../responses/fight/weapons.js";
import { CombatTactics } from "./tactics.js";

test("a bow quarry's blast counter uses the counter target's sword recovery at 10 tps", async () => {
  const { bot, clock, server } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: 10 },
    carried: { iron_sword: 1, bow: 1, arrow: 1 },
    entities: { 7: { name: "skeleton", position: new Vec3(8, 64, 0) }, 8: { name: "creeper", position: new Vec3(2, 64, 0) } },
  });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using readiness = swingReadiness(bot);
  const tactics = new CombatTactics(new AbortController().signal);
  const ready: boolean[] = [];
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: bot.entities[7]!, policy: { ...DEFAULT_SURVIVAL_POLICY, combat: { ...DEFAULT_SURVIVAL_POLICY.combat, terrain: { place: false } } },
    footingRecovery: { needed: false }, reportDecision: (event: { evidence?: { inputs?: { counterReady: boolean } } }) => {
      if (event.evidence?.inputs) ready.push(event.evidence.inputs.counterReady);
    } } as unknown as FightScene;
  const weapons = { readiness, projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    contact: () => null, itemUse: { shieldRaised: false, drawingBow: false } } as unknown as FightWeapons;
  await clock.advance(4_000);
  const started = server.gameTime;
  readiness.restart();
  await clock.advance(500);
  tactics.observe(scene, weapons);
  assert.equal(ready.at(-1), false);
  await clock.advance(800);
  // A new observer records the inputs even when the resulting tactic is unchanged.
  new CombatTactics(new AbortController().signal).observe(scene, weapons);
  assert.equal(ready.at(-1), true);
  assert.equal(server.gameTime - started, 13);
  assert.equal(clock.now(), 5_300);
});

test("a newly closing creeper cancels and drains the old effect before escape gets a fresh signal", async () => {
  const { bot } = createFakeBot({ position: new Vec3(0, 64, 0), entities: { 7: { name: "creeper", position: new Vec3(3, 64, 0) } } });
  const tactics = new CombatTactics(new AbortController().signal);
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: { name: "skeleton" }, policy: { combat: { retreat: true } }, footingRecovery: { needed: false },
    reportDecision: () => {} } as unknown as FightScene;
  const weapons = { projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    itemUse: { shieldRaised: false } } as unknown as FightWeapons;
  let release!: () => void;
  const cleanup = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  let drained = false;
  const running = tactics.run({ kind: "act" }, async () => {
    const signal = tactics.signal;
    await new Promise<void>(resolve => signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }));
    await cleanup;
    drained = true;
    signal.throwIfAborted();
  });
  const decision = tactics.observe(scene, weapons);
  assert.equal(decision.kind, "escape");
  assert.equal(stopped, true);
  assert.equal(drained, false);
  release();
  assert.deepEqual(await running, { kind: "interrupted" });
  await tactics.run(decision, async () => {
    assert.equal(drained, true);
    assert.equal(tactics.signal.aborted, false);
    tactics.observe(scene, weapons);
    assert.equal(tactics.signal.aborted, false, "the escape does not interrupt itself");
  });
  const failedRelease = tactics.run({ kind: "act" }, async () => {
    await new Promise<void>(resolve => tactics.signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("shield release failed");
  });
  tactics.observe(scene, weapons);
  await assert.rejects(failedRelease, /shield release failed/,
    "tactical cancellation cannot hide a cleanup failure and start another effect");
});

test("a reachable contact is priced as melee before a distant quarry's bow commitment", () => {
  const { bot } = createFakeBot({ position: new Vec3(0, 64, 0), entities: { 7: { name: "creeper", position: new Vec3(3.8, 64, 0) } } });
  const tactics = new CombatTactics(new AbortController().signal);
  const scene = { bot, perception: { tick: 1, resolvedIds: new Set(), read: () => [], creeperClearance: new CreeperClearance(bot) },
    target: { name: "skeleton" }, policy: { combat: { retreat: true, melee: true } }, footingRecovery: { needed: false },
    reportDecision: () => {} } as unknown as FightScene;
  let contact: typeof bot.entity | null = bot.entity;
  const weapons = { projectileDefence: () => null, currentLoadout: () => ({ kind: "bow", shield: null }),
    contact: () => contact, itemUse: { shieldRaised: false, drawingBow: false } } as unknown as FightWeapons;
  assert.equal(tactics.observe(scene, weapons).kind, "act", "a ready contact does not commit to the quarry's bow draw");
  contact = null;
  assert.equal(tactics.observe(scene, weapons).kind, "escape", "without that contact the exposed bow draw still needs distance");
});
