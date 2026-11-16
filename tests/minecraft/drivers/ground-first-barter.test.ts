// The ground-first driver waits for its fixture pearl to be readable on the client before it calls barter (plan 2026-11-17-p1-barter-a1 T3).
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import type { ActionResult } from "@aibengineering/mine-ai-mcp";
import { observeLiveSituation } from "../../../src/actions/view-status/view-status.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { run } from "./ground-first-barter.ts";

const ITEM = "ender_pearl";
const WAIT_EVENTS = ["entitySpawn", "entityUpdate", "itemDrop"] as const;
/** Past the longest deadline a case can have (the 9 000 ms wall backstop, 60 server ticks at 10 tps): nothing may fire then (T6). */
const PAST_EVERY_DEADLINE_MS = 20_000;
const { registry } = createFakeBot().bot;
/** An adult piglin as the live server types it: its registry id and Mineflayer's category, so `view_status` lists it as a mob. */
const adultPiglin = { name: "piglin", position: { x: 2.5, y: 64, z: 0.5 }, entityType: registry.entitiesByName.piglin!.id,
  kind: registry.entitiesByName.piglin!.category, metadata: [] };
const BARTER_SUCCESS: ActionResult = { status: "succeeded", barter: { piglinId: 2, item: ITEM, requested: 1, inventoryBefore: 0,
  inventoryAfter: 1, gained: 1, goldBudget: 3, goldOffers: 0, goldSpent: 0, dropsTakenByOthers: [] } } as ActionResult;

/** An item entity of `item` spawns `atTick` server ticks after the driver starts; 0 means it is on the ground before the start. */
interface Arrival { readonly atTick: number; readonly item: string }

/**
 * Run the driver on a fake server at `ticksPerSecond` with a piglin in front. Each action is recorded with the server's tick and the
 * fake-clock milliseconds since the start. After the driver returns, the clock is advanced past every deadline and the run reports
 * whether anything happened then (a late call, a timer left waiting).
 */
async function runFixture(ticksPerSecond: number, arrivals: readonly Arrival[], options: { stopped?: boolean; budgetMs?: number } = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, username: "Barterer", server: { ticksPerSecond },
    entities: { 2: adultPiglin } });
  const { bot, server, entities } = harness;
  const data = temporaryBotData({ botId: "Barterer" });
  const startTick = server.gameTime;
  const calls: { action: string; gameTime: number; ms: number }[] = [];
  const added = listenersAddedSince(bot);
  const spawnPearlLike = (item: string) => entities.spawn({ name: "item", position: { x: 5.5, y: 64, z: 0.5 }, item: { name: item, count: 1 } });
  for (const arrival of arrivals) if (arrival.atTick === 0) spawnPearlLike(arrival.item);
  let pending = arrivals.filter((arrival) => arrival.atTick > 0);
  const unsubscribe = server.onTick(() => {
    pending = pending.filter((arrival) => {
      if (server.gameTime - startTick < arrival.atTick) return true;
      spawnPearlLike(arrival.item);
      return false;
    });
  });
  const startMs = clock.now();
  const context = scenarioTestContext({ bot, scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" },
    params: { item_name: ITEM, count: 1, gold_budget: 3 } }),
  call: async (action) => {
    calls.push({ action, gameTime: server.gameTime, ms: clock.now() - startMs });
    const result = action === "view_status"
      ? { status: "succeeded", situation: observeLiveSituation(bot, data, () => ({ owner: "idle", activeAction: null })) } as ActionResult
      : BARTER_SUCCESS;
    return { action, durationMs: 0, result, summary: action } as ScenarioCall;
  } });
  if (options.stopped) server.stop();
  try {
    using _installed = clock.install();
    const completion = await clock.settle(run(context, clock.sleep), options.budgetMs ?? 10_000);
    const elapsedMs = clock.now() - startMs;
    const endTick = server.gameTime;
    const callsAtEnd = calls.length;
    await clock.advance(PAST_EVERY_DEADLINE_MS);
    return { completion, calls, startTick, endTick, elapsedMs, added,
      afterDeadline: { calls: calls.length - callsAtEnd, timers: clock.pendingTimers(), globalTimers: clock.pendingGlobalTimers(), endTickAfter: server.gameTime - endTick } };
  } finally {
    unsubscribe();
    data.close();
  }
}

/** Nothing the driver listens to may stay attached after it returns. */
function assertNoListenersLeft(added: (event: string) => number) {
  for (const event of WAIT_EVENTS) assert.equal(added(event), 0, `${event} listener left behind`);
}

