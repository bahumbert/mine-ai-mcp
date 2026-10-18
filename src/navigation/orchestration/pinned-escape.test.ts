import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { loadNamedBlock } from "../../test-support/layered-world.js";
import { DIRK_CAVE, DIRK_START, SANA_CAVE, SANA_START, dirkPocket, sanaPocket } from "../../test-support/frozen-pockets.js";
import { FakeNavigationBot, flatWorld, observation, onEvent, settle } from "../../test-support/navigation.js";
import { exactBlockGoal } from "../goals/index.js";
import type { PlannedStep } from "../movements/movement.js";
import { createMovementPolicy, type MovementPolicy } from "../movements/policy.js";
import { createMovements } from "../runtime.js";
import type { NavigationEvent } from "../telemetry/index.js";
import type { MemoryWorld } from "../world/memory-world.js";
import type { BlockPosition } from "../world/world.js";
import { FAILED_EDGE_MEMORY_MS } from "./failed-edges.js";
import { createNavigator } from "./navigator.js";

/**
 * Run 15: Dirk and Sana stood pinned for hours because their persona's style override (`dig_straight_down: false`)
 * left no first move. The policy here reads the override live, like the production one, so a test can see the run
 * never changes it.
 */
function styledPolicy(bot: ReturnType<typeof botFixture>, override: { digDown: boolean }): MovementPolicy {
  return Object.freeze({ ...createMovements(bot), get allowDownward() { return override.digDown; } });
}

async function leavePocket(world: (bot: ReturnType<typeof botFixture>) => MemoryWorld, start: BlockPosition, cave: BlockPosition,
  options: { digDown?: boolean; escape?: boolean; edit?: (world: MemoryWorld, bot: ReturnType<typeof botFixture>) => void; cancelOn?: string } = {}) {
  const bot = botFixture({ position: new Vec3(start.x + 0.5, start.y, start.z + 0.5) });
  const override = { digDown: options.digDown ?? false };
  const memory = world(bot);
  options.edit?.(memory, bot);
  const events: NavigationEvent[] = [];
  const fake = new FakeNavigationBot();
  fake.current = observation(start.x, start.y, start.z);
  let cancel: (() => void) | undefined;
  const navigator = createNavigator({ world: memory, bot: fake, telemetry: onEvent((event) => {
    events.push(event);
    if (event.kind === options.cancelOn) cancel?.();
  }) });
  const admission = navigator.startRun({ goal: exactBlockGoal(cave), policy: styledPolicy(bot, override), ...(options.escape && { escape: true }) });
  if (admission.kind !== "started") throw new Error("busy");
  cancel = () => admission.handle.cancel("died");
  const outcome = await admission.handle.outcome;
  return { outcome, events, override, navigator };
}

const kinds = (events: readonly NavigationEvent[]) => events.map((event) => event.kind);

test("Dirk's pocket with dig_straight_down off: the run digs down once, says what it set aside, and the override stays", async () => {
  const run = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE);
  assert.equal(kinds(run.events).filter((kind) => kind === "escape_relaxed").length, 1);
  const relaxed = run.events.find((event) => event.kind === "escape_relaxed");
  assert.deepEqual(relaxed?.kind === "escape_relaxed" ? relaxed.relaxed : null, ["dig_straight_down", "dig_next_to_flowing_water"]);
  assert.ok(kinds(run.events).indexOf("route_committed") > kinds(run.events).indexOf("escape_relaxed"), "a route follows the escape");
  assert.equal(run.override.digDown, false, "the style override is untouched");
  assert.deepEqual(run.outcome.evidence.escapeRelaxed, ["dig_straight_down", "dig_next_to_flowing_water"]);
});

test("Dirk's pocket with the dig allowed needs no escape", async () => {
  const run = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, { digDown: true });
  assert.ok(!kinds(run.events).includes("escape_relaxed"));
  assert.deepEqual(run.outcome.evidence.escapeRelaxed ?? [], []);
});

test("a request marked escape digs down from the first search, without a failed search before it", async () => {
  const run = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, { escape: true });
  const kind = kinds(run.events);
  assert.equal(kind.filter((entry) => entry === "escape_relaxed").length, 1);
  assert.ok(kind.indexOf("escape_relaxed") < kind.indexOf("search_started"));
  assert.ok(!kind.includes("calculation_failed"));
});

test("the escape keeps the fall limits: a pocket over a 6-deep drop is refused, over a 1-deep floor it is taken", async () => {
  const deep = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, {
    edit: (world) => { for (let y = 54; y >= 49; y -= 1) world.load({ x: -549, y, z: -50 }, { stateId: 0 }); },
  });
  assert.equal(deep.outcome.kind, "failed");
  assert.ok(!kinds(deep.events).includes("route_committed"), "no route over the drop");
  const shallow = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE);
  assert.ok(kinds(shallow.events).includes("route_committed"));
});

