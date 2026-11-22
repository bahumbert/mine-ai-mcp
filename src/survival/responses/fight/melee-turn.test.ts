import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { addItemsToServerTag } from "../../../test-support/datapack-tags.js";
import { createFakeBot, createFakeClock, listenersAddedSince, itemOf, type FakeCell, type FakeEntitySpec } from "../../../test-support/fake-bot/index.js";
import { liveBlockReader } from "../../../navigation/index.js";
import { observation } from "../../../test-support/navigation.js";
import type { CombatLoadout } from "../../weapons/equipment.js";
import type { EndermanFight } from "./enderman.js";
import { FightMovement } from "./movement.js";
import { runMeleeTurn } from "./melee-turn.js";
import type { FightScene } from "./scene.js";
import { FightWeapons } from "./weapons.js";
import { serverTickPace } from "../../../world/server-tick-pace.js";
import { serverPacedWallMs } from "../../../world/world-age.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import { CombatTactics } from "../../control/combat/tactics.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";
import { runFightTurn } from "./turn.js";

/** Real readiness, guard holds and strikes; only the enclosing fight's lifecycle is controlled here. */
function pacedMelee(rate: number) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    slots: { 36: { name: "iron_sword" }, 37: { name: "iron_axe" } },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 2.5) } },
  });
  const { bot } = harness;
  const stop = new AbortController();
  const lifecycle = { dead: false, cover: false };
  const scene = {
    bot, target: bot.entities[7]!, targetId: 7, movement: "hold", holdsGround: false,
    position: { plan: null }, policy: DEFAULT_SURVIVAL_POLICY, signal: stop.signal,
    perception: { read: () => [], attackerIds: new Set<number>() },
    footingRecovery: { needed: false }, dead: new Set<number>(), attacks: 0, elapsedTicks: 0,
    stylesUsed: new Set(), weaponsUsed: new Set(), settled: () => lifecycle.dead,
    reportDecision: () => {}, result: (kind: string) => ({ kind }),
    execution: { run: async (_phase: string, effect: () => Promise<unknown>) => effect() },
  } as unknown as FightScene;
  bot.on("physicsTick", () => { scene.elapsedTicks++; });
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => lifecycle.cover });
  const loadout = { kind: "melee", weapon: bot.heldItem, shield: null, cooldownTicks: 13 } as const;
  const roof = { state: { kind: "idle" } } as unknown as EndermanFight;
  return { ...harness, stop, lifecycle, scene, weapons, loadout,
    turn: () => runMeleeTurn(scene, weapons, {} as FightMovement, roof, loadout) };
}

for (const rate of [20, 10]) test(`every melee turn deals full sword damage at ${rate} tps; on-time hit times stay unchanged`, async () => {
  const fixture = pacedMelee(rate);
  const { bot, clock, server } = fixture;
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  const times: number[] = [];
  bot.on("entityHurt", target => { if (target.id === 7) times.push(clock.now() - 4_000); });
  const healthKey = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health");
  const started = server.gameTime;
  for (const health of [14, 8, 2]) {
    await clock.settle(fixture.turn(), 5_000);
    assert.equal(bot.entities[7]!.metadata[healthKey], health, "each hit must deal 6 x 1.0");
    // The fake applies knockback; put the still-live target back in reach for the next turn.
    bot.entities[7]!.position.set(0.5, 64, 2.5);
  }
  assert.deepEqual(times, rate === 20 ? [50, 700, 1_350] : [50, 1_350, 2_650]);
  assert.equal(server.gameTime - started, 39);
});

for (const exit of ["death", "cover", "abort", "stopped", "capped"] as const) test(`a slow-server weapon hold releases on ${exit} without another hold`, async () => {
  const { bot, clock, server, scene, weapons, lifecycle, stop } = pacedMelee(10);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  if (exit !== "stopped") await clock.advance(4_000);
  else server.stop();
  if (exit === "capped") server.stop();
  const stoppedAt = { gameTime: server.gameTime, age: bot.time.age, clientTicks: scene.elapsedTicks };
  const loadout = weapons.currentLoadout();
  assert.equal(loadout.kind, "melee");
  await weapons.equip({ kind: "melee", weapon: bot.inventory.slots[37]!, shield: null, cooldownTicks: 25 });
  await weapons.equip(loadout);
  const added = listenersAddedSince(bot);
  const started = clock.now();
  const holding = weapons.readyWeapon();
  const outcome: Promise<unknown> = exit === "abort" ? assert.rejects(holding, /parent cancelled/) : holding;
  await clock.advance(100);
  if (exit === "death") lifecycle.dead = true;
  if (exit === "cover") lifecycle.cover = true;
  if (exit === "abort") stop.abort(new Error("parent cancelled"));
  const result = await clock.settle(outcome, serverPacedWallMs(13));
  assert.equal(clock.now() - started, exit === "stopped" ? serverPacedWallMs(13) : exit === "capped" ? 1_300 : exit === "abort" ? 100 : 150);
  if (exit === "stopped" || exit === "capped") {
    assert.equal(server.gameTime, stoppedAt.gameTime);
    assert.equal(bot.time.age, stoppedAt.age);
    assert.ok(scene.elapsedTicks > stoppedAt.clientTicks, "client physics continues while the server is stopped");
  }
  if (exit === "cover") assert.equal(result, "interrupted");
  if (exit === "stopped") assert.equal(weapons.strike(scene.target, { kind: "melee", weapon: bot.heldItem, shield: null, cooldownTicks: 13 }), false);
  if (exit === "capped") assert.equal(weapons.strike(scene.target, { kind: "melee", weapon: bot.heldItem, shield: null, cooldownTicks: 13 }), true);
  assert.equal(added("physicsTick"), 0);
  await clock.advance(10_000);
  if (exit === "stopped" || exit === "capped") {
    assert.equal(server.gameTime, stoppedAt.gameTime);
    assert.equal(bot.time.age, stoppedAt.age);
  }
  assert.equal(clock.pendingGlobalTimers(), 0);
});

test("footing recovery interrupts a slow weapon hold and owns the next turn's tick", async () => {
  const { bot, clock, scene, weapons, loadout } = pacedMelee(10);
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(4_000);
  const tactics = new CombatTactics(new AbortController().signal);
  Object.defineProperty(scene, "signal", { get: () => tactics.signal });
  Object.assign(scene.perception, { tick: 0, resolvedIds: new Set(), creeperClearance: new CreeperClearance(bot) });
  weapons.readiness.restart();
  const added = listenersAddedSince(bot);
  const holding = tactics.run({ kind: "act" }, () => weapons.readyWeapon(loadout));
  await clock.advance(100);
  Object.assign(scene.footingRecovery, { needed: true });
  const next = tactics.observe(scene, weapons);
  assert.equal(next.kind, "recover_footing");
  assert.deepEqual(await holding, { kind: "interrupted" });
  assert.equal(added("physicsTick"), 0);
  let recoveredAt = -1;
  const locomotion = { recoverFooting: async () => { recoveredAt = clock.now(); } } as unknown as FightMovement;
  await clock.advance(50);
  await tactics.run(next, () => runFightTurn(scene, weapons, locomotion, {} as never, {} as never, next));
  assert.equal(recoveredAt, 4_150);
  await clock.advance(10_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

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
