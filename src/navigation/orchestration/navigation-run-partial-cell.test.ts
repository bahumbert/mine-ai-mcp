// navigation run: a run that starts inside a partial cell (beside an off-centre box) steps out once, digs out once, or fails.
import { nearGoal } from "../goals/index.js";
import type { EffectHandle } from "../bot.js";
import type { PlannedOperation } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { NavigationEvent } from "../telemetry/index.js";
import type { MemoryWorld } from "../world/memory-world.js";
import type { BlockPosition } from "../world/world.js";
import { createNavigator } from "./navigator.js";
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";

/** A stalk-like box, 0.2 wide and off centre, in a cell: the body can stand in the cell flush with it. */
const STALK = { minX: 0.6, minY: 0, minZ: 0.4, maxX: 0.8, maxY: 1, maxZ: 0.6 };
const AIR = { stateId: 0 };
const NO_TOOL = { itemType: null, expectedTicks: 10 } as const;

function worldWithStalks(cells: readonly number[], walls: readonly (readonly [number, number])[] = []) {
  const world = flatWorld();
  for (const x of cells) for (const y of [63, 64]) world.load({ x, y, z: 0 }, { stateId: 5, collisionShapes: [STALK] });
  for (const [x, z] of walls) for (const y of [63, 64]) world.load({ x, y, z }, { stateId: 1 });
  return world;
}

/** The body flush with the stalk of cell `x`, its centre inside that cell. */
const beside = (x: number) => ({ ...observation(x), position: { x: x + 0.29, y: 63, z: 0.5 } });

/** The four side cells (x, z) of the stalk cell at `x`, z 0. */
const sidesOf = (x: number): (readonly [number, number])[] => [[x - 1, 0], [x + 1, 0], [x, 1], [x, -1]];

/**
 * Ayla's pocket (live 2026-11-10, 344,83,298): a stalk in the feet and head cells over a stalk stub (no safe support),
 * the body at x + 0.7, z + 0.74 overlapping the stalk's box, every side cell blocked.
 */
function addPocket(world: MemoryWorld, x: number, open: readonly (readonly [number, number])[] = []) {
  for (const y of [63, 64]) world.load({ x, y, z: 0 }, { stateId: 5, collisionShapes: [STALK] });
  for (const [wx, wz] of sidesOf(x)) {
    if (open.some(([ox, oz]) => ox === wx && oz === wz)) continue;
    for (const y of [63, 64]) world.load({ x: wx, y, z: wz }, { stateId: 1 });
  }
  world.load({ x, y: 62, z: 0 }, { stateId: 5, collisionShapes: [STALK] });
  return world;
}
const pocketWorld = (x: number, open: readonly (readonly [number, number])[] = []) => addPocket(flatWorld(), x, open);
const inPocket = (x: number) => ({ ...observation(x), position: { x: x + 0.7, y: 63, z: 0.74 } });

/**
 * A bot that breaks what it is told to and passes game time: after a break it ticks, as the physics loop does.
 * `breaksStalkAbove` is the game's answer measured by the Mine Labs scenario `partial-cell-dig-out` (2026-11-13, 5
 * repeats on 1.21.4): the stalk above a broken stalk breaks by itself 0 to 2 physics ticks after it (facts
 * navigation-and-boats.md, "Partial cell dig-out"); the fake breaks it on the second tick. Tests that leave it off cover
 * a head box that stays, which the game was not seen to do.
 */
