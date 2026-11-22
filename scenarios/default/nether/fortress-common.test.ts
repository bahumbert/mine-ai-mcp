// The fortress drivers' hand-back: wait for an idle runner, then navigate with at most one typed return (plan 2026-11-18-scenario-reds-part3-a2 T18a).
/// <reference types="bun" />
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { COVER_REFUSED_CODE } from "../../../src/survival/state/cover-obligation.ts";
import { STALLED_CODE } from "../../../src/survival/state/request-stall.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { Runtime } from "../../src/runtime.ts";
import { navigateWithOneReturn, waitForIdleRunner } from "./fortress-common.ts";

const input = { x: 4, y: 64, z: 7, range: 1 };
const PACKET_TICKS = 20;
/** The hand-back's own ceiling for a test: far past any scripted wait, so a hang shows as a settle error. */
const SETTLE_MS = 5 * DRIVER_CLOCK_STOPPED_MS;

type Output = Awaited<ReturnType<Runtime["run"]>>;
const output = (result: { status: string; error?: string }, durationMs = 400) =>
  ({ action: "navigate", durationMs, result }) as unknown as Output;
const arrived = output({ status: "succeeded" });
const coverRefused = output({ status: "failed", error: `${COVER_REFUSED_CODE} route refused` });
const hostileStalled = output({ status: "cancelled", error: `${STALLED_CODE} 2 evades without progress` });
const cancelledPlain = output({ status: "cancelled", error: "[CANCELLED] stopped" });
const actionBusy = output({ status: "failed", error: "[ACTION_BUSY] hostile_reflex has been running; no new action started." }, 0);

interface Rig {
  readonly runtime: Pick<Runtime, "run" | "status" | "actions">;
  /** The world age of each navigate the runtime received, and whether the runner was busy when it came. */
  readonly navigates: { readonly age: number; readonly busy: boolean }[];
  /** The runner is busy while the world age is under this value; a reply hook may raise it. */
  busyUntilAge: number;
  owner: string | null;
}

/** A runtime double with the runner's status shape and one scripted navigate reply per call; `afterReply(n)` runs when reply n is returned. */
function rig(f: ReturnType<typeof createFakeBot>, replies: readonly Output[], afterReply: (call: number, rig: Rig) => void = () => {}): Rig {
  const navigates: Rig["navigates"] = [];
  const state: Rig = {
    navigates, busyUntilAge: 0, owner: null,
    runtime: {
      actions: [{ name: "navigate" }],
      status: () => {
        const busy = f.bot.time.age < state.busyUntilAge;
        return { busy, activeAction: busy && state.owner ? { action: state.owner, startedAt: "" } : null, owner: busy ? "foreground" : "idle" };
      },
      async run() {
        navigates.push({ age: f.bot.time.age, busy: state.runtime.status().busy });
        const reply = replies[navigates.length - 1];
        assert.ok(reply, "an unplanned navigate was started");
        afterReply(navigates.length, state);
        return reply;
      },
    } as unknown as Rig["runtime"],
  };
  return state;
}

