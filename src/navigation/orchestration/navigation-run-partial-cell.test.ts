// navigation run: a run that starts inside a partial cell (beside an off-centre box) steps out once, or fails.
import { nearGoal } from "../goals/index.js";
import { createMovementPolicy } from "../movements/policy.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";

/** A stalk-like box, 0.2 wide and off centre, in a cell: the body can stand in the cell flush with it. */
const STALK = { minX: 0.6, minY: 0, minZ: 0.4, maxX: 0.8, maxY: 1, maxZ: 0.6 };

function worldWithStalks(cells: readonly number[], walls: readonly (readonly [number, number])[] = []) {
  const world = flatWorld();
  for (const x of cells) for (const y of [63, 64]) world.load({ x, y, z: 0 }, { stateId: 5, collisionShapes: [STALK] });
  for (const [x, z] of walls) for (const y of [63, 64]) world.load({ x, y, z }, { stateId: 1 });
  return world;
}

/** The body flush with the stalk of cell `x`, its centre inside that cell. */
const beside = (x: number) => ({ ...observation(x), position: { x: x + 0.29, y: 63, z: 0.5 } });

test("a run starting inside a partial cell steps out to the clear side, then plans from there", async () => {
  const bot = new FakeNavigationBot();
  bot.current = beside(1);
  const cells: unknown[] = [];
  const centred = bot.centerOnCell.bind(bot);
  bot.centerOnCell = async (cell, ...rest) => {
    cells.push(cell);
    return centred(cell, ...rest);
  };
  const statuses: unknown[] = [];
  const starts: number[] = [];
  const navigator = createNavigator({
    world: worldWithStalks([1]),
    bot,
    telemetry: onEvent((event) => {
      if (event.kind === "route_committed") starts.push(event.plan.start.x);
    }),
  });
  const stepOut = bot.centerOnCell;
  bot.centerOnCell = async (cell, ...rest) => {
    statuses.push(navigator.active?.kind === "stabilizing" ? navigator.active.reason : navigator.active);
    return stepOut(cell, ...rest);
  };
  const outcome = await settle(navigator, { goal: nearGoal({ x: -3, y: 63, z: 0 }, 0), policy: createMovementPolicy() });
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(cells, [{ x: 0, y: 63, z: 0 }]);
  assert.deepEqual(starts.slice(0, 1), [0], "the first route starts in the cell stepped out to");
  assert.deepEqual(statuses, ["inside_partial_block"]);
});

test("a run boxed in beside a stalk fails once with the observation and does not move or plan", async () => {
  const bot = new FakeNavigationBot();
  bot.current = beside(1);
  let centred = 0;
  bot.centerOnCell = async () => {
    centred++;
    return true;
  };
  const events: string[] = [];
  const navigator = createNavigator({
    world: worldWithStalks([1], [[0, 0], [2, 0], [1, 1], [1, -1]]),
    bot,
    telemetry: onEvent((event) => events.push(event.kind)),
  });
  const outcome = await settle(navigator, { goal: nearGoal({ x: -3, y: 63, z: 0 }, 0), policy: createMovementPolicy() });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed" || outcome.failure.kind !== "movement_failed") return assert.fail(JSON.stringify(outcome));
  assert.deepEqual(outcome.failure.movement, {
    kind: "unstable",
    stepId: "leave_partial_cell",
    phase: "moving",
    observation: "Standing inside the partial block at 1,63,0 with no clear side to step out to.",
  });
  assert.equal(centred, 0);
  assert.equal(events.includes("route_committed"), false);
});

test("a step out that does not arrive fails the run", async () => {
  const bot = new FakeNavigationBot();
  bot.current = beside(1);
  bot.centerOnCell = async () => false;
  const outcome = await settle(createNavigator({ world: worldWithStalks([1]), bot }), {
    goal: nearGoal({ x: -3, y: 63, z: 0 }, 0),
    policy: createMovementPolicy(),
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed" && outcome.failure.kind === "movement_failed")
    assert.equal(outcome.failure.movement.stepId, "leave_partial_cell");
});

test("a second partial cell in the same run fails at once instead of looping", async () => {
  const bot = new FakeNavigationBot();
  bot.current = beside(1);
  let centred = 0;
  bot.centerOnCell = async () => {
    centred++;
    bot.current = beside(-3);
    return true;
  };
  const outcome = await settle(createNavigator({ world: worldWithStalks([1, -3]), bot }), {
    goal: nearGoal({ x: -5, y: 63, z: 0 }, 0),
    policy: createMovementPolicy(),
  });
  assert.equal(outcome.kind, "failed");
  assert.equal(centred, 1);
});

test("an abort during the step out stops the run and leaves no control held", async () => {
  const bot = new FakeNavigationBot();
  bot.current = beside(1);
  const abort = new AbortController();
  bot.centerOnCell = async () => {
    abort.abort("operator stop");
    return false;
  };
  const outcome = await settle(createNavigator({ world: worldWithStalks([1]), bot }), {
    goal: nearGoal({ x: -3, y: 63, z: 0 }, 0),
    policy: createMovementPolicy(),
    signal: abort.signal,
  });
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});