class DigBot extends FakeNavigationBot {
  readonly log: string[] = [];
  readonly breaks: BlockPosition[] = [];
  /** The navigator's status the moment each break was started. */
  readonly statusAtBreak: unknown[] = [];
  breaksStalkAbove = false;
  failBreaks = false;
  status: () => unknown = () => null;
  onPumpTick: (tick: number) => void = () => undefined;
  afterBreak: () => void = () => undefined;
  constructor(readonly world: MemoryWorld) {
    super();
  }
  override clearOwnedControls() {
    this.log.push("clear controls");
  }
  override startEffect(operation: Exclude<PlannedOperation, { kind: "move" }>): EffectHandle {
    if (operation.kind !== "break") return super.startEffect(operation);
    const cell = operation.position;
    this.log.push(`break ${cell.x},${cell.y},${cell.z}`);
    this.breaks.push(cell);
    this.statusAtBreak.push(this.status());
    if (this.failBreaks) {
      return { issued: true, completion: Promise.resolve({ kind: "failed", observation: "the server refused the break" }), cancel: () => undefined };
    }
    this.world.load(cell, AIR);
    this.current = { ...this.current, worldRevision: this.current.worldRevision + 1 };
    this.afterBreak();
    this.#pump(cell);
    return { issued: true, completion: Promise.resolve({ kind: "accepted" }), cancel: () => undefined };
  }
  #pump(broken: BlockPosition) {
    let tick = 0;
    const next = () => {
      tick += 1;
      if (this.breaksStalkAbove && tick === 2) this.world.load({ ...broken, y: broken.y + 1 }, AIR);
      for (const listener of [...this.ticks]) listener();
      this.onPumpTick(tick);
      if (tick < 100) setImmediate(next);
    };
    setImmediate(next);
  }
}

/** A bot with a navigator over `world`, and the events the run emitted. */
function digRun(world: MemoryWorld, start: ReturnType<typeof observation>, configure: (bot: DigBot) => void = () => undefined) {
  const bot = new DigBot(world);
  bot.current = start;
  configure(bot);
  const events: NavigationEvent[] = [];
  const navigator = createNavigator({ world, bot, telemetry: onEvent((event) => events.push(event)) });
  bot.status = () => (navigator.active?.kind === "stabilizing" ? navigator.active.reason : navigator.active);
  return { bot, events, navigator };
}
const GOAL = nearGoal({ x: -5, y: 63, z: 0 }, 0);
/** The sentence log readers grep, as it has always read. */
const stuckAt = (cell: string) => `Standing inside the partial block at ${cell} with no clear side to step out to.`;

function failureObservation(outcome: Awaited<ReturnType<typeof settle>>): string {
  if (outcome.kind !== "failed" || outcome.failure.kind !== "movement_failed") return assert.fail(JSON.stringify(outcome));
  assert.equal(outcome.failure.movement.stepId, "leave_partial_cell");
  return outcome.failure.movement.observation;
}

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

test("a run boxed in beside a stalk that may not dig fails once with the observation and does not move, plan or dig", async () => {
  const { bot, events, navigator } = digRun(worldWithStalks([1], sidesOf(1)), beside(1));
  let centred = 0;
  bot.centerOnCell = async () => {
    centred++;
    return true;
  };
  const outcome = await settle(navigator, { goal: nearGoal({ x: -3, y: 63, z: 0 }, 0), policy: createMovementPolicy({ allowDigging: false }) });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed" || outcome.failure.kind !== "movement_failed") return assert.fail(JSON.stringify(outcome));
  assert.deepEqual(outcome.failure.movement, {
    kind: "unstable",
    stepId: "leave_partial_cell",
    phase: "moving",
    observation: stuckAt("1,63,0"),
  });
  assert.equal(centred, 0);
  assert.equal(events.some((event) => event.kind === "route_committed"), false);
  assert.deepEqual(bot.breaks, []);
});

test("a step out that does not arrive fails the run, and a run that may not dig breaks nothing", async () => {
  const { bot, navigator } = digRun(worldWithStalks([1]), beside(1));
  bot.centerOnCell = async () => false;
  const outcome = await settle(navigator, { goal: nearGoal({ x: -3, y: 63, z: 0 }, 0), policy: createMovementPolicy({ allowDigging: false }) });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind === "failed" && outcome.failure.kind === "movement_failed")
    assert.equal(outcome.failure.movement.stepId, "leave_partial_cell");
  assert.deepEqual(bot.breaks, []);
});