test("Sana's pocket: falling water beside her cell is let through in the escape, the dig opens into nothing but flowing water", async () => {
  const run = await leavePocket(sanaPocket, SANA_START, SANA_CAVE);
  const kind = kinds(run.events);
  assert.equal(kind.filter((entry) => entry === "escape_relaxed").length, 1);
  assert.ok(kind.indexOf("route_committed") > kind.indexOf("escape_relaxed"), "a route follows the escape");
  assert.deepEqual(run.outcome.evidence.escapeRelaxed, ["dig_straight_down", "dig_next_to_flowing_water"]);
});

test("Sana's pocket with one water source beside the opened cell stays shut and says why", async () => {
  const run = await leavePocket(sanaPocket, SANA_START, SANA_CAVE, {
    edit: (world, bot) => loadNamedBlock(world, bot, { x: -454, y: 57, z: 100 }, "water"),
  });
  assert.ok(!kinds(run.events).includes("route_committed"));
  assert.equal(run.outcome.kind, "failed");
  if (run.outcome.kind !== "failed" || run.outcome.failure.kind !== "no_path") return assert.fail(JSON.stringify(run.outcome));
  assert.ok((run.outcome.failure.search.startRefusals?.opens_into_liquid ?? 0) >= 1);
});

test("lava beside the opened cell is never let through", async () => {
  const run = await leavePocket(sanaPocket, SANA_START, SANA_CAVE, {
    edit: (world, bot) => loadNamedBlock(world, bot, { x: -454, y: 57, z: 100 }, "lava"),
  });
  assert.ok(!kinds(run.events).includes("route_committed"));
});

test("two bots pinned at once each escape once: the escape is the run's own state", async () => {
  const [first, second] = await Promise.all([
    leavePocket(dirkPocket, DIRK_START, DIRK_CAVE),
    leavePocket(dirkPocket, DIRK_START, DIRK_CAVE),
  ]);
  for (const run of [first, second]) assert.equal(kinds(run.events).filter((kind) => kind === "escape_relaxed").length, 1);
  const third = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE);
  assert.equal(kinds(third.events).filter((kind) => kind === "escape_relaxed").length, 1, "a later run on a fresh runtime escapes again");
});

test("a death during the escape stops the run cleanly", async () => {
  const run = await leavePocket(dirkPocket, DIRK_START, DIRK_CAVE, { cancelOn: "escape_relaxed" });
  assert.equal(run.outcome.kind, "stopped");
  assert.equal(run.navigator.active, null);
  assert.deepEqual(run.outcome.evidence.cleanup, { listeners: 0, controls: 0, expectations: 0 });
});

// ── A failed edge is remembered by that bot's next requests (run 15, Finn) ───────────────

/** A bot whose body cannot make the swim under the lip: the one step from the start into x 1, z 0 fails, as Finn's did. */
class LipBot extends FakeNavigationBot {
  readonly attempted: string[] = [];
  override async prepareMovement(step: PlannedStep) {
    this.attempted.push(step.id);
    if (step.from.x === 0 && step.from.z === 0 && step.to.x === 1 && step.to.z === 0) return { kind: "failed", observation: "No observed settled arrival under the lip" } as const;
    this.arrive(step.to);
    return { kind: "completed", arrival: step.to } as const;
  }
}

async function requestPast(navigator: ReturnType<typeof createNavigator>, bot: LipBot) {
  bot.current = observation(0, 63, 0);
  return settle(navigator, { goal: exactBlockGoal({ x: 3, y: 63, z: 0 }), policy: createMovementPolicy({ allowSprinting: false }) });
}

test("an edge that failed twice is planned around by the next request of the same bot, until ten minutes pass", async () => {
  let now = 0;
  const bot = new LipBot();
  const navigator = createNavigator({ world: flatWorld(), bot, now: () => now });
  const first = await requestPast(navigator, bot);
  assert.equal(first.kind, "failed");
  if (first.kind !== "failed" || first.failure.kind !== "no_progress") return assert.fail(JSON.stringify(first));
  assert.equal(first.failure.reason, "repeated_movement_failure");

  const attemptsBefore = bot.attempted.length;
  const second = await requestPast(navigator, bot);
  assert.equal(second.kind, "completed", bot.attempted.join(" ") + JSON.stringify(second.kind === "failed" ? second.failure : null));
  assert.ok(!bot.attempted.slice(attemptsBefore).some((id) => id.includes("0,63,0>1,63,0")), bot.attempted.slice(attemptsBefore).join(" "));

  now += FAILED_EDGE_MEMORY_MS;
  const third = await requestPast(navigator, bot);
  assert.equal(third.kind, "failed", "the lip is still there");
  assert.ok(bot.attempted.slice(attemptsBefore).some((id) => id.includes("0,63,0>1,63,0")), "the edge is tried again once the memory expired");
});

test("another bot's navigator does not know the edge", async () => {
  const bot = new LipBot();
  await requestPast(createNavigator({ world: flatWorld(), bot }), bot);
  const other = new LipBot();
  const outcome = await requestPast(createNavigator({ world: flatWorld(), bot: other }), other);
  assert.equal(outcome.kind, "failed", "it plans the same edge and fails on it itself");
});
