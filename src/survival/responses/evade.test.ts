import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { evade } from "./evade.js";

const EVADE_BUDGET_MS = 3_000;
const ROUTE_MS = 1_000;
const ZOMBIE = 7;

/**
 * An evade of a `EVADE_BUDGET_MS` budget whose first route takes `ROUTE_MS` of the installed clock, steps the wall clock
 * by `wallStepMs` meanwhile and ends one cell further with the zombie still in contact. Returns the navigation
 * timeout the second route was given: what the budget still had left.
 */
async function secondRouteTimeoutAcrossWallStep(wallStepMs: number): Promise<number | undefined> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot } = createFakeBot({ clock, entities: { [ZOMBIE]: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
  using _installed = clock.install();
  // Live the two clocks read unrelated values (uptime vs epoch): a budget started on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const timeouts: number[] = [];
  const navigation = {
    navigate: async ({ timeoutMs }: { timeoutMs?: number }) => {
      timeouts.push(timeoutMs ?? NaN);
      await clock.sleep(ROUTE_MS);
      if (timeouts.length === 1) clock.stepWallClock(wallStepMs);
      bot.entity.position.x -= 1;
      return { status: "completed" as const, elapsedMs: ROUTE_MS };
    },
  } as unknown as NavigationRuntime;
  const context = { ...combatTestContext(bot), policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: EVADE_BUDGET_MS } };
  const threat = { id: ZOMBIE, name: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2 };
  await clock.settle(
    evade(bot, navigation, { kind: "evade", threats: [threat], safeRange: 36, reason: "hurt" }, context, bot.health, new AbortController().signal),
    EVADE_BUDGET_MS + 5_000,
  );
  return timeouts[1];
}

for (const wallStepMs of [-800, 1_200]) {
  test(`the evade budget counts monotonic time: a ${wallStepMs} ms wall step during the first route leaves 2000 ms`, async () => {
    assert.equal(await secondRouteTimeoutAcrossWallStep(wallStepMs), EVADE_BUDGET_MS - ROUTE_MS);
  });
}

/**
 * An evade whose settled body holds its shield against a fireball that never clears: the projectile guard ends at the
 * evade budget, though the wall clock steps by `wallStepMs` a second in. Returns the clock the evade ran.
 */
async function evadeGuardedUntilBudgetAcrossWallStep(wallStepMs: number): Promise<number> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot, entities } = createFakeBot({
    clock,
    slots: { 45: { name: "shield" } },
    entities: { [ZOMBIE]: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  clock.stepWallClock(5_000);
  entities.spawn({ id: 8, name: "small_fireball", width: 0.3125, position: new Vec3(4, 64.9, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  clock.after(1_000, () => clock.stepWallClock(wallStepMs));
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++) {
      world.load({ x, y: 63, z }, { stateId: 1 });
      world.load({ x, y: 64, z }, { stateId: 0 });
      world.load({ x, y: 65, z }, { stateId: 0 });
    }
  const navigation = {
    world,
    navigate: async () => assert.fail("a settled body under fire guards before it routes"),
  } as unknown as NavigationRuntime;
  const context = { ...combatTestContext(bot), policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: EVADE_BUDGET_MS } };
  const threat = { id: ZOMBIE, name: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2 };
  const started = clock.now();
  await clock.settle(
    evade(bot, navigation, { kind: "evade", threats: [threat], safeRange: 36, reason: "hurt" }, context, bot.health, new AbortController().signal),
    20_000,
  );
  return clock.now() - started;
}

for (const wallStepMs of [-800, 1_200]) {
  test(`the retreat guard ends at the evade budget: a ${wallStepMs} ms wall step during the guard leaves it at 3 s`, async () => {
    const ranMs = await evadeGuardedUntilBudgetAcrossWallStep(wallStepMs);
    assert.ok(ranMs >= EVADE_BUDGET_MS && ranMs < EVADE_BUDGET_MS + 200, `the evade ran ${ranMs} ms of clock, not its ${EVADE_BUDGET_MS} ms budget`);
  });
}
