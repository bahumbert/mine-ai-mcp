// ActionRunner: the escape for a pinned bot and when movement actions may take it.
import assert from "node:assert/strict";
import test from "node:test";
import type { StallClock } from "../actions/stall-watch.js";
import { ActionRunner } from "./action-runner.js";
import { RouteOutcomes } from "../navigation/index.js";
import { PinnedWatch, type PinnedEscape } from "./pinned-watch.js";
import { stubAction } from "./action-runner-fixtures.test.js";

// ── Pinned watch (run 15: bots pinned for hours) ─────────────────────────────

const PINNED_MINUTES = 10 * 60_000;

/** A pinned bot's runner: a hand-stepped clock, a body the test moves, and an escape that records what it did. */
function pinnedRunner() {
  let now = 0;
  const clock: StallClock = { now: () => now, every: () => () => {} };
  const body = { x: 0, z: 0 };
  const position = () => ({ dimension: "overworld", x: body.x, y: 64, z: body.z });
  const watch = new PinnedWatch({ position, clock });
  const log: string[] = [];
  let routesAsEscape = false;
  const escape: PinnedEscape = {
    leave: async () => { log.push("leave"); },
    routesAsEscape: () => {
      routesAsEscape = true;
      return { [Symbol.dispose]: () => { routesAsEscape = false; } };
    },
  };
  const routes = new RouteOutcomes();
  const runner = new ActionRunner({ position, clock, pinned: watch, pinnedEscape: escape, routes });
  const failing = stubAction(async () => {
    routes.note({ status: "stopped", reason: "no path found", elapsedMs: 5, calculationFailed: true, routeFailed: true });
    return { status: "failed", error: "dead end: dig into water 4" };
  }, { kind: "task" }, "travel");
  const pin = async () => {
    for (let n = 0; n < 3; n++) await runner.run(failing, { block_name: "stone" });
    now += PINNED_MINUTES;
  };
  return { runner, watch, body, log, failing, pin, routes, escaping: () => routesAsEscape, advance: (ms: number) => { now += ms; } };
}

/** A movement action that failed without its route failing: nothing usable near, a tool lost, a full inventory. */
const failingWithoutRoute = (movement: "travel" | "work") =>
  stubAction(async () => ({ status: "failed", error: "none usable near" }), { kind: "task" }, movement);

test("a pinned bot's next movement action leaves the water or boat first and runs its routes as an escape", async () => {
  const { runner, log, pin, escaping } = pinnedRunner();
  await pin();
  let escapingDuringRun = false;
  const movement = stubAction(async () => {
    escapingDuringRun = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(log, ["leave"]);
  assert.equal(escapingDuringRun, true);
  assert.equal(escaping(), false, "the escape ends with the action");
});

test("the escape's relaxed routing lasts until a pinned movement action settles, not until it first awaits", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let escapingAfterAwait: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingAfterAwait = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(escapingAfterAwait, true, "the hold was still open when the action's route ran");
  assert.equal(escaping(), false, "and it is released with the result");
});

test("a pinned movement action that fails after its first await still releases the escape hold", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let escapingAfterAwait: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingAfterAwait = escaping();
    throw new Error("route exploded");
  }, { kind: "task" }, "travel");
  const result = (await runner.run(movement, { block_name: "stone" })).result;
  assert.equal(result.status, "failed");
  assert.equal(escapingAfterAwait, true);
  assert.equal(escaping(), false, "a failed escape does not leave the next route relaxed");
});

test("a pinned movement action cancelled mid-run releases the escape hold when it settles", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const movement = stubAction(async (_request, context) => {
    started();
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "cancelled", error: "stopped" };
  }, { kind: "task" }, "travel");
  const request = runner.run(movement, { block_name: "stone" });
  await running;
  assert.equal(escaping(), true, "the hold is open while the action runs");
  runner.cancelActive("operator stop");
  await request;
  assert.equal(escaping(), false);
});

test("a movement action of a bot that is not pinned never takes the escape hold", async () => {
  const { runner, escaping, log } = pinnedRunner();
  let escapingDuringRun: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingDuringRun = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(escapingDuringRun, false);
  assert.deepEqual(log, []);
});

test("a bot that failed twice and sat ten minutes runs its next movement action without an escape", async () => {
  const { runner, log, failing, body } = pinnedRunner();
  await runner.run(failing, { block_name: "stone" });
  await runner.run(failing, { block_name: "stone" });
  body.x = 0.2;
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  await runner.run(movement, { block_name: "stone" });
  assert.equal(ran, true);
  assert.deepEqual(log, []);
});

