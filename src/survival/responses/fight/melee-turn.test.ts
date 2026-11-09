import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { addItemsToServerTag } from "../../../test-support/datapack-tags.js";
import { createFakeBot, itemOf, type FakeCell, type FakeEntitySpec } from "../../../test-support/fake-bot/index.js";
import { liveBlockReader } from "../../../navigation/index.js";
import { observation } from "../../../test-support/navigation.js";
import type { CombatLoadout } from "../../weapons/equipment.js";
import type { EndermanFight } from "./enderman.js";
import { FightMovement } from "./movement.js";
import { runMeleeTurn } from "./melee-turn.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/**
 * One melee turn against a zombie in reach, a piglin standing in sweep range, melee prohibited by policy: a turn that
 * withholds the swing returns null, one that goes on to the swing stops at the policy refusal. Only the parts of the
 * scene the turn reads on this path are stubbed (as in approach-goal.test.ts).
 */
async function turnWith(weapon: string, datapackSwords: readonly string[]) {
  const harness = createFakeBot({
    position: new Vec3(0, 64, 0),
    entities: {
      7: { name: "zombie", position: new Vec3(2, 64, 0), width: 0.6, height: 1.95 },
      8: { name: "piglin", position: new Vec3(1, 64, 1), width: 0.6, height: 1.95 },
    },
  });
  const { bot } = harness;
  if (datapackSwords.length > 0) addItemsToServerTag(harness, "swords", datapackSwords);
  const scene = {
    bot,
    target: bot.entities[7]!,
    targetId: 7,
    movement: "hold",
    holdsGround: false,
    position: { plan: null },
    signal: new AbortController().signal,
    policy: { combat: { melee: false } },
    settled: () => false,
    result: (kind: string) => ({ kind }),
  } as unknown as FightScene;
  const weapons = {
    readyWeapon: async () => {},
    face: async () => {},
  } as unknown as FightWeapons;
  const roof = { state: { kind: "idle" } } as unknown as EndermanFight;
  const loadout: Extract<CombatLoadout, { kind: "melee" }> = {
    kind: "melee", weapon: itemOf(bot.registry, weapon), shield: null, cooldownTicks: 10,
  };
  return runMeleeTurn(scene, weapons, {} as unknown as FightMovement, roof, loadout);
}

test("sword-family weapons withhold a sweep beside a bystander; other weapons reach the policy check", async () => {
  for (const { weapon, tags, want } of [
    ...["wooden_sword", "stone_sword", "golden_sword", "iron_sword", "diamond_sword", "netherite_sword"]
      .map(weapon => ({ weapon, tags: [], want: null })),
    { weapon: "stick", tags: ["stick"], want: null },
    { weapon: "iron_axe", tags: [], want: "capability_blocked" },
  ]) {
    assert.equal((await turnWith(weapon, tags))?.kind ?? null, want, weapon);
  }
});

/** A shielded imminent contact; navigation and readiness are boundaries controlled by each turn test. */
function guardedTurn(options: {
  cells?: Record<string, FakeCell>;
  secondAttacker?: boolean;
  hold?: boolean;
  stopped?: string;
  circleDuringGuard?: boolean;
  realMovement?: boolean;
  shield?: boolean;
} = {}) {
  const entities: Record<number, FakeEntitySpec> = {
    7: { name: "zombie", position: options.secondAttacker || options.circleDuringGuard ? new Vec3(2.5, 64, 0.5) : new Vec3(0.5, 64, 2.5) },
  };
  if (options.secondAttacker) entities[8] = { name: "zombie", position: new Vec3(0.5, 64, 2.5) };
  const harness = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: options.cells,
    entities,
  });
  const { bot } = harness;
  const attacks: number[] = [];
  bot.attack = target => { attacks.push(target.id); };
  const approaches: unknown[][] = [];
  const scene = {
    bot, target: bot.entities[7]!, targetId: 7, movement: options.hold ? "hold" : "pursue",
    holdsGround: false, position: { plan: null }, refusedStance: null,
    signal: new AbortController().signal, navigation: {
      world: { blockAt: liveBlockReader(bot) }, onEvent: () => () => {},
      navigate: async (request: { stopSignal: AbortSignal }) => {
        approaches.push([request.stopSignal.reason]);
        return { status: "cancelled" };
      },
    },
    footingRecovery: { needed: false, active: false },
    perception: { attackerIds: new Set([7]), read: () => Object.values(bot.entities)
      .filter(entity => entity.id !== bot.entity.id).map(entity => ({ id: entity.id, meleeImminent: true })) },
    policy: { combat: { melee: true, terrain: { dig: false, place: false } } }, settled: () => false, result: (kind: string) => ({ kind }),
    execution: { run: async (_phase: string, effect: () => Promise<void>) => effect() },
  } as unknown as FightScene;
  const weapons = {
    volleyActive: () => false,
    raiseGuard: async () => { if (options.circleDuringGuard) scene.target.position.set(0.5, 64, 2.5); },
    readyWeapon: async () => {}, face: async () => {}, faceGuard: async () => {}, holdFacing: async () => {},
    strike: (target: typeof bot.entity) => { bot.attack(target); return true; },
    currentLoadout: () => loadout, projectileDefence: () => null, contact: () => null,
    itemUse: { shieldRaised: options.shield !== false, invalidateShield: () => {} },
  } as unknown as FightWeapons;
  const locomotion = options.realMovement ? new FightMovement(scene, weapons) :
    { approach: async (...args: unknown[]) => { approaches.push(args); return options.stopped ?? null; } } as unknown as FightMovement;
  const roof = { state: { kind: "idle" } } as unknown as EndermanFight;
  const loadout: Extract<CombatLoadout, { kind: "melee" }> = {
    kind: "melee", weapon: itemOf(bot.registry, "diamond_sword"),
    shield: options.shield === false ? null : itemOf(bot.registry, "shield"), cooldownTicks: 10,
  };
  return { scene, approaches, attacks, locomotion, world: harness.world,
    turn: () => harness.clock.settle(runMeleeTurn(scene, weapons, locomotion, roof, loadout), 500) };
}

