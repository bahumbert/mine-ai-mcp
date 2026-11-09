// Closer-contact swings use the same lethal-stance admission and final recheck as selected-target melee.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import { liveBlockReader } from "../../../navigation/index.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import type { CombatTactic } from "../../policy/combat/tactics.js";
import type { CoverFight } from "./cover.js";
import type { EndermanFight } from "./enderman.js";
import { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import { runFightTurn } from "./turn.js";
import { FightWeapons } from "./weapons.js";

/** Real turn/contact/strike code over the shared body; readiness and route completion are explicit boundaries. */
function contactTurn(options: {
  quarry?: string; hazard?: boolean; hold?: boolean; committed?: boolean; stopped?: string; circle?: boolean;
  shield?: boolean; realMovement?: boolean;
} = {}) {
  const harness = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    slots: { 36: { name: "diamond_axe" }, 45: options.shield === false ? null : { name: "shield" } },
    cells: options.hazard === false ? {} : { "0,63,-2": "lava" },
    entities: {
      7: { name: options.quarry ?? "zombie", position: new Vec3(2.5, 64, 0.5) },
      8: { name: "zombie", position: options.circle ? new Vec3(1.5, 64, 0.5) : new Vec3(0.5, 64, 1.5) },
    },
  });
  const { bot } = harness;
  const attacks: number[] = [], approaches: unknown[][] = [];
  bot.attack = target => { attacks.push(target.id); };
  const dead = new Set<number>();
  const scene = {
    bot, target: bot.entities[7]!, requestedTarget: bot.entities[7]!, targetId: 7,
    movement: options.hold ? "hold" : "pursue", observed: null, dead, refusedStance: null,
    signal: new AbortController().signal, footingRecovery: { needed: false, active: false }, position: { plan: null },
    navigation: {
      world: { blockAt: liveBlockReader(bot) }, onEvent: () => () => {},
      navigate: async (request: { stopSignal: AbortSignal }) => {
        approaches.push([request.stopSignal.reason]);
        return { status: "cancelled" };
      },
    }, policy: DEFAULT_SURVIVAL_POLICY,
    perception: { resolvedIds: dead, attackerIds: new Set([8]), read: () => Object.values(bot.entities)
      .filter(entity => entity.id !== bot.entity.id).map(entity => ({ id: entity.id, meleeImminent: true })) },
    settled: () => false, reportDecision: () => {}, attacks: 0, elapsedTicks: 0,
    stylesUsed: new Set(), weaponsUsed: new Set(),
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
  } as unknown as FightScene;
  bot.on("physicsTick", () => { scene.elapsedTicks++; });
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  Object.assign(weapons, {
    currentLoadout: () => ({ kind: "melee", weapon: itemOf(bot.registry, "diamond_axe"),
      shield: options.shield === false ? null : itemOf(bot.registry, "shield"), cooldownTicks: 10 }),
    projectileDefence: () => null, readyWeapon: async () => {}, faceGuard: async () => {}, holdFacing: async () => {},
    raiseGuard: async () => { if (options.circle) bot.entities[8]!.position.set(0.5, 64, 1.5); },
  });
  const movement = options.realMovement ? new FightMovement(scene, weapons) : null;
  const locomotion = {
    positionEffect: async () => ({ kind: "completed", value: { kind: "ready" } }),
    approach: movement?.approach ?? (async (...args: unknown[]) => { approaches.push(args); return options.stopped ?? null; }),
  } as unknown as FightMovement;
  const roof = { state: { kind: options.committed ? "committed" : "idle" }, refresh: () => {},
    maintain: async () => ({ kind: "ready" }), prepare: async () => ({ kind: "ready" }),
  } as unknown as EndermanFight;
  return { scene, attacks, approaches, dispose: () => movement?.footing.release(), turn: async () => {
    await harness.clock.advance(1_500);
    return harness.clock.settle(runFightTurn(scene, weapons, locomotion, {} as CoverFight, roof, { kind: "act" } as CombatTactic), 500);
  } };
}

for (const quarry of ["zombie", "cow"]) test(`a closer contact beside lava routes before striking while pursuing ${quarry}`, async () => {
  const fixture = contactTurn({ quarry });
  assert.equal(await fixture.turn(), null);
  assert.deepEqual(fixture.attacks, []);
  assert.deepEqual(fixture.approaches, [[true, null]]);
});

test("a closer contact circling during readiness withholds its swing and routes next turn", async () => {
  const fixture = contactTurn({ circle: true });
  assert.equal(await fixture.turn(), null);
  assert.deepEqual(fixture.attacks, []);
  assert.equal(await fixture.turn(), null);
  assert.deepEqual(fixture.approaches, [[true, null]]);
});

for (const options of [{ stopped: "no path" }, { realMovement: true }, { shield: false, realMovement: true }]) {
  test(`a ${options.stopped ? "refused" : "unchanged"} ${options.shield === false ? "unshielded " : ""}closer-contact route resumes defence`, async () => {
    const fixture = contactTurn(options);
    try {
      assert.equal(await fixture.turn(), null);
      assert.equal(await fixture.turn(), null);
      assert.deepEqual(fixture.attacks, options.stopped ? [8, 8] : [8]);
      assert.notEqual(fixture.scene.refusedStance, null);
      assert.equal(fixture.approaches.length, 1);
    } finally { fixture.dispose(); }
  });
}

for (const options of [{ hold: true }, { committed: true }, { hazard: false }]) {
  test(`closer-contact defence retains ${options.hold ? "a held stance" : options.committed ? "a committed roof" : "safe footing"}`, async () => {
    const fixture = contactTurn(options);
    assert.equal(await fixture.turn(), null);
    assert.deepEqual(fixture.attacks, [8]);
    assert.deepEqual(fixture.approaches, []);
  });
}