test("an escape that leaves the bot in place makes movement actions fail at once with [PINNED], other actions still run", async () => {
  const { runner, pin, failing } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  let ran = 0;
  const movement = stubAction(async () => { ran++; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  const refused = (await runner.run(movement, { block_name: "stone" })).result;
  assert.equal(refused.status, "failed");
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\].*dig into water 4/u);
  assert.equal(ran, 0, "a refused movement action never reached the body");
  const other = stubAction(async () => { ran++; return { status: "succeeded" }; });
  assert.equal((await runner.run(other, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, 1);
});

test("after [PINNED], a move of 2 blocks by any action lets the next movement action run normally", async () => {
  const { runner, pin, failing, body, log } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  body.x = 2;
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, true);
  assert.deepEqual(log, ["leave"], "only the one escape ran; the freed bot needs no second");
});

test("a failing action that is not a movement action does not count toward pinned", async () => {
  const { runner, watch, body } = pinnedRunner();
  const notMovement = stubAction(async () => ({ status: "failed", error: "nope" }));
  for (let n = 0; n < 3; n++) await runner.run(notMovement, { block_name: "stone" });
  assert.equal(watch.isPinned(), false);
  body.x = 0;
});

test("ten minutes in one place and three movement failures that were not the route's leave the bot not pinned", async () => {
  const { runner, watch, log, advance } = pinnedRunner();
  for (const movement of ["travel", "work", "work"] as const) await runner.run(failingWithoutRoute(movement), { block_name: "stone" });
  advance(PINNED_MINUTES);
  assert.equal(watch.isPinned(), false);
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  await runner.run(movement, { block_name: "stone" });
  assert.deepEqual(log, [], "no escape ran: the bot was never pinned");
});

test("ten minutes in one place and three failed routes pin the bot", async () => {
  const { watch, pin } = pinnedRunner();
  await pin();
  assert.equal(watch.isPinned(), true);
});

test("a failure after a failed route that a later route made up for is not the route's", async () => {
  const { runner, watch, routes, advance } = pinnedRunner();
  const madeUp = stubAction(async () => {
    routes.note({ status: "stopped", reason: "no path found", elapsedMs: 5, routeFailed: true });
    routes.note({ status: "completed", elapsedMs: 5 });
    return { status: "failed", error: "[INVENTORY_FULL] all slots are occupied" };
  }, { kind: "task" }, "work");
  for (let n = 0; n < 3; n++) await runner.run(madeUp, { block_name: "stone" });
  advance(PINNED_MINUTES);
  assert.equal(watch.isPinned(), false);
});

test("a failed escape that was not the route's does not shut movement out", async () => {
  const { runner, pin } = pinnedRunner();
  await pin();
  await runner.run(failingWithoutRoute("travel"), { block_name: "stone" });
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, true, "an unsupported target is not an escape that left the bot in place");
});

test("after an escape failed, a work movement action (collecting what is within reach) still runs, as an escape", async () => {
  const { runner, pin, failing, log, escaping } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  const refused = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\]/u, "travel is shut out");
  assert.deepEqual(log, ["leave"]);
  let escapingDuringRun = false;
  const collect = stubAction(async () => { escapingDuringRun = escaping(); return { status: "succeeded" }; }, { kind: "task" }, "work");
  assert.equal((await runner.run(collect, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(log, ["leave", "leave"], "the collect left the water first, like the first escape");
  assert.equal(escapingDuringRun, true, "and its routes started as escapes");
});

test("two runners in one process escape and refuse independently", async () => {
  const first = pinnedRunner();
  const second = pinnedRunner();
  await first.pin();
  await first.runner.run(first.failing, { block_name: "stone" });
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  assert.equal((await second.runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(second.log, []);
  assert.equal((await first.runner.run(movement, { block_name: "stone" })).result.status, "failed");
});

test("a refused pinned bot runs the escape again after another window, and is refused again when it fails", async () => {
  const { runner, pin, failing, log, advance } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  assert.deepEqual(log, ["leave"]);
  const refused = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\]/u);
  assert.deepEqual(log, ["leave"], "refused without an escape inside the window");
  advance(PINNED_MINUTES);
  await runner.run(failing, { block_name: "stone" });
  assert.deepEqual(log, ["leave", "leave"], "the retry ran the escape");
  const again = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in again ? again.error : "", /^\[PINNED\]/u, "refusal resumes");
});

test("a retry escape that succeeds frees the next movement action", async () => {
  const { runner, pin, failing, advance } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  advance(PINNED_MINUTES);
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
});