for (const rate of [20, 10]) {
  const packetMs = PACKET_TICKS * 1_000 / rate;
  const fresh = (options: Parameters<typeof createFakeBot>[0] = {}) => {
    const clock = createFakeClock({ mode: "mocked" });
    return { clock, f: createFakeBot({ clock, server: { ticksPerSecond: rate }, ...options }) };
  };
  test(`a reflex holding the body is waited out, then one navigate starts at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const startAge = f.bot.time.age;
    const r = rig(f, [arrived]);
    r.busyUntilAge = startAge + 3 * PACKET_TICKS;
    r.owner = "hostile_reflex";
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "completed");
    assert.deepEqual(r.navigates.map(({ busy }) => busy), [false], "the navigate came while the runner was still busy");
    assert.ok(r.navigates[0]!.age - startAge >= 3 * PACKET_TICKS, "the navigate came before the reflex's three packets");
    assert.equal(run.kind === "completed" ? run.returns : null, 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });

  test(`waitForIdleRunner names the owners it saw and ends idle at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const startAge = f.bot.time.age;
    const r = rig(f, []);
    r.busyUntilAge = startAge + 3 * PACKET_TICKS;
    r.owner = "hostile_reflex";
    const died = new AbortController();
    const signal = new AbortController();
    const wait = await clock.settle(waitForIdleRunner(r.runtime, f.bot, died.signal, signal.signal), SETTLE_MS);
    assert.deepEqual(wait, { kind: "idle", owners: ["hostile_reflex"] });
    assert.ok(f.bot.time.age - startAge >= 3 * PACKET_TICKS);
    assert.equal(getEventListeners(signal.signal, "abort").length, 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });

  test(`a busy runner with no active action (a request settling) is waited out at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, []);
    r.busyUntilAge = f.bot.time.age + 2 * PACKET_TICKS;
    const wait = await clock.settle(waitForIdleRunner(r.runtime, f.bot, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.deepEqual(wait, { kind: "idle", owners: [] });
    assert.ok(f.bot.time.age >= r.busyUntilAge);
  });

  test(`a world age that stands still ends the wait stalled, with no navigate, at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [arrived]);
    r.busyUntilAge = Infinity;
    r.owner = "hostile_reflex";
    f.server.stop();
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "not_admitted");
    assert.deepEqual(run.kind === "not_admitted" ? run.wait : null, { kind: "stalled", owners: ["hostile_reflex"] });
    assert.deepEqual(r.navigates, []);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });

  test(`a moving world age is no stall however long the runner stays busy at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const startAge = f.bot.time.age;
    const r = rig(f, []);
    // Longer than the stall bound in wall time at this rate: only a still world age may end the wait.
    const busyTicks = Math.ceil((2 * DRIVER_CLOCK_STOPPED_MS / 1_000) * rate);
    r.busyUntilAge = startAge + busyTicks;
    const wait = await clock.settle(waitForIdleRunner(r.runtime, f.bot, new AbortController().signal, new AbortController().signal), 4 * DRIVER_CLOCK_STOPPED_MS);
    assert.equal(wait.kind, "idle");
  });

  test(`a bot with no world age and a silent server ends stalled on the wall backstop at ${rate} tps`, async () => {
    const { clock, f } = fresh({ server: { ticksPerSecond: rate, timePacketYet: false } });
    using _timers = clock.install();
    f.server.stop();
    const r = rig(f, []);
    r.busyUntilAge = Infinity;
    const wait = await clock.settle(waitForIdleRunner(r.runtime, f.bot, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(wait.kind, "stalled");
  });

  test(`a death during the first wait ends it dead and sends no navigate at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [arrived]);
    r.busyUntilAge = Infinity;
    const died = new AbortController();
    const pending = navigateWithOneReturn(r.runtime, f.bot, input, died.signal, new AbortController().signal);
    await clock.advance(2 * packetMs);
    died.abort(new Error("bot died"));
    const run = await clock.settle(pending, SETTLE_MS);
    assert.equal(run.kind, "not_admitted");
    assert.equal(run.kind === "not_admitted" ? run.wait.kind : null, "dead");
    assert.deepEqual(r.navigates, []);
  });

  test(`an abort during the wait throws and sends no navigate at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [arrived]);
    r.busyUntilAge = Infinity;
    const trial = new AbortController();
    const rejection = assert.rejects(
      navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, trial.signal), /trial aborted/);
    await clock.advance(2 * packetMs);
    trial.abort(new Error("trial aborted"));
    await clock.settle(rejection, SETTLE_MS);
    assert.deepEqual(r.navigates, []);
    assert.equal(getEventListeners(trial.signal, "abort").length, 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });

  for (const { name, replies, navigatesWanted, returns, last } of [
    { name: "a refused cover route then arrival: two navigates, one return", replies: [coverRefused, arrived], navigatesWanted: 2, returns: 1, last: "succeeded" },
    { name: "a hostile stall then arrival: two navigates, one return", replies: [hostileStalled, arrived], navigatesWanted: 2, returns: 1, last: "succeeded" },
    { name: "two returns: two navigates, never a third", replies: [hostileStalled, coverRefused, arrived], navigatesWanted: 2, returns: 2, last: "failed" },
    { name: "a cancel without a code is no return: one navigate", replies: [cancelledPlain, arrived], navigatesWanted: 1, returns: 0, last: "cancelled" },
    { name: "an arrival needs no second navigate", replies: [arrived, arrived], navigatesWanted: 1, returns: 0, last: "succeeded" },
  ] as const) {
    test(`${name} at ${rate} tps`, async () => {
      const { clock, f } = fresh();
      using _timers = clock.install();
      const r = rig(f, replies);
      const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
      assert.equal(run.kind, "completed");
      if (run.kind !== "completed") return;
      assert.equal(r.navigates.length, navigatesWanted);
      assert.equal(run.returns, returns);
      assert.equal(run.last.result.status, last);
      assert.equal(run.requests.length, navigatesWanted);
      assert.equal(run.outputs.length, navigatesWanted);
      assert.ok(r.navigates.every(({ busy }) => !busy));
    });
  }

  test(`the second navigate waits for the reflex that took the body after the first return at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [hostileStalled, arrived], (call, state) => {
      if (call === 1) { state.busyUntilAge = f.bot.time.age + 2 * PACKET_TICKS; state.owner = "hostile_reflex"; }
    });
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "completed");
    assert.deepEqual(r.navigates.map(({ busy }) => busy), [false, false]);
    assert.ok(r.navigates[1]!.age - r.navigates[0]!.age >= 2 * PACKET_TICKS, "the second navigate did not wait for the reflex");
  });

  test(`an unadmitted ACTION_BUSY (0 ms) waits again, then one admitted navigate follows at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    // The first call finds the runner idle on status but a request settling takes the body before the run is admitted.
    const r = rig(f, [actionBusy, arrived], (call, state) => {
      if (call === 1) state.busyUntilAge = f.bot.time.age + 2 * PACKET_TICKS;
    });
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "completed");
    if (run.kind !== "completed") return;
    assert.equal(r.navigates.length, 2);
    assert.equal(run.outputs.length, 2);
    assert.equal(run.requests.length, 1, "the unadmitted call is no request");
    assert.equal(run.returns, 0);
    assert.equal(run.last.result.status, "succeeded");
  });

  test(`an unadmitted ACTION_BUSY against a world age that stands still ends not admitted at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [actionBusy, arrived], (call, state) => {
      if (call === 1) { state.busyUntilAge = Infinity; f.server.stop(); }
    });
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "not_admitted");
    assert.equal(run.kind === "not_admitted" ? run.outputs.length : null, 1);
    assert.equal(r.navigates.length, 1);
  });

  test(`a death between the two navigates sends no second one at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const died = new AbortController();
    const r = rig(f, [coverRefused, arrived], (call) => { if (call === 1) died.abort(new Error("bot died")); });
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, died.signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "completed");
    if (run.kind !== "completed") return;
    assert.equal(r.navigates.length, 1);
    assert.equal(run.returns, 1);
    assert.equal(run.last.result.status, "failed");
  });

  // The first navigate returns and a reflex takes the body for good: the second wait ends by death, by a still world age, or by abort.
  for (const ending of ["death", "stall", "abort"] as const) {
    test(`${ending} during the wait for the second navigate sends none and reports how the wait ended at ${rate} tps`, async () => {
      const { clock, f } = fresh();
      using _timers = clock.install();
      const died = new AbortController();
      const trial = new AbortController();
      const r = rig(f, [hostileStalled, arrived], (call, state) => {
        if (call === 1) { state.busyUntilAge = Infinity; state.owner = "hostile_reflex"; if (ending === "stall") f.server.stop(); }
      });
      const pending = navigateWithOneReturn(r.runtime, f.bot, input, died.signal, trial.signal);
      const rejection = ending === "abort" ? assert.rejects(pending, /trial aborted/) : null;
      if (ending !== "stall") {
        await clock.advance(3 * packetMs);
        if (ending === "death") died.abort(new Error("bot died")); else trial.abort(new Error("trial aborted"));
      }
      if (rejection) await clock.settle(rejection, SETTLE_MS);
      else {
        const run = await clock.settle(pending, SETTLE_MS);
        assert.equal(run.kind, "completed");
        if (run.kind !== "completed") return;
        assert.equal(run.wait.kind, ending === "death" ? "dead" : "stalled");
        assert.equal(run.returns, 1);
        assert.deepEqual(run.owners, ["hostile_reflex"]);
        assert.equal(run.last.result.status, "cancelled");
      }
      assert.equal(r.navigates.length, 1, "a second navigate was sent into a body the reflex held");
      assert.equal(getEventListeners(trial.signal, "abort").length, 0);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }

  test(`a bot at no health between the two navigates sends no second one at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, [hostileStalled, arrived], (call) => { if (call === 1) f.combat.setHealth(0); });
    const run = await clock.settle(navigateWithOneReturn(r.runtime, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS);
    assert.equal(run.kind, "completed");
    assert.equal(r.navigates.length, 1);
  });

  test(`the navigate action is found by name, never assumed at ${rate} tps`, async () => {
    const { clock, f } = fresh();
    using _timers = clock.install();
    const r = rig(f, []);
    const noNavigate = { ...r.runtime, actions: [] } as unknown as Rig["runtime"];
    await assert.rejects(
      clock.settle(navigateWithOneReturn(noNavigate, f.bot, input, new AbortController().signal, new AbortController().signal), SETTLE_MS),
      /navigate/);
  });
}