test("a second partial cell in the same run fails at once instead of looping, and a run that may not dig breaks nothing", async () => {
  const { bot, navigator } = digRun(worldWithStalks([1, -3]), beside(1));
  let centred = 0;
  bot.centerOnCell = async () => {
    centred++;
    bot.current = beside(-3);
    return true;
  };
  const outcome = await settle(navigator, { goal: nearGoal({ x: -5, y: 63, z: 0 }, 0), policy: createMovementPolicy({ allowDigging: false }) });
  assert.equal(outcome.kind, "failed");
  assert.equal(centred, 1);
  assert.deepEqual(bot.breaks, []);
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

// ── Digging out of a pocket with no free side ────────────────────────────────

const stalkCells = (bot: DigBot, x: number) => bot.breaks.filter((cell) => cell.x === x);

test("a body held in Ayla's pocket clears its controls, breaks the feet cell, then plans from there and arrives", async () => {
  // `breaksStalkAbove`: measured by the scenario partial-cell-dig-out (see `DigBot`).
  const { bot, events, navigator } = digRun(pocketWorld(1), inPocket(1), (fake) => (fake.breaksStalkAbove = true));
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.deepEqual(stalkCells(bot, 1), [{ x: 1, y: 63, z: 0 }], "the stalk above broke by itself during the settle wait: not broken again");
  assert.equal(bot.statusAtBreak[0], "inside_partial_block");
  const breakAt = bot.log.indexOf("break 1,63,0");
  assert.equal(bot.log[breakAt - 1], "clear controls", "owned controls are cleared before the break");
  const firstRoute = events.find((event) => event.kind === "route_committed");
  assert.equal(firstRoute?.kind === "route_committed" && firstRoute.plan.start.x, 1, "the search starts in the dug-out cell");
  assert.equal(outcome.evidence.breaks, bot.breaks.length, "every break, the dig-out's too, is counted");
  assert.ok(bot.current.position.x < -4, "arrived at the goal");
});

test("a stalk above that is still there after the settle wait is broken too, feet first", async () => {
  const { bot, navigator } = digRun(pocketWorld(1), inPocket(1));
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.deepEqual(stalkCells(bot, 1), [{ x: 1, y: 63, z: 0 }, { x: 1, y: 64, z: 0 }]);
  assert.deepEqual(bot.statusAtBreak.slice(0, 2), ["inside_partial_block", "inside_partial_block"]);
});

test("a half-dug pocket (feet cell air, a stalk box only in the head cell beside the body) is planned from and fails within a bound", async () => {
  const world = worldWithStalks([], sidesOf(1));
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 5, collisionShapes: [STALK] });
  // Flush with the head stalk (body edge 1.6 = box edge 1.6) and clear of the wall cells' x range: nothing overlaps it.
  // A thin head-height box is not told from a chain or a trapdoor by its shape, so it is no partial cell: the run plans, and
  // the steps that cross the box stall as the live body's did (the box holds it) until the run reports the repeat.
  const { bot, navigator } = digRun(world, { ...observation(1), position: { x: 1.3, y: 63, z: 0.5 } });
  bot.prepareMovement = async () => ({ kind: "failed", observation: "the body did not move" }) as const;
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(outcome.kind, "failed", JSON.stringify(outcome));
  const attempts = Object.values(outcome.evidence.movementAttempts).reduce((total, count) => total + (count ?? 0), 0);
  assert.ok(attempts >= 1 && attempts <= 4, `bounded: ${attempts} movement attempts`);
  assert.deepEqual(stalkCells(bot, 1), [], "no dig-out of a cell that is no partial cell");
});

test("a cell in another owner's protected region is refused: today's sentence, then the reason", async () => {
  // Same shape as the "protects the ceiling" case of overhead-pin-release.test.ts: the policy's evaluateBreak refuses.
  const policy = createMovementPolicy({
    evaluateBreak: (_block, position) =>
      position.x === 1 && position.y === 63
        ? { decision: { kind: "prohibited", reason: "inside Lena's house region" }, tool: NO_TOOL }
        : { decision: { kind: "allowed" }, tool: NO_TOOL },
  });
  const { bot, navigator } = digRun(pocketWorld(1), inPocket(1));
  const outcome = await settle(navigator, { goal: GOAL, policy });
  assert.equal(failureObservation(outcome), `${stuckAt("1,63,0")} Digging out: inside Lena's house region`);
  assert.deepEqual(bot.breaks, []);
});

test("a cell that is not safe to break is refused: today's sentence, then the cell and why", async () => {
  const world = pocketWorld(1);
  world.load({ x: 1, y: 63, z: 0 }, { stateId: 5, collisionShapes: [STALK], traits: { safeToBreak: false } });
  const { bot, navigator } = digRun(world, inPocket(1));
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(failureObservation(outcome), `${stuckAt("1,63,0")} Digging out: 1,63,0, which is not safe to break.`);
  assert.deepEqual(bot.breaks, []);
});

