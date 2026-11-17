import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, type FakeClock } from "../../../test-support/fake-bot/index.js";
import type { RoofPosition } from "../../positioning/combat/planner.js";
import { Budgets } from "../../state/budgets.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

const SLOW_TICK_MS = 200;
const WAIT_TICKS = 300;

/** An enderman fight over a stub scene that counts a physics tick per call of `tick`, on an installed clock the test moves. */
function endermanFight(clock: FakeClock, movement: "hold" | "pursue") {
  const budgets = new Budgets();
  const progress = new EndermanProgress(budgets, WAIT_TICKS);
  const scene = {
    targetId: 7,
    movement,
    heightLimitedTarget: true,
    elapsedTicks: 0,
    policy: { combat: { enderman_wait_ticks: WAIT_TICKS } },
    survival: { budgets },
    endermanProgress: progress,
    position: { cell: new Vec3(0, 64, 0) },
  } as unknown as FightScene;
  const fight = new EndermanFight(scene, {} as FightWeapons, {} as FightMovement);
  const tick = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await clock.advance(SLOW_TICK_MS, SLOW_TICK_MS);
      scene.elapsedTicks++;
      progress.tick(false);
    }
  };
  return { fight, scene, tick, progress };
}

test("the enderman defensive hold ends at 30 s on a slow local physics clock, with 150 of its 300 ticks counted", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { fight, tick, progress } = endermanFight(clock, "hold");
  using _progress = progress;
  assert.ok(fight.heldTarget);
  await tick(149);
  assert.equal(fight.heldTarget.exhausted, false);
  await tick(1);
  assert.equal(fight.heldTarget.exhausted, true);
  progress.confirmedTargetDamage(7);
  assert.equal(fight.heldTarget.exhausted, false, "confirmed damage renews the wall twin with the ticks");
  await tick(149);
  assert.equal(fight.heldTarget.exhausted, false);
  await tick(1);
  assert.equal(fight.heldTarget.exhausted, true);
});

test("the enderman provocation and roof windows end at 30 s on a slow local physics clock, not 60 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { fight, tick, progress } = endermanFight(clock, "pursue");
  using _progress = progress;
  const provoking = fight.provokeRoof({ cell: new Vec3(0, 64, 0) } as RoofPosition);
  assert.equal(provoking.kind, "provoking");
  if (provoking.kind !== "provoking") return;
  const roof = progress.open("roof", 7, "0,64,0");
  await tick(149);
  assert.deepEqual([provoking.budget.exhausted, roof.exhausted], [false, false]);
  await tick(1);
  assert.deepEqual([provoking.budget.exhausted, roof.exhausted], [true, true]);
});

test("leaving a replanned provocation closes its original window without spending later fight ticks", async () => {
  const { bot, clock } = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), position: new Vec3(0.5, 64, 0.5),
    entities: { 7: { name: "enderman", position: new Vec3(8, 64, 0.5) } },
    cells: { "4,65,0": "stone", "4,66,0": "stone" } });
  using _installed = clock.install();
  const budgets = new Budgets();
  using progress = new EndermanProgress(budgets, WAIT_TICKS);
  const original = new Vec3(0, 64, 0);
  const replanned = new Vec3(1, 64, 0);
  const scene = { bot, target: bot.entities[7], requestedTarget: bot.entities[7], targetId: 7,
    movement: "pursue", heightLimitedTarget: true, defendingAtStart: false,
    roofTargetHostile: () => false, endermanProgress: progress,
    position: { hasHeightProtection: () => false }, policy: { combat: { enderman_wait_ticks: WAIT_TICKS } },
  } as unknown as FightScene;
  const movement = { approachRoof: async () => ({ kind: "ready", plan: { cell: replanned, placements: [] } }) } as unknown as FightMovement;
  const fight = new EndermanFight(scene, {} as FightWeapons, movement);
  fight.setRoof(fight.provokeRoof({ cell: original, placements: [] }));
  for (let tick = 0; tick < 10; tick++) progress.tick(false);
  const opened = budgets.snapshot();
  await fight.prepare(false);
  assert.equal(fight.state.kind, "provoking");
  if (fight.state.kind !== "provoking") return;
  assert.equal(String(fight.state.plan.cell), String(replanned));
  assert.deepEqual(budgets.snapshot(), opened, "gaze replanning keeps the same provocation window");
  fight.setRoof({ kind: "unprepared" });
  assert.deepEqual(budgets.snapshot(), [], "leaving provoking closes the original cell's handle");
  for (let tick = 0; tick < 200; tick++) progress.tick(false);
  assert.equal(progress.open("provocation", 7, String(original)).remaining, 290);
});