for (const secondAttacker of [false, true]) {
  test(secondAttacker ? "a second attacker's push toward lava routes to a stance first" : "an imminent hit beside lava routes to a stance first", async () => {
    const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, secondAttacker });
    assert.equal(await fixture.turn(), null);
    assert.deepEqual(fixture.approaches, [[true, null]]);
    assert.deepEqual(fixture.attacks, []);
  });
}

for (const { name, cells, hold } of [
  { name: "no room without a hazard keeps the in-place guard", cells: { "0,63,-2": "air", "0,62,-2": "air" } },
  { name: "a damaging floor behind keeps the in-place guard", cells: { "0,63,-2": "magma_block" } },
  { name: "a held position keeps its stance beside lava", cells: { "0,63,-2": "lava" }, hold: true },
]) {
  test(name, async () => {
    const fixture = guardedTurn({ cells, hold });
    assert.equal(await fixture.turn(), null);
    assert.deepEqual(fixture.approaches, []);
    assert.deepEqual(fixture.attacks, [7]);
  });
}

test("a hazard with no reachable stance keeps the in-place guard", async () => {
  const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, stopped: "no path" });
  assert.equal(await fixture.turn(), null);
  assert.notEqual(fixture.scene.refusedStance, null);
  assert.deepEqual(fixture.attacks, [7]);
  assert.equal(await fixture.turn(), null);
  assert.equal(fixture.approaches.length, 1);
  assert.deepEqual(fixture.attacks, [7, 7]);
  fixture.scene.target.position.z = 3.5;
  assert.equal(await fixture.turn(), null);
  assert.equal(fixture.approaches.length, 2);
  assert.deepEqual(fixture.attacks, [7, 7, 7]);
});

test("the attacker circles to the lava side during guard readiness, no swing", async () => {
  const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, circleDuringGuard: true });
  assert.equal(await fixture.turn(), null);
  assert.deepEqual(fixture.attacks, []);
});

for (const shield of [true, false]) test(`an unchanged secondary-hazard approach resumes ${shield ? "guarded" : "unshielded"} melee within two turns`, async () => {
  const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, secondAttacker: true, realMovement: true, shield });
  try {
    for (let turn = 0; turn < 2; turn++) assert.equal(await fixture.turn(), null);
    assert.deepEqual(fixture.attacks, [7]);
    assert.equal(fixture.approaches.length, 1);
  } finally { fixture.locomotion.footing.release(); }
});

test("melee approach arrival and its watch reject a secondary attacker's unsafe stance", async () => {
  const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, secondAttacker: true, realMovement: true });
  try {
    const goal = fixture.locomotion.approachGoal(false).resolve({
      ...observation(), position: fixture.scene.bot.entity.position, stance: "supported",
    });
    assert.equal(goal.kind, "active");
    if (goal.kind !== "active") return;
    assert.equal(goal.isSatisfied({ feet: { x: 0, y: 64, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" }, fixture.scene.navigation.world), false);
    await fixture.turn();
    assert.deepEqual(fixture.approaches, [[undefined]], "contact cannot stop a route on unsafe footing");
  } finally { fixture.locomotion.footing.release(); }
});

test("a refused stance is retried when an imminent attacker leaves or its hazard changes", async () => {
  const fixture = guardedTurn({ cells: { "0,63,-2": "lava" }, secondAttacker: true, realMovement: true });
  fixture.scene.target.position.set(0.5, 64, 2.5);
  try {
    await fixture.turn();
    await fixture.turn();
    delete fixture.scene.bot.entities[8];
    await fixture.turn();
    assert.equal(fixture.approaches.length, 2, "a changed attacker set retries even at the same cells");
    fixture.world.setCell(new Vec3(0, 63, -2), "stone");
    await fixture.turn();
    fixture.world.setCell(new Vec3(0, 63, -2), "lava");
    await fixture.turn();
    assert.equal(fixture.approaches.length, 3, "a cleared hazard invalidates the previous refusal");
  } finally { fixture.locomotion.footing.release(); }
});
