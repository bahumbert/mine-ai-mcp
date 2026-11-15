import test from "node:test";
import assert from "node:assert/strict";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { lanePlacement, SchedulerRig } from "./scheduler-rig.ts";
import { Scheduler, type SchedulerDeps, type SubmissionEvent } from "./scheduler.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

function customRun(rig: SchedulerRig, overrides: Partial<SchedulerDeps> = {}, timeout = 60) {
  const events: SubmissionEvent[] = [];
  const scenario = fixtureScenario(timeout, "a");
  const placement = lanePlacement("k");
  if (placement.kind !== "lane") throw new Error("expected lane placement");
  const scheduler = new Scheduler({ pool: rig.pool, config: rig.config, now: () => rig.clock, log: () => {},
    runTrial: async input => { await input.onArranged(); throw new Error("runner broke"); },
    runIo: { open: async () => ({ log: () => {}, close: async () => {} }), writeResult: async () => {} }, ...overrides });
  const handle = scheduler.submit({ entries: [{ name: "a", scenario, placement: { ...placement, scenario } }], repeat: 1,
    maxLanes: null, lock: false, hold: false, outDir: "/tmp/out", emit: event => events.push(event) });
  scheduler.onSample({ cpuBusy: 0.2, memAvailableMb: 28_000, threads: 24 }, rig.clock);
  return { handle, events };
}

for (const [name, overrides] of [
  ["a thrown runner", {}],
  ["run-directory rejection without a reason", { runIo: { open: async () => { throw undefined; }, writeResult: async () => {} } }],
] satisfies [string, Partial<SchedulerDeps>][]) {
  test(`${name} is infrastructure`, async () => {
    const { handle, events } = customRun(new SchedulerRig(), overrides);
    const summary = await handle.finished;
    const event = events.find(event => event.type === "result");
    assert.equal(event?.type === "result" && event.class, "infra");
    assert.equal(summary.infra, 1);
  });
}

test("a refused lane shift is product", async () => {
  const { handle, events } = customRun(new SchedulerRig(), { shift: () => ({ ok: false, reason: "refused" }) });
  const summary = await handle.finished;
  const event = events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "product");
  assert.equal(summary.failed, 1);
});

test("a wall bound without a bench event is product, not cancelled", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const rig = new SchedulerRig({ MINE_AI_SCENARIO_TRIAL_SLACK_MS: "1", MINE_AI_SCENARIO_RESTORE_BOUND_MS: "100" });
  const { handle, events } = customRun(rig, { runTrial: async input => { await input.onArranged(); return await new Promise(resolve => {
    input.signal.addEventListener("abort", () => resolve({ scenario: "a", outcome: "cancelled", elapsedMs: 1,
      goal: { state: "pending", detail: "aborted" }, goalText: "" }), { once: true });
  }); } }, 0.001);
  const summary = await clock.settle(handle.finished, 100, 1);
  const event = events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "product");
  assert.deepEqual([summary.failed, summary.infra ?? 0, summary.cancelled], [1, 0, 0]);
});

test("a death during restore keeps the runner's product class", async () => {
  const rig = new SchedulerRig();
  const restoring = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const { handle, events } = customRun(rig, { runTrial: async input => {
    await input.onArranged();
    input.deferReset(async () => { restoring.resolve(); await release.promise; });
    return { scenario: "a", outcome: "fail", elapsedMs: 1, goal: { state: "failed", detail: "goal failed" }, goalText: "" };
  } });
  await restoring.promise;
  await rig.killJavaOf(0);
  release.resolve();
  const summary = await handle.finished;
  const event = events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "product");
  assert.equal(summary.infra ?? 0, 0);
});

for (const outcome of ["pass", "fail"] as const) {
  test(`a runner ${outcome} is classified`, async () => {
    const rig = new SchedulerRig();
    const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
    rig.sample();
    await rig.settle();
    rig.finishNamed("a", outcome);
    const summary = await handle.finished;
    const event = rig.events.find(event => event.type === "result");
    assert.equal(event?.type === "result" && event.class, outcome === "pass" ? "pass" : "product");
    assert.equal(summary.failed, outcome === "pass" ? 0 : 1);
  });
}

test("death before the runner settles is infrastructure", async () => {
  const rig = new SchedulerRig();
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  await rig.killJavaOf(0);
  rig.finishNamed("a", "fail");
  const summary = await handle.finished;
  const event = rig.events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "infra");
  assert.match(event?.type === "result" ? event.cause ?? "" : "", /^server died:/u);
  assert.equal(summary.infra, 1);
});

test("two lane server start failures count as infrastructure", async () => {
  const rig = new SchedulerRig();
  rig.factory.failNextStart = true;
  const handle = rig.submit([{ name: "a", placement: lanePlacement("k") }]);
  rig.sample();
  await rig.settle();
  rig.factory.failNextStart = true;
  rig.clock += 5_000;
  rig.sample();
  const summary = await handle.finished;
  const event = rig.events.find(event => event.type === "result");
  assert.equal(event?.type === "result" && event.class, "infra");
  assert.deepEqual([summary.failed, summary.infra], [1, 1]);
});
