// Expected route failures must be action-owned failures without a relaxed escape.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { navigateResultSchema } from "../../../src/actions/navigate/contract.ts";
import { formatNavigateResult } from "../../../src/actions/navigate/navigate.ts";
import { createViewStatusAction } from "../../../src/actions/view-status/view-status.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./navigate-route.ts";

const DIGGING_OFF = "not dug because this request has digging off";
const NAVIGATION = {
  startDimension: "overworld", endDimension: "overworld", target: { x: 0, y: -45, z: 0 }, range: 0,
  start: { x: 0.5, y: -56, z: 0.5 }, end: { x: 0.5, y: -56, z: 0.5 }, remainingDistance: 11,
  elapsedMs: 1, scaffolding: [], bucketDrops: { count: 0, waterRecovered: 0 }, missingDigTools: [],
  digs: { count: 0, ms: 0, byHand: 0, byHandMs: 0, byHandBlocks: [], fasterWith: [] },
};

test("an expected failure accepts only the matching failed route with no relaxed escape evidence", async () => {
  const scenario = scenarioDefinitionSchema.parse({
    params: { legs: [{ label: "shut in", target: [0, -45, 0], range: 0, dig: false, expectFailure: DIGGING_OFF }] },
    goal: { kind: "completion" },
  });
  for (const { label, status, error, escapeRelaxed, want } of [
    { label: "relaxed escape", status: "failed", error: DIGGING_OFF, escapeRelaxed: ["dig_straight_down"], want: "failed" },
    { label: "present empty receipt", status: "failed", error: DIGGING_OFF, escapeRelaxed: [], want: "failed" },
    { label: "matching failure", status: "failed", error: DIGGING_OFF, want: "succeeded" },
    { label: "wrong reason", status: "failed", error: "unloaded", want: "failed" },
    { label: "partial", status: "partial", error: DIGGING_OFF, want: "failed" },
    { label: "cancelled", status: "cancelled", error: DIGGING_OFF, want: "failed" },
  ]) {
    const result = navigateResultSchema.parse({
      status, error,
      navigation: { ...NAVIGATION, ...(escapeRelaxed === undefined ? {} : { escapeRelaxed }) },
    });
    const context = scenarioTestContext({
      scenario,
      call: async () => ({ action: "navigate", durationMs: 1, result, summary: formatNavigateResult(result) }),
    });
    assert.equal((await run(context)).status, want, label);
  }
});

const ROUTE_LEGS = [
  { label: "first", target: [0, 64, 0], range: 0 },
  { label: "second", target: [6, 64, 0], range: 0 },
];

/**
 * The two-leg route on a mocked clock at `rate` tps. Each navigate answer (at once, as the fake does) puts the bot on
 * its marker; with `stopFirst` the server stops inside the first navigate, before it answers.
 */
function routeFixture(rate: number, stopFirst: boolean) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: rate }, position: new Vec3(0.5, 64, 0.5), health: 20 });
  const status = createViewStatusAction(bot, temporaryBotData({ botId: "NavigateRoute" }), () => ({ owner: "idle", activeAction: null }));
  const navigateAges: number[] = [];
  const arrivalAges: number[] = [];
  let stoppedAge = -1;
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({ params: { legs: ROUTE_LEGS }, goal: { kind: "completion" } }),
    call: async (action) => {
      if (action === "view_status") {
        arrivalAges.push(bot.time.age);
        const result = await status.execute({}, {});
        return { action, durationMs: 0, summary: "status", result };
      }
      const [x, y, z] = ROUTE_LEGS[navigateAges.length]!.target;
      navigateAges.push(bot.time.age);
      bot.entity.position = new Vec3(x + 0.5, y, z + 0.5);
      if (stopFirst && navigateAges.length === 1) {
        server.stop();
        stoppedAge = bot.time.age;
      }
      return { action, durationMs: 1, summary: "navigated", result: { status: "succeeded" } };
    },
  });
  return { clock, bot, navigateAges, arrivalAges, stoppedAge: () => stoppedAge, pending: () => run(context) };
}

for (const rate of [20, 10]) {
  test(`each leg of a route arrives at least 10 server ticks after its navigate answer at ${rate} tps`, async () => {
    const route = routeFixture(rate, false);
    using _timers = route.clock.install();
    const result = await route.clock.settle(route.pending(), 31_000);
    assert.equal(result.status, "succeeded", result.detail ?? "no detail");
    assert.equal(route.navigateAges.length, 2);
    assert.equal(route.arrivalAges.length, 2);
    route.arrivalAges.forEach((age, leg) => {
      assert.ok(age - route.navigateAges[leg]! >= 10, `leg ${leg}: ${age - route.navigateAges[leg]!} server ticks`);
    });
    await route.clock.advance(31_000);
    assert.equal(route.navigateAges.length, 2);
    assert.equal(route.arrivalAges.length, 2);
  });

  test(`a server clock stopped during the arrival wait fails the route without a second leg at ${rate} tps`, async () => {
    const route = routeFixture(rate, true);
    using _timers = route.clock.install();
    const result = await route.clock.settle(route.pending(), 31_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /server clock stopped during the arrival wait/);
    assert.equal(route.bot.time.age, route.stoppedAge());
    assert.equal(route.navigateAges.length, 1);
    assert.equal(route.arrivalAges.length, 0);
    await route.clock.advance(31_000);
    assert.equal(route.navigateAges.length, 1);
    assert.equal(route.arrivalAges.length, 0);
  });
}
