import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../session/action-runner.js";
import { stubAction } from "../session/action-runner-fixtures.test.js";
import { clearCoverOnNewForeground } from "./foreground-cover.js";
import { createForegroundNavigation } from "./foreground-cover.js";
import { RouteOutcomes, type CoverExit } from "../navigation/index.js";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { createCombatController } from "../survival/control/combat/controller.js";
import { CombatPerception } from "../survival/perception/combat/observations.js";
import { FootingRecovery } from "../survival/responses/footing.js";
import { survivalResources } from "../survival/state/resources.js";

test("each new foreground action clears its predecessor's cover report, including an action with no route", async () => {
  const runner = new ActionRunner();
  let report: object | null = { reached: true };
  const unwatch = clearCoverOnNewForeground(runner, { clearCoverExit: () => { report = null; } });
  try {
    const action = stubAction(async () => {
      assert.equal(report, null);
      report = { reached: true };
      return { status: "succeeded" };
    });
    assert.equal((await runner.run(action, { block_name: "stone" })).result.status, "succeeded");
    assert.equal((await runner.run(action, { block_name: "stone" })).result.status, "succeeded");
  } finally { unwatch(); }
});

test("a real combat approach held by a foreground request never reports its exit from cover", async () => {
  const clock = createFakeClock({ mode: "manual" });
  const cells = Object.fromEntries(Array.from({ length: 4 }, (_, x) => [`${x},66,0`, "stone"]));
  const { bot } = createFakeBot({ clock, cells, groundY: 63, simulatePhysics: true, carried: { iron_sword: 1 },
    entities: { 42: { name: "cow", position: new Vec3(8.5, 64, 0.5) } } });
  const runner = new ActionRunner();
  const resources = new AsyncDisposableStack();
  const navigation = createForegroundNavigation(bot, runner, new RouteOutcomes(), resources, () => combat.activeEngagement() !== null);
  using perception = new CombatPerception(bot);
  using footing = new FootingRecovery(bot, navigation.world);
  const combat = createCombatController(bot, navigation, perception, footing, survivalResources());
  await combat.policy.edit({ operation: "set", expected_revision: combat.policy.snapshot().revision,
    changes: { navigation: { report_open_sky: true } }, lifetime: { kind: "session" }, reason: "report ordinary travel only" });
  const stop = new AbortController();
  const observed: { owner: string; engagement: string | undefined; coverExit: CoverExit | null }[] = [];
  navigation.onEvent((event) => {
    if (event.kind !== "route_committed") return;
    observed.push({ owner: runner.status().owner, engagement: combat.activeEngagement()?.kind, coverExit: navigation.coverExit() });
    stop.abort("real combat approach observed");
  });
  try {
    await clock.settle(runner.run(stubAction(async (_request, context) => {
      await combat.engage(42, context.signal!, "pursue");
      return { status: "succeeded" };
    }), { block_name: "stone" }, stop.signal), 20_000);
    assert.deepEqual(observed, [{ owner: "foreground", engagement: "mob", coverExit: null }]);
  } finally { await clock.settle(resources.disposeAsync(), 10_000); }
});
