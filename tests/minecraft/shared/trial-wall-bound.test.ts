// The trial's outer abort follows its carried tick rate, including a lane whose setup rate was lifted away.
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { placeScenario } from "./placement.ts";
import { fixtureScenario } from "./scenario-fixture.ts";
import { SchedulerRig } from "./scheduler-rig.ts";
import * as trialBounds from "./trial.ts";

test("the wall bound scales game seconds by the rate and tick slack factor before adding wall slack", () => {
  assert.equal(trialBounds.TRIAL_TICK_SLACK_FACTOR, 2);
  for (const [rate, expected] of [[null, 360_000], [5, 1_080_000], [20, 360_000]] as const) {
    assert.equal(trialBounds.trialWallBoundMs(120, rate, 120_000, 2), expected, `rate ${rate}`);
  }
});

test("lane and own-server trials abort at the bound of their carried rate", async () => {
  for (const { rate, own, bound } of [
    { rate: 5, own: false, bound: 8_020 },
    { rate: 4, own: true, bound: 10_020 },
    { rate: null, own: false, bound: 2_020 },
  ]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const rig = new SchedulerRig({ MINE_AI_SCENARIO_TRIAL_SLACK_MS: "20" });
    const base = fixtureScenario(1);
    const scenario = { ...base, setup: [...base.setup, ...(rate === null ? [] : [`tick rate ${rate}`])], tags: own ? [...base.tags, "exclusive"] : base.tags };
    const placement = placeScenario(scenario, {});
    assert.equal(placement.kind, own ? "own" : "lane");
    const submission = rig.scheduler.submit({
      entries: [{ name: "rate-bound", scenario, placement }], repeat: 1, maxLanes: null, lock: false, hold: false,
      outDir: "/tmp/rate-bound", emit: event => rig.events.push(event),
    });
    try {
      rig.sample();
      await rig.settle();
      assert.equal(rig.running.length, 1);
      const input = rig.running[0]!.input;
      if (!own) assert.equal(input.scenario.setup.some(command => command.startsWith("tick rate ")), false, "the lane scenario no longer carries the rate command");
      else assert.ok(input.scenario.setup.includes(`tick rate ${rate}`));
      await clock.advance(bound - 1, bound - 1);
      assert.equal(input.signal.aborted, false, `rate ${rate}: pending before its wall bound`);
      await clock.advance(1);
      assert.equal(input.signal.aborted, true, `rate ${rate}: aborted at its wall bound`);
      assert.equal(input.signal.reason, "wall-clock bound");
    } finally {
      await rig.drain();
      await submission.finished;
      await rig.pool.stopAll();
    }
  }
});
