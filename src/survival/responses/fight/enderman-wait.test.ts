import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../test-support/fake-bot/index.js";
import type { RoofPosition } from "../../positioning/combat/planner.js";
import { Budgets } from "../../state/budgets.js";
import { EndermanProgress } from "../../control/combat/enderman-progress.js";
import { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

const WAIT_TICKS = 300;

/** No world age is available: the fight must still terminate on its wall backstop. */
function endermanFight(movement: "hold" | "pursue") {
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
  return { fight, scene, progress };
}

test("Enderman hold, provocation and roof windows without age use the server-paced wall; damage renews the hold", async () => {
  for (const movement of ["hold", "pursue"] as const) {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const { fight, progress } = endermanFight(movement);
    using _progress = progress;
    const windows = fight.heldTarget ? [fight.heldTarget] : [];
    if (movement === "hold") assert.ok(fight.heldTarget);
    else {
      const provoking = fight.provokeRoof({ cell: new Vec3(0, 64, 0) } as RoofPosition);
      assert.equal(provoking.kind, "provoking");
      if (provoking.kind !== "provoking") assert.fail("a provocation must expose its window");
      windows.push(provoking.budget, progress.open("roof", 7, "0,64,0"));
    }
    await clock.advance(47_999);
    for (const window of windows) assert.equal(window.exhausted, false);
    await clock.advance(1);
    for (const window of windows) assert.equal(window.exhausted, true);
    if (movement === "hold") {
      progress.confirmedTargetDamage(7);
      assert.equal(fight.heldTarget!.exhausted, false, "confirmed damage renews both clocks");
      await clock.advance(47_999);
      assert.equal(fight.heldTarget!.exhausted, false);
      await clock.advance(1);
      assert.equal(fight.heldTarget!.exhausted, true);
    }
  }
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
  progress.tick(false, bot.time.age);
  for (let packet = 0; packet < 2; packet++) {
    await clock.advance(1_000);
    progress.tick(false, bot.time.age);
  }
  const opened = budgets.snapshot();
  await fight.prepare(false);
  assert.equal(fight.state.kind, "provoking");
  if (fight.state.kind !== "provoking") return;
  assert.equal(String(fight.state.plan.cell), String(replanned));
  assert.deepEqual(budgets.snapshot(), opened, "gaze replanning keeps the same provocation window");
  fight.setRoof({ kind: "unprepared" });
  assert.deepEqual(budgets.snapshot(), [], "leaving provoking closes the original cell's handle");
  await clock.advance(10_000);
  progress.tick(false, bot.time.age);
  assert.equal(progress.open("provocation", 7, String(original)).remaining, 280);
});
