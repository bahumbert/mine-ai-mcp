/** Occupied local roofs must not end a hostile pursuit before reachable terrain is searched. */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMovements, createNavigationRuntime, type Navigate } from "../../../navigation/index.js";
import { HuntTargeting, type HuntRequest } from "../../../navigation/processes/hunting/hunt-process.js";
import { createFakeBot, type FakeEntitySpec } from "../../../test-support/fake-bot/index.js";
import { ProtectedAttackProgress } from "../../control/combat/attack-progress.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import type { CombatDecision } from "../../control/combat/contract.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import { survivalResources } from "../../state/resources.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { FootingRecovery } from "../footing.js";
import { CoverFight } from "./cover.js";
import { EndermanFight } from "./enderman.js";
import { FightMovement } from "./movement.js";
import { observeFight } from "./observe.js";
import { FightScene } from "./scene.js";
import { runFightTurn } from "./turn.js";
import { FightWeapons } from "./weapons.js";

/** A one-cell ledge, four NoAI column occupants, and a lower floor outside the level-only local search. */
function occupiedLedge(blocks = 32) {
  const entities: Record<number, FakeEntitySpec> = {
    7: { name: "enderman", position: new Vec3(10.5, 64, 0.5), metadata: { 17: true } },
  };
  for (const [index, [x, z]] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].entries())
    entities[10 + index] = { name: "cow", position: new Vec3(0.5 + x!, 66, 0.5 + z!), metadata: { 15: 1 } };
  const harness = createFakeBot({ position: new Vec3(0.5, 66, 0.5), groundY: 63,
    cells: { "0,65,0": "stone" }, carried: { diamond_sword: 1, cobblestone: blocks }, entities, simulatePhysics: true });
  const { bot, clock } = harness;
  const navigation = createNavigationRuntime(bot);
  const perception = new CombatPerception(bot);
  perception.attackerIds.add(7);
  const footingRecovery = new FootingRecovery(bot, navigation.world);
  const survival = survivalResources();
  const decisions: CombatDecision[] = [];
  const signal = new AbortController().signal;
  const scene = new FightScene({ bot, navigation, perception, footingRecovery, survival,
    policy: new SurvivalPolicyState(bot), reportDecision: event => decisions.push(event) },
  { target: bot.entities[7]!, movement: "pursue", signal, ownerSignal: signal, minimumHealth: 12 },
  new ProtectedAttackProgress(survival.budgets, 7, 300), new EndermanProgress(survival.budgets, 300));
  const weapons = new FightWeapons(scene, { recoverFooting: async () => {}, returnToCover: () => false });
  const movement = new FightMovement(scene, weapons);
  const roof = new EndermanFight(scene, weapons, movement);
  const cover = new CoverFight(scene, weapons, movement);
  const observation = observeFight(scene, weapons, movement, cover, roof);
  return { ...harness, navigation, scene, roof, movement, decisions,
    replaceRoute: (route: Navigate) => { Reflect.set(navigation, "navigate", route); },
    prepare: () => clock.settle(roof.prepare(false), 30_000),
    turn: () => clock.settle(runFightTurn(scene, weapons, movement, cover, roof, { kind: "act" }), 5_000),
    async close() {
      observation.stopEffects(); observation.close(); scene[Symbol.dispose](); scene.endermanProgress[Symbol.dispose]();
      perception[Symbol.dispose](); footingRecovery[Symbol.dispose](); survival.answered.clear();
      await navigation.close();
    },
  };
}

test("a hostile pursuit builds below its occupied ledge, commits hits, and permits the hunt's next selection", async () => {
  const fixture = occupiedLedge();
  const { bot, scene, roof, clock, decisions } = fixture;
  try {
    assert.equal(scene.defendingAtStart, true);
    const local = scene.position.planRoof({ kind: "protection" });
    assert.equal(local.kind, "unreachable");
    if (local.kind !== "unreachable") return;
    assert.match(local.reason, /1 supported cells;.*occupied [1-9]/);
    assert.equal((await fixture.prepare()).kind, "continue");
    assert.equal(roof.state.kind, "committed");
    assert.equal(scene.position.cell.y, 64, "navigation must leave the local search's y=66 layer");
    assert.ok(decisions.some(event => event.kind === "roof_prepared" && event.stopped === null && event.cell.y === 64));
    assert.equal(scene.position.hasHeightProtection(), true);
    // Native pursuit/teleport is a stimulus here; actual route physics, placement and damage use the shared fake.
    scene.target.position = bot.entity.position.offset(2, 0, 0);
    for (let turn = 0; turn < 100 && scene.observed !== "died"; turn++) {
      await fixture.turn();
      await clock.advance(50);
    }
    assert.equal(scene.observed, "died");
    assert.ok(decisions.some(event => event.kind === "roof_engagement" && event.state === "hit"));
    assert.equal((await fixture.turn())?.kind, "died");
    const next = fixture.entities.spawn({ name: "enderman", position: bot.entity.position.offset(8, 0, 0) });
    const targeting = new HuntTargeting(bot, { matches: entity => entity.name === "enderman",
      isSatisfied: () => false, contactRange: 8, movements: createMovements(bot), route: fixture.navigation.navigate,
      engage: async () => ({ kind: "defeated" }) } satisfies HuntRequest);
    targeting.retire(7, "defeated");
    const selected = targeting.scan()[0]!;
    targeting.select(selected);
    assert.equal(selected.id, next.id);
  } finally { await fixture.close(); }
});

test("an unreachable alternate roof is remembered once at the unchanged cell and pursuit ends out of reach", async () => {
  const fixture = occupiedLedge();
  let searches = 0;
  fixture.replaceRoute(async () => { searches++; return { status: "stopped", reason: "No reachable roof", elapsedMs: 0 }; });
  try {
    assert.equal((await fixture.prepare()).kind, "continue");
    assert.ok(fixture.scene.position.roofPreparationFailure());
    for (let turn = 0; turn < 2; turn++) {
      fixture.roof.refresh();
      const result = await fixture.prepare();
      assert.equal(result.kind, "outcome");
      if (result.kind === "outcome") {
        assert.equal(result.outcome.kind, "unreachable");
        assert.match("observation" in result.outcome ? result.outcome.observation : "", /out of reach/);
      }
    }
    assert.equal(searches, 1);
  } finally { await fixture.close(); }
});

test("a defending material refusal keeps the current turn without searching reachable terrain", async () => {
  const fixture = occupiedLedge(0);
  fixture.replaceRoute(async () => assert.fail("materials_missing cannot start a roof route"));
  try {
    assert.equal((await fixture.prepare()).kind, "continue");
    assert.equal(fixture.scene.position.roofPreparationFailure()?.failure.kind, "materials_missing");
    assert.equal(fixture.roof.state.kind, "unavailable");
  } finally { await fixture.close(); }
});

test("contact during the alternate roof search leaves preparation retryable without a refusal", async () => {
  const fixture = occupiedLedge();
  const before = fixture.bot.listenerCount("physicsTick");
  fixture.replaceRoute(async request => {
    fixture.scene.target.position = fixture.bot.entity.position.offset(2, 0, 0);
    await fixture.clock.advance(50);
    assert.equal(request.stopSignal?.aborted, true);
    return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
  });
  try {
    assert.equal((await fixture.prepare()).kind, "continue");
    assert.equal(fixture.roof.state.kind, "unprepared");
    assert.equal(fixture.scene.position.roofPreparationFailure(), null);
    assert.equal(fixture.bot.listenerCount("physicsTick"), before);
  } finally { await fixture.close(); }
});