/** Once the driver has returned, the clock moved past every deadline fires nothing and leaves no timer waiting (T6). */
function assertNothingAfterDeadline(afterDeadline: { calls: number; timers: number; globalTimers: number }) {
  assert.equal(afterDeadline.calls, 0, "an action was called after the driver returned");
  assert.equal(afterDeadline.timers, 0, "a fake-clock timer is still waiting");
  assert.equal(afterDeadline.globalTimers, 0, "a global timer is still pending");
}

for (const ticksPerSecond of [20, 10]) {
  const tickMs = 1_000 / ticksPerSecond;

  test(`at ${ticksPerSecond} tps the pearl spawns 5 server ticks after the start, and barter waits for it`, async () => {
    const { completion, calls, startTick, added, afterDeadline } = await runFixture(ticksPerSecond, [{ atTick: 5, item: ITEM }]);
    const barter = calls.find((call) => call.action === "barter");
    assert.ok(barter, "barter must be called");
    assert.ok(barter.gameTime >= startTick + 5, `barter called at tick ${barter.gameTime - startTick}, before the pearl spawned at tick 5`);
    assert.equal(barter.ms, 5 * tickMs, `barter must be called at the spawn's ${5 * tickMs} fake ms, not ${barter.ms}`);
    assert.equal(completion.status, "succeeded");
    assertNoListenersLeft(added);
    assertNothingAfterDeadline(afterDeadline);
  });

  test(`at ${ticksPerSecond} tps a pearl on the ground before the start gets barter with no wait`, async () => {
    const { completion, calls, startTick, added, afterDeadline } = await runFixture(ticksPerSecond, [{ atTick: 0, item: ITEM }]);
    const barter = calls.find((call) => call.action === "barter");
    assert.equal(barter?.gameTime, startTick);
    assert.equal(barter?.ms, 0, "no fake time passes before barter");
    assert.equal(completion.status, "succeeded");
    assertNoListenersLeft(added);
    assertNothingAfterDeadline(afterDeadline);
  });

  test(`at ${ticksPerSecond} tps an unrelated readable item does not stand for the pearl`, async () => {
    const { completion, calls, startTick, added, afterDeadline } = await runFixture(ticksPerSecond, [{ atTick: 0, item: "cobblestone" }, { atTick: 10, item: ITEM }]);
    const barter = calls.find((call) => call.action === "barter");
    assert.ok(barter, "barter must be called");
    assert.ok(barter.gameTime >= startTick + 10, `barter called at tick ${barter.gameTime - startTick}, before the pearl spawned at tick 10`);
    assert.equal(barter.ms, 10 * tickMs, `barter must be called at the pearl's spawn, ${10 * tickMs} fake ms, not ${barter.ms}`);
    assert.equal(completion.status, "succeeded");
    assertNoListenersLeft(added);
    assertNothingAfterDeadline(afterDeadline);
  });

  test(`at ${ticksPerSecond} tps a pearl that never spawns fails the fixture at the 40-tick answer bound, without barter`, async () => {
    const { completion, calls, startTick, endTick, elapsedMs, added, afterDeadline } = await runFixture(ticksPerSecond, []);
    assert.equal(calls.some((call) => call.action === "barter"), false, "barter must not be called");
    assert.equal(completion.status, "failed");
    assert.match(completion.detail, /^\[FIXTURE\] the fixture's ender_pearl was not readable within 40 server ticks of the start \(piglin seen: yes\)$/);
    assert.equal(endTick - startTick, 60, "the 40-tick packet-origin bound ends at server tick 60");
    assert.equal(elapsedMs, 60 * tickMs, `the bound ends at ${60 * tickMs} fake ms at ${ticksPerSecond} tps`);
    assertNoListenersLeft(added);
    assertNothingAfterDeadline(afterDeadline);
  });
}

test("with the server stopped the fixture wait ends at its wall backstop, without barter", async () => {
  const { completion, calls, startTick, endTick, elapsedMs, added, afterDeadline } = await runFixture(20, [{ atTick: 5, item: ITEM }], { stopped: true, budgetMs: 20_000 });
  assert.equal(calls.some((call) => call.action === "barter"), false, "barter must not be called");
  assert.equal(completion.status, "failed");
  assert.match(completion.detail, /^\[FIXTURE\] the fixture's ender_pearl was not readable within 40 server ticks of the start/);
  assert.equal(endTick, startTick, "a stopped server runs no tick");
  assert.ok(elapsedMs >= 9_000, `the wall backstop is 9 000 ms, the wait ended after ${elapsedMs} ms`);
  assertNoListenersLeft(added);
  assertNothingAfterDeadline(afterDeadline);
});
