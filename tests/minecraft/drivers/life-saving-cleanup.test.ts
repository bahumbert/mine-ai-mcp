// Cleanup confirmation returns on the server answer and reports a stopped clock.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { loadScenario } from "mine-labs";
import { Vec3 } from "vec3";
import { createViewStatusAction } from "../../../src/actions/view-status/view-status.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { removeLifeSavingPlacements } from "../../../src/world/life-saving-placements.ts";
import { setProtectedRegionsProvider } from "../../../src/world/protected-regions.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { run } from "./life-saving-cleanup.ts";

const scenario = await loadScenario(new URL("../scenarios/survival/life-saving-cleanup.yaml", import.meta.url).pathname);

/** Arrange the earlier cleanup and fire stages so the driver reaches its confirmation query. */
function cleanupRun(t: TestContext, stopped: boolean, ticksPerSecond: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const world = createFakeBot({ clock, server: { ticksPerSecond }, cells: { "7,-60,0": "cobblestone" }, position: new Vec3(0.5, -60, 0.5) });
  const { bot, server } = world;
  setProtectedRegionsProvider(bot, () => [{ regionId: 1, dimension: "overworld", owner: "Builder", label: "test",
    min: { x: 7, y: -60, z: 0 }, max: { x: 7, y: -60, z: 0 } }]);
  const status = createViewStatusAction(bot, temporaryBotData({ botId: "CleanupTest", closeAfter: t }), () => ({ owner: "idle", activeAction: null }));
  let views = 0;
  let queryAge = 0;
  let navigated = false;
  let calls = 0;
  // Arrange the driver's command answers; the fake has no command interpreter.
  bot.chat = (command) => {
    if (command.startsWith("/setblock")) world.world.setCell(bot.entity.position.floored(), "fire");
    if (command.startsWith("/execute")) {
      queryAge = bot.time.age;
      if (stopped) server.stop();
      else clock.after(100, () => bot.emit("messagestr", "cleanup-server-air", "chat", {} as never));
    }
  };
  const context = scenarioTestContext({ bot, scenario, call: async (action) => {
    calls += 1;
    if (action === "view_status") {
      views += 1;
      if (views === 1) bot.entity.position.x += 1;
      if (views === 3) {
        world.world.setCell(new Vec3(7, -60, 0), "air");
        await removeLifeSavingPlacements(bot, new AbortController().signal);
      }
      const result = await status.execute({}, {});
      return { action, durationMs: 0, summary: "status", result,
        survival: { owner: { current: views === 1 ? "remove_life_saving_placements" : views === 2 ? "fire_reflex" : null } } } as unknown as ScenarioCall;
    }
    if (action === "navigate") navigated = true;
    return { action, durationMs: 0, summary: "done", result: { status: "succeeded" } };
  } });
  return { clock, bot, server, status, pending: () => run(context, clock.sleep), queryAge: () => queryAge, navigated: () => navigated, calls: () => calls };
}

for (const ticksPerSecond of [20, 10]) test(`the cleanup server answer ends the wait early at ${ticksPerSecond} tps`, async (t) => {
  const fixture = cleanupRun(t, false, ticksPerSecond);
  using _timers = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  let settlements = 0;
  const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 500);
  assert.equal(result.status, "succeeded", result.detail ?? "no detail");
  assert.equal(fixture.bot.time.age, fixture.queryAge());
  assert.equal(fixture.navigated(), true);
  const calls = fixture.calls();
  await fixture.clock.advance(31_000);
  assert.equal(settlements, 1);
  assert.equal(fixture.calls(), calls);
  assert.equal(added("messagestr"), 0);
});

test("a stopped clock during the cleanup server answer is named and does not navigate", async (t) => {
  const fixture = cleanupRun(t, true, 20);
  using _timers = fixture.clock.install();
  const added = listenersAddedSince(fixture.bot);
  let settlements = 0;
  const result = await fixture.clock.settle(fixture.pending().then((answer) => { settlements += 1; return answer; }), 31_000);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /clock stood still/);
  assert.equal(fixture.navigated(), false);
  fixture.server.resume();
  const next = await fixture.clock.settle(fixture.status.execute({}, {}), 500);
  assert.equal(next.status, "succeeded");
  const calls = fixture.calls();
  await fixture.clock.advance(31_000);
  assert.equal(settlements, 1);
  assert.equal(fixture.calls(), calls);
  assert.equal(added("messagestr"), 0);
});
