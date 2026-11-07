import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeClock, type FakeClock } from "../../../test-support/fake-bot/index.js";
import type { RoofPosition } from "../../positioning/combat/planner.js";
import { Budgets } from "../../state/budgets.js";
import { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

const SLOW_TICK_MS = 200;
const WAIT_TICKS = 300;

/** An enderman fight over a stub scene that counts a physics tick per call of `tick`, on an installed clock the test moves. */
function endermanFight(clock: FakeClock, movement: "hold" | "pursue") {
  const scene = {
    targetId: 7,
    movement,
    heightLimitedTarget: true,
    elapsedTicks: 0,
    policy: { combat: { enderman_wait_ticks: WAIT_TICKS } },
    survival: { budgets: new Budgets() },
    position: { cell: new Vec3(0, 64, 0) },
  } as unknown as FightScene;
  const fight = new EndermanFight(scene, {} as FightWeapons, {} as FightMovement);
  const tick = async (count: number) => {
    for (let index = 0; index < count; index++) {
      await clock.advance(SLOW_TICK_MS, SLOW_TICK_MS);
      scene.elapsedTicks++;
    }
  };
  return { fight, scene, tick };
}

test("the enderman defensive hold ends at 30 s of wall time on a slow server, with 150 of its 300 ticks counted", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { fight, tick } = endermanFight(clock, "hold");
  assert.ok(fight.heldTarget);
  await tick(149);
  assert.equal(fight.heldTarget.exhausted, false);
  await tick(1);
  assert.equal(fight.heldTarget.exhausted, true);
  fight.heldTarget.observe("confirmed_target_damage");
  assert.equal(fight.heldTarget.exhausted, false, "confirmed damage renews the wall twin with the ticks");
  await tick(149);
  assert.equal(fight.heldTarget.exhausted, false);
  await tick(1);
  assert.equal(fight.heldTarget.exhausted, true);
});

test("the enderman provocation and roof windows end at 30 s of wall time, not 60 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const { fight, tick } = endermanFight(clock, "pursue");
  const provoking = fight.provokeRoof({} as RoofPosition);
  assert.equal(provoking.kind, "provoking");
  if (provoking.kind !== "provoking") return;
  using _provocation = provoking.budget;
  using roof = fight.targetWindow("enderman_roof", "target:7:cell:0,64,0");
  await tick(149);
  assert.deepEqual([provoking.budget.exhausted, roof.exhausted], [false, false]);
  await tick(1);
  assert.deepEqual([provoking.budget.exhausted, roof.exhausted], [true, true]);
});