test("a break the server does not confirm fails the run with the reason and counts no break", async () => {
  const { bot, navigator } = digRun(pocketWorld(1), inPocket(1), (fake) => (fake.failBreaks = true));
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(failureObservation(outcome), `${stuckAt("1,63,0")} Digging out: the server refused the break`);
  assert.equal(outcome.evidence.breaks, 0);
  assert.equal(bot.breaks.length, 1, "tried once, no retry loop");
});

test("an abort during the break stops the run and leaves nothing behind", async () => {
  const abort = new AbortController();
  const { bot, navigator } = digRun(pocketWorld(1), inPocket(1));
  bot.startEffect = () => {
    abort.abort("operator stop");
    let release!: (answer: { kind: "failed"; observation: string }) => void;
    const completion = new Promise<{ kind: "failed"; observation: string }>((resolve) => (release = resolve));
    return { issued: true, completion, cancel: () => release({ kind: "failed", observation: "cancelled" }) };
  };
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy(), signal: abort.signal });
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

test("an abort during the settle wait stops the run and leaves no listener or control", async () => {
  const abort = new AbortController();
  const { bot, navigator } = digRun(pocketWorld(1), inPocket(1), (fake) => {
    fake.onPumpTick = (tick) => {
      if (tick === 2) abort.abort("operator stop");
    };
  });
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy(), signal: abort.signal });
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
  assert.equal(bot.ticks.size, 0);
  assert.equal(stalkCells(bot, 1).length, 1, "the head cell was not broken after the abort");
});

test("a second pocket met after the dig-out fails at once, without a second dig-out", async () => {
  // `breaksStalkAbove` (measured, see `DigBot`), so the first dig-out is one break.
  const world = addPocket(pocketWorld(1), -3);
  const { bot, navigator } = digRun(world, inPocket(1), (fake) => {
    fake.breaksStalkAbove = true;
    fake.afterBreak = () => {
      if (fake.breaks.length === 1) fake.current = inPocket(-3);
    };
  });
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.match(failureObservation(outcome), new RegExp(`^${stuckAt("-3,63,0")} Digging out: `, "u"));
  assert.equal(bot.breaks.length, 1);
});

test("a pocket in the bot's own region opens its regions once, digs, and closes them at the run's end", async () => {
  // `breaksStalkAbove` (measured, see `DigBot`). The policy refuses the cell until `open()` is called, as the production policy's
  // house-levelling margin does (brain/src/skills.ts, `OwnRegionEscape`).
  let opened = false;
  let opens = 0;
  let closes = 0;
  const policy = createMovementPolicy({
    ownRegionEscape: { inside: () => true, open: () => ((opened = true), opens++), close: () => closes++ },
    evaluateBreak: (_block, position) =>
      !opened && position.x === 1 && position.y === 63
        ? { decision: { kind: "prohibited", reason: "inside the bot's own house region" }, tool: NO_TOOL }
        : { decision: { kind: "allowed" }, tool: NO_TOOL },
  });
  const { bot, events, navigator } = digRun(pocketWorld(1), inPocket(1), (fake) => (fake.breaksStalkAbove = true));
  const outcome = await settle(navigator, { goal: GOAL, policy });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.equal(opens, 1);
  assert.equal(events.filter((event) => event.kind === "own_regions_opened").length, 1);
  assert.deepEqual(stalkCells(bot, 1), [{ x: 1, y: 63, z: 0 }]);
  assert.equal(closes, 1, "closed once, at the run's end");
});

test("a step out that lands in a second closed pocket digs out of it, once", async () => {
  // `breaksStalkAbove`: measured (see `DigBot`).
  const world = addPocket(pocketWorld(1, [[0, 0]]), -3);
  const { bot, navigator } = digRun(world, inPocket(1), (fake) => {
    fake.breaksStalkAbove = true;
    fake.centerOnCell = async () => {
      fake.current = inPocket(-3);
      return true;
    };
  });
  const outcome = await settle(navigator, { goal: GOAL, policy: createMovementPolicy() });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.deepEqual(stalkCells(bot, -3), [{ x: -3, y: 63, z: 0 }]);
  assert.deepEqual(stalkCells(bot, 1), [], "the first pocket was stepped out of, not dug");
});
