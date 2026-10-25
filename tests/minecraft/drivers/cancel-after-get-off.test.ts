import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf } from "../../../src/test-support/fake-bot/index.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./cancel-after-get-off.ts";

/** Moves x as well as z, so the target is read in the lane's frame, not the arena's. */
// check-reads: tests/minecraft/scenarios/pathfinder/boat-left-under-feet-by-shore.yaml, tests/minecraft/templates/**/*.yaml
const FRAME = arenaFrame({ x: 64, z: 512 });
const BOAT_ID = 100;
const SHIFT_PRESS = 0;

/** A bot standing beside a boat the ride ended at, in the lane. */
function botByBoat() {
  const harness = createFakeBot({
    position: new Vec3(100.5, -60, 512.5),
    entities: { [BOAT_ID]: { name: "oak_boat", position: new Vec3(100.5, -60.5, 512.5) } },
  });
  return { ...harness, boat: harness.bot.entities[BOAT_ID]! };
}

type Call = (action: string, input: Record<string, unknown>) => ReturnType<Parameters<typeof scenarioTestContext>[0]["call"]>;
const finished = (action: string, result: Record<string, unknown>) => ({ action, durationMs: 1, result, summary: `${action} ${String(result.status)}` }) as Awaited<ReturnType<Call>>;

function contextFor(harness: ReturnType<typeof botByBoat>, call: Call, onCancel: () => void = () => {}) {
  return scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: { target: [60, -60, 0], stateWaitMs: 100 }, goal: { kind: "completion" } }),
    arena: FRAME,
    bot: harness.bot,
    call: async (action, input) => {
      if (action === "cancel_foreground_action") onCancel();
      return call(action, input);
    },
  });
}

test("the cancel goes out at the shift of the get-off, and the second navigate from the boat she left must carry one boat", async () => {
  const harness = botByBoat();
  const asked: { action: string; input: Record<string, unknown> }[] = [];
  let navigates = 0;
  let resolveCancel: () => void = () => {};
  const cancelSeen = new Promise<void>((resolve) => void (resolveCancel = resolve));
  const context = contextFor(harness, async (action, input) => {
    asked.push({ action, input });
    if (action === "cancel_foreground_action") return finished(action, { status: "succeeded" });
    navigates += 1;
    if (navigates === 1) {
      harness.bot.entity.vehicle = harness.boat;
      harness.bot._client.write("entity_action", { entityId: harness.bot.entity.id, actionId: SHIFT_PRESS, jumpBoost: 0 });
      await cancelSeen;
      harness.bot.entity.vehicle = null as never;
      return finished(action, { status: "cancelled", error: "cancelled" });
    }
    harness.bot.inventory.updateSlot(36, itemOf(harness.bot.registry, "oak_boat"));
    return finished(action, { status: "succeeded" });
  }, () => resolveCancel());
  const completion = await run(context);
  assert.equal(completion.status, "succeeded", completion.detail ?? "");
  assert.deepEqual(asked.map(({ action }) => action), ["navigate", "cancel_foreground_action", "navigate"], "one cancel, at the shift press");
  assert.deepEqual(asked[0]?.input, { x: 124, y: -60, z: 512, range: 2 }, "the far land, in the lane");
  assert.deepEqual(asked[2]?.input, asked[0]?.input);
});

test("a navigate that was not cut (it succeeded, or no boat lies under her) is reported as the state not reached, before any second navigate", async () => {
  const succeeds = botByBoat();
  const calls: string[] = [];
  const first = await run(contextFor(succeeds, async (action) => (calls.push(action), finished(action, { status: "succeeded" }))));
  assert.equal(first.status, "failed");
  assert.match(first.detail ?? "", /state not reached/u);
  assert.deepEqual(calls, ["navigate"], "no second navigate");

  const noBoat = botByBoat();
  noBoat.entities.remove(BOAT_ID);
  const second = await run(contextFor(noBoat, async (action) => finished(action, { status: "failed", error: "no" })));
  assert.equal(second.status, "failed");
  assert.match(second.detail ?? "", /state not reached after \d+ ms \(seated false, boats carried 0, boat within 2 blocks false \(nearest of 0 boats none off/u);
});

test("a boat the server has not yet brought under her is waited for, then the second navigate goes on", async () => {
  const harness = botByBoat();
  harness.boat.position = new Vec3(103.5, -60.5, 512.5);
  const arrives = setTimeout(() => (harness.boat.position = new Vec3(100.5, -60.5, 512.5)), 40);
  let navigates = 0;
  const outcome = await run(contextFor(harness, async (action) => {
    navigates += 1;
    if (navigates === 2) harness.bot.inventory.updateSlot(36, itemOf(harness.bot.registry, "oak_boat"));
    return finished(action, { status: navigates === 1 ? "cancelled" : "succeeded" });
  }));
  clearTimeout(arrives);
  assert.equal(outcome.status, "succeeded", outcome.detail ?? "");
  assert.match(outcome.detail ?? "", /after [1-9]\d* ms of waiting/u);
});

test("a boat that never comes under her fails after the wait with the distance it read", async () => {
  const harness = botByBoat();
  harness.boat.position = new Vec3(103.5, -60.5, 512.5);
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse({ params: { target: [60, -60, 0], stateWaitMs: 200 }, goal: { kind: "completion" } }),
    arena: FRAME,
    bot: harness.bot,
    call: async (action) => finished(action, { status: "cancelled" }),
  });
  const outcome = await run(context);
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /state not reached after \d+ ms \(seated false, boats carried 0, boat within 2 blocks false \(nearest of 1 boats 3\.[0-9] off/u);
});

test("a second navigate that fails, or leaves no boat carried, fails the scenario with what it read", async () => {
  const stuck = botByBoat();
  const failing = await run(contextFor(stuck, async (action) => finished(action, { status: "failed", error: "ghost air" })));
  assert.equal(failing.status, "failed");
  assert.match(failing.detail ?? "", /read failed/u);

  const harness = botByBoat();
  let navigates = 0;
  const outcome = await run(contextFor(harness, async (action) => {
    navigates += 1;
    return finished(action, { status: navigates === 1 ? "failed" : "succeeded" });
  }));
  assert.equal(outcome.status, "failed");
  assert.match(outcome.detail ?? "", /0 boats carried/u);
});

test("the client's write is restored when the first navigate settles", async () => {
  const harness = botByBoat();
  const write = harness.bot._client.write;
  await run(contextFor(harness, async (action) => finished(action, { status: "failed", error: "x" })));
  assert.equal(harness.bot._client.write, write);
});

test("the scenario's own params are the ones the driver reads, and its first call is the navigate to the far land", async () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../scenarios/pathfinder/boat-left-under-feet-by-shore.yaml");
  const { client: _launch, ...scenario } = await loadScenario(file);
  const asked: { action: string; input: Record<string, unknown> }[] = [];
  const context = scenarioTestContext({
    scenario: scenarioDefinitionSchema.parse(scenario),
    bot: botByBoat().bot,
    call: async (action, input) => {
      asked.push({ action, input });
      throw new Error("stop");
    },
  });
  await assert.rejects(run(context), /stop/);
  assert.deepEqual(asked[0], { action: "navigate", input: { x: 60, y: -60, z: 0, range: 2 } });
});
