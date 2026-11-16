// The claim watch: a reflex that holds the body is held to the physics-stall limit, a ceiling and a no-progress limit
// (SRV-01, SEC-09), on the runner's own clock.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { actionResultSchema, defineAction, type Action } from "../actions/index.js";
import { createNavigateAction } from "../actions/navigate/navigate.js";
import { createMovements, type NavigationRuntime } from "../navigation/index.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { flush, handClock } from "../test-support/hand-clock.js";
import { serverPacedWallMs } from "../world/world-age.js";
import { BodyAbort, type ReflexLimitKind } from "./abort.js";
import { ActionRunner, type ClaimSettlement, type ClaimLimits } from "./action-runner.js";

const inputSchema = z.object({ block_name: z.string() });
const resultSchema = actionResultSchema({});
type StubResult = z.output<typeof resultSchema>;
type StubAction = Action<"stub", { block_name: string }, StubResult>;

/** A resumable action: `execute` is one attempt, the runner starts another when the reflex says resume. */
function resumableAction(execute: NonNullable<StubAction["execute"]>): StubAction {
  return defineAction({
    name: "stub",
    description: "stub",
    inputSchema,
    resultSchema,
    formatResult: (result) => result.status,
    parse: (input: unknown) => inputSchema.parse(input),
    execution: { kind: "resumable_task" },
    begin: (request: { block_name: string }) => (context: Parameters<typeof execute>[1]) => execute(request, context),
  });
}

/** An action that is stopped by its abort signal, as every real action is. */
const hangingUntilAborted = (): NonNullable<StubAction["execute"]> => async (_request, context) => {
  await new Promise<void>((_resolve, reject) => {
    context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
  });
  return { status: "succeeded" };
};

// Limits in world ticks; with no world age (`worldAge` null) a tick is 50 ms of the clock, so these keep the old ms / 50.
const noProgress = (ticks: number, marks: () => number = () => 0, worldAge: () => number | null = () => null): ClaimLimits =>
  ({ ceilingTicks: 12_000, noProgressTicks: ticks, progressMarks: marks, worldAge });
const ceiling = (ticks: number): ClaimLimits => ({ ceilingTicks: ticks, noProgressTicks: 12_000, progressMarks: () => 0, worldAge: () => null });

/** A runner on a hand clock; `pass` moves time with a physics tick at every step, as a healthy server would. */
function fixture(options: { physicsStallMs?: number } = {}) {
  const time = handClock();
  const limits: Array<readonly [string, ReflexLimitKind]> = [];
  const runner = new ActionRunner({
    clock: time.clock,
    cancelGraceMs: 500,
    onBodyLimit: (owner, limit) => limits.push([owner, limit]),
    ...options,
  });
  const pass = async (ms: number, ticking = true) => {
    for (let passed = 0; passed < ms; passed += 50) {
      if (ticking) runner.observePhysicsTick();
      await time.advance(50);
    }
  };
  return { runner, time, limits, pass };
}

/** The claim's outcome as a value, so a rejection is never unhandled while the test steps time. */
function watching<Value>(claim: ReturnType<ActionRunner["claim"]> & { kind: "claimed" }) {
  let end: { readonly ok: Value } | { readonly failed: unknown } | null = null;
  void (claim.outcome as Promise<Value>).then((ok) => (end = { ok }), (failed: unknown) => (end = { failed }));
  return () => end;
}

function claimed<Value>(claim: ReturnType<ActionRunner["claim"]>) {
  assert.equal(claim.kind, "claimed");
  return claim as ReturnType<ActionRunner["claim"]> & { kind: "claimed" } & { outcome: Promise<Value> };
}

/** A reflex whose work never settles and never looks at its signal: what SEC-09 describes. */
const deaf = (seen?: { signal?: AbortSignal }) => (signal: AbortSignal): Promise<ClaimSettlement<string>> => {
  if (seen) seen.signal = signal;
  return new Promise<never>(() => {});
};

function limitOf(failed: unknown) {
  assert.ok(failed instanceof BodyAbort && failed.detail.kind === "reflex_limit", `a reflex_limit abort, got ${String(failed)}`);
  return failed.detail;
}

test("a claim with no physics tick is aborted after the stall limit and released after the grace", async () => {
  const { runner, limits, pass } = fixture({ physicsStallMs: 1_000 });
  const seen: { signal?: AbortSignal } = {};
  const end = watching(claimed(runner.claim("hostile_reflex", "contact", deaf(seen))));
  await pass(950, false);
  assert.equal(seen.signal?.aborted, false);
  await pass(100, false);
  assert.equal(seen.signal?.aborted, true, "the work is told to stop");
  assert.deepEqual(limits, [["hostile_reflex", "physics_stalled"]]);
  assert.equal(end(), null, "the work has the grace to stop");
  assert.equal(runner.status().owner, "takeover");
  await pass(500, false);
  const done = end();
  assert.ok(done && "failed" in done);
  assert.equal(limitOf(done.failed).limit, "physics_stalled");
  assert.match((done.failed as Error).message, /RUNTIME_PHYSICS_STALLED/);
  assert.equal(runner.status().owner, "idle");
});

test("a stalled claim without onBodyLimit still calls onPhysicsStall, as an action does", async () => {
  const time = handClock();
  const stalls: string[] = [];
  const runner = new ActionRunner({ clock: time.clock, physicsStallMs: 1_000, cancelGraceMs: 500, onPhysicsStall: (owner) => stalls.push(owner) });
  watching(claimed(runner.claim("fire_reflex", "burning", deaf())));
  await time.advance(1_100);
  assert.deepEqual(stalls, ["fire_reflex"]);
});

test("a claim past its ceiling is aborted with reflex_limit ceiling and onBodyLimit is called once", async () => {
  const { runner, limits, pass } = fixture({ physicsStallMs: 30_000 });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(200))));
  await pass(9_900);
  assert.deepEqual(limits, []);
  await pass(10_000);
  assert.deepEqual(limits, [["hostile_reflex", "ceiling"]]);
  const done = end();
  assert.ok(done && "failed" in done);
  const detail = limitOf(done.failed);
  assert.equal(detail.limit, "ceiling");
  assert.equal(detail.reflex, "hostile_reflex");
  assert.equal(detail.elapsedMs, 10_000);
  assert.match((done.failed as Error).message, /\[REFLEX_LIMIT\] hostile_reflex .*10 s/);
});

test("a claim whose marks do not change for noProgressMs is aborted with no_progress; a mark resets the clock", async () => {
  const { runner, limits, pass } = fixture();
  let marks = 0;
  const end = watching(claimed(runner.claim("fire_reflex", "burning", deaf(), undefined, noProgress(120, () => marks))));
  await pass(4_000);
  marks += 1;
  await pass(5_900);
  assert.deepEqual(limits, [], "5.9 s since the mark");
  await pass(6_000);
  assert.deepEqual(limits, [["fire_reflex", "no_progress"]]);
  const done = end();
  assert.ok(done && "failed" in done);
  assert.equal(limitOf(done.failed).limit, "no_progress");
  assert.match((done.failed as Error).message, /\[REFLEX_LIMIT\] fire_reflex .*without progress/);
});

test("in a vehicle (physicsExpected false) no stall is called, the ceiling still ends the claim", async () => {
  const time = handClock();
  const limits: ReflexLimitKind[] = [];
  const runner = new ActionRunner({ clock: time.clock, physicsStallMs: 1_000, physicsExpected: () => false, cancelGraceMs: 500, onBodyLimit: (_owner, limit) => limits.push(limit) });
  watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(100))));
  await time.advance(4_900);
  assert.deepEqual(limits, []);
  await time.advance(200);
  assert.deepEqual(limits, ["ceiling"]);
});

test("a claim on a server that ticks every 150 ms is limited by wall time only", async () => {
  const { runner, time, limits } = fixture({ physicsStallMs: 1_000 });
  watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(400))));
  for (let at = 0; at < 19_000; at += 150) {
    runner.observePhysicsTick();
    await time.advance(150, 50);
  }
  assert.deepEqual(limits, []);
});

test("a claim whose work ignores the abort is released after the grace, and its late settle changes no state", async () => {
  const { runner, time, pass } = fixture();
  let finishLate!: (settlement: ClaimSettlement<string>) => void;
  const late = new Promise<ClaimSettlement<string>>((resolve) => { finishLate = resolve; });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", () => late, undefined, ceiling(40))));
  await pass(2_000);
  assert.equal(end(), null);
  await pass(500);
  assert.equal(runner.status().owner, "idle", "the body is released");
  // A new action owns the body alone: the late reflex work settling now must not release or steal it.
  let finishNext!: () => void;
  const next = resumableAction(() => new Promise((resolve) => { finishNext = () => resolve({ status: "succeeded" }); }));
  const running = runner.run(next, { block_name: "stone" });
  await flush();
  const before = runner.ownership();
  assert.equal(before.current, "stub");
  finishLate({ value: "late", continuation: { kind: "resume" } });
  await flush();
  assert.deepEqual(runner.ownership(), before);
  assert.equal(runner.status().owner, "foreground");
  finishNext();
  assert.equal((await running).result.status, "succeeded");
  assert.equal(time.timers(), 0);
});

test("a claim that settles inside the grace keeps its value and continuation", async () => {
  const { runner, pass } = fixture();
  const attempts = { count: 0 };
  const action = resumableAction(async (request, context) => {
    attempts.count += 1;
    return attempts.count === 1 ? hangingUntilAborted()(request, context) : { status: "succeeded" };
  });
  const running = runner.run(action, { block_name: "stone" });
  await flush();
  const work = (signal: AbortSignal) => new Promise<ClaimSettlement<string>>((resolve) => {
    signal.addEventListener("abort", () => resolve({ value: "stopped in time", continuation: { kind: "return", reason: "[HOSTILE] kept its own reason" } }), { once: true });
  });
  const end = watching<string>(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(40))));
  await pass(2_100);
  assert.deepEqual(end(), { ok: "stopped in time" });
  const output = await running;
  assert.deepEqual(output.interruptions, ["[HOSTILE] kept its own reason"]);
  assert.equal(attempts.count, 1, "not resumed: the reflex said return");
});

test("the interrupted request returns with the [REFLEX_LIMIT] reason", async () => {
  const { runner, pass } = fixture();
  const action = resumableAction(hangingUntilAborted());
  const running = runner.run(action, { block_name: "stone" });
  await flush();
  watching(claimed(runner.claim("hostile_reflex", "[HOSTILE] contact", deaf(), undefined, ceiling(60))));
  await pass(3_600);
  const output = await running;
  assert.equal(output.interruptions?.length, 1);
  assert.match(output.interruptions![0]!, /^\[REFLEX_LIMIT\] hostile_reflex held the body/);
  assert.match(output.interruptions![0]!, /(start|try|choose|run)/i, "names a next step");
  assert.equal(runner.status().busy, false);
});

test("a claim made on the physicsTick after a resume preempts the resumed action: one owner at a time", async () => {
  const runner = new ActionRunner();
  const order: string[] = [];
  const attempts = { count: 0 };
  const action = resumableAction(async (request, context) => {
    attempts.count += 1;
    order.push(`attempt ${attempts.count} starts`);
    if (attempts.count === 1) await hangingUntilAborted()(request, context).catch(() => {});
    else await hangingUntilAborted()(request, context).catch(() => order.push("attempt 2 stopped"));
    return { status: "succeeded" };
  });
  const running = runner.run(action, { block_name: "stone" });
  await flush();
  runner.claim("hunger_reflex", "[HUNGER]", async () => ({ value: "ate", continuation: { kind: "resume" as const } }));
  // The next physicsTick is a macrotask: the resume has been entered by then.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts.count, 2);
  assert.equal(runner.status().owner, "foreground");
  const second = runner.claim("hunger_reflex", "[HUNGER] again", async () => {
    order.push("second claim works");
    return { value: "ate", continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(second.kind, "claimed");
  assert.equal(second.kind === "claimed" && second.interrupted?.action, "stub");
  await (second as { outcome: Promise<string> }).outcome;
  await running;
  assert.deepEqual(order, ["attempt 1 starts", "attempt 2 starts", "attempt 2 stopped", "second claim works"]);
  assert.equal(runner.status().busy, false);
});

test("a disconnect mid-claim settles as before and leaves no timer", async () => {
  const { runner, time, pass } = fixture({ physicsStallMs: 30_000 });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, { ceilingTicks: 1_200, noProgressTicks: 600, progressMarks: () => 0, worldAge: () => null })));
  await pass(1_000);
  assert.equal(time.timers() > 0, true);
  runner.disconnect("socket closed");
  await flush();
  const done = end();
  assert.ok(done && "failed" in done);
  assert.match((done.failed as Error).message, /MINECRAFT_DISCONNECTED/);
  assert.equal(time.timers(), 0);
});

for (const [label, cause] of [
  ["a model cancel", { kind: "cancelled", by: "model" }],
  ["a death", { kind: "death" }],
] as const) {
  test(`${label} mid-claim that the work honours ends it with no limit incident, even long past the ceiling`, async () => {
    const { runner, time, limits, pass } = fixture();
    const work = (signal: AbortSignal) => new Promise<ClaimSettlement<string>>((resolve) => {
      signal.addEventListener("abort", () => resolve({ value: "stopped", continuation: { kind: "return", reason: null } }), { once: true });
    });
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(100))));
    await pass(1_000);
    runner.cancelActive("stop", cause);
    await flush();
    assert.deepEqual(end(), { ok: "stopped" });
    await pass(10_000);
    assert.deepEqual(limits, []);
    assert.equal(time.timers(), 0);
  });
}

test("two claims in a row each get their own watch, and no timer is left between or after them", async () => {
  const { runner, time, limits, pass } = fixture();
  for (const round of [1, 2]) {
    let finish!: () => void;
    const work = () => new Promise<ClaimSettlement<string>>((resolve) => {
      finish = () => resolve({ value: `round ${round}`, continuation: { kind: "return", reason: null } });
    });
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(100))));
    await pass(1_000);
    assert.equal(time.timers() > 0, true);
    finish();
    await flush();
    assert.deepEqual(end(), { ok: `round ${round}` });
    assert.equal(time.timers(), 0);
  }
  assert.deepEqual(limits, []);
});

test("twenty bots' claims share one clock: every timer is gone when they all settle", async () => {
  const time = handClock();
  const finishers: Array<() => void> = [];
  const ends = Array.from({ length: 20 }, () => {
    const runner = new ActionRunner({ clock: time.clock, physicsStallMs: 30_000 });
    const work = () => new Promise<ClaimSettlement<string>>((resolve) => {
      finishers.push(() => resolve({ value: "ok", continuation: { kind: "return", reason: null } }));
    });
    return watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(1_200))));
  });
  await time.advance(500);
  for (const finish of finishers) finish();
  await flush();
  assert.ok(ends.every((end) => end() !== null));
  assert.equal(time.timers(), 0);
});

test("a claim with no limits and no stall limit starts no timer, as before", async () => {
  const time = handClock();
  const runner = new ActionRunner({ clock: time.clock });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", async () => ({ value: "ok", continuation: { kind: "return" as const, reason: null } }))));
  assert.equal(time.timers(), 0);
  await flush();
  assert.deepEqual(end(), { ok: "ok" });
});

// The claim counts the server's world age (plan 2026-11-16-reflex-limits-ticks T2). The packet of age `A + k` falls
// `k * msPerTick` after the server starts; each claim starts 500 ms after the packet of age `A`, so its cached age is `A`.
const START_AGE = 1_000;
const CREATED_AFTER_MS = 500;
const CHECK_MS = 250;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

/**
 * A runner on the shared fake bot's clock and server, `CREATED_AFTER_MS` after the packet of age `A`, with the clock
 * installed for the test (`using` in the caller's scope: pass the clock in), a request the claim can interrupt
 * (`startRequest`: attempts counted, it waits for its abort) and a real `navigate` on the same bot as the next action.
 */
async function onServer(ticksPerSecond: number, clock: ReturnType<typeof createFakeClock>) {
  const harness = createFakeBot({ clock, server: { startAge: START_AGE, ticksPerSecond } });
  await clock.advance(CREATED_AFTER_MS);
  const limits: Array<readonly [string, ReflexLimitKind]> = [];
  const runner = new ActionRunner({ clock, cancelGraceMs: 500, onBodyLimit: (owner, limit) => limits.push([owner, limit]) });
  const added = listenersAddedSince(harness.bot);
  const worldLimits = (noProgressTicks: number, ceilingTicks = 12_000, marks: () => number = () => 0): ClaimLimits =>
    ({ ceilingTicks, noProgressTicks, progressMarks: marks, worldAge: () => harness.bot.time.age });
  const attempts = { count: 0 };
  const startRequest = () => runner.run(resumableAction(async (request, context) => {
    attempts.count += 1;
    return hangingUntilAborted()(request, context);
  }), { block_name: "stone" }, undefined, 7, "request-1");
  /** A `navigate` the same bot walks: its route answer puts her at the goal, as the navigate tests' stub does. */
  const navigateNext = () => runner.run(createNavigateAction(harness.bot, { cancel: () => undefined, onEvent: () => () => {} } as unknown as NavigationRuntime, {
    createMovements: (() => ({ name: "standard" })) as unknown as typeof createMovements,
    navigate: async () => {
      harness.bot.entity.position.set(4.5, 64, 0.5);
      return { status: "completed", elapsedMs: 1 };
    },
  }), { x: 4, y: 64, z: 0, range: 0 });
  return { ...harness, clock, runner, limits, added, worldLimits, attempts, startRequest, navigateNext };
}

/** The work of a reflex that stops on its abort, with the settlement the test gives (or the cleanup that throws). */
const stopsOnAbort = (cleanup: "settles" | "throws") => (signal: AbortSignal) => new Promise<ClaimSettlement<string>>((resolve, reject) => {
  signal.addEventListener("abort", () => {
    if (cleanup === "throws") reject(new Error("cleanup failed"));
    else resolve({ value: "stopped", continuation: { kind: "return", reason: null } });
  }, { once: true });
});

for (const { ticksPerSecond, msPerTick } of RATES) {
  test(`a claim with no progress for 100 ticks is released after the packet of age A + 120: the text, the receipt and the interrupted request name the ticks, the next navigate finishes (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { runner, limits, worldLimits, bot, startRequest, navigateNext, added, attempts } = await onServer(ticksPerSecond, clock);
    const request = startRequest();
    await flush();
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, worldLimits(100))));
    await clock.advance(100 * msPerTick + CHECK_MS - CREATED_AFTER_MS);
    assert.equal(bot.time.age, START_AGE + 100);
    assert.deepEqual(limits, [], "A + 100: the old 5 000 ms window would have ended by now at 10 tps");
    await clock.advance(20 * msPerTick + 500 + CHECK_MS); // the limit's check, then the grace
    assert.deepEqual(limits, [["hostile_reflex", "no_progress"]]);
    const done = end();
    assert.ok(done && "failed" in done, "released after the grace");
    assert.equal(limitOf(done.failed).elapsedTicks, 120);
    assert.match((done.failed as Error).message, /\[REFLEX_LIMIT\] hostile_reflex .* without progress \(120 game ticks\);/);
    const output = await clock.settle(request, 5_000);
    assert.match(output.interruptions?.[0] ?? "", /\[REFLEX_LIMIT\] hostile_reflex .* \(120 game ticks\)/, "the interrupted request returns with the limit, not resumed");
    assert.equal(attempts.count, 1);
    await clock.advance(40_000, 250);
    assert.deepEqual(limits, [["hostile_reflex", "no_progress"]], "one incident, none after the release");
    assert.equal(clock.pendingTimers(), 0);
    for (const event of ["time", "physicsTick", "entityGone", "death", "end"]) assert.equal(added(event), 0, event);
    assert.equal((await clock.settle(navigateNext(), 5_000)).result.status, "succeeded");
  });

  // T6, T13: every way out of a held claim whose window restarted at 2 s (a mark) with a request interrupted under it:
  // the claim settles once, its limits stay silent past the old wall, no timer or listener is left, the request ends as
  // that exit says (resumed or not, attempts counted), and the next `navigate` on the same bot finishes. `gate` holds a
  // claim that a request cancel must leave alone.
  const exits: ReadonlyArray<{
    readonly name: string;
    readonly work: (signal: AbortSignal, gate: Promise<void>) => Promise<ClaimSettlement<string>>;
    readonly act: (ctx: Awaited<ReturnType<typeof onServer>>, releaseGate: () => void) => void;
    /** The attempts of the request when it ends, and its status. */
    readonly attempts: number;
    readonly status: "cancelled" | "failed";
    readonly claimEnds: "settles" | "rejects";
    /** The exit is a cancel of the request only: the reflex's own signal is never aborted before the gate opens. */
    readonly reflexUntouched?: true;
  }> = [
    { name: "a request cancel during the claim", work: async (_signal, gate) => { await gate; return { value: "finished", continuation: { kind: "resume" } }; },
      act: ({ runner }, releaseGate) => { assert.equal(runner.cancelRequest("request-1", "operator stop").kind, "cancellation_requested"); releaseGate(); },
      attempts: 1, status: "cancelled", claimEnds: "settles", reflexUntouched: true },
    { name: "a model cancel of the active run", work: stopsOnAbort("settles"),
      act: ({ runner }) => void runner.cancelActive("stop", { kind: "cancelled", by: "model" }), attempts: 1, status: "cancelled", claimEnds: "settles" },
    { name: "a death", work: stopsOnAbort("settles"),
      act: ({ runner }) => void runner.cancelActive("died", { kind: "death" }), attempts: 1, status: "cancelled", claimEnds: "settles" },
    { name: "a dimension change (the request resumes in the new world, then is cancelled)", work: stopsOnAbort("settles"),
      act: ({ runner }) => runner.dimensionChanged("overworld", "the_nether"), attempts: 2, status: "cancelled", claimEnds: "settles" },
    { name: "a cleanup that throws on the cancel", work: stopsOnAbort("throws"),
      act: ({ runner }) => void runner.cancelActive("stop", { kind: "cancelled", by: "model" }), attempts: 1, status: "cancelled", claimEnds: "rejects" },
  ];
  for (const { name, work, act, attempts, status, claimEnds, reflexUntouched } of exits) {
    test(`${name}: the claim settles once, no limit after the wall, nothing left, the next navigate finishes (${ticksPerSecond} tps)`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const ctx = await onServer(ticksPerSecond, clock);
      const { runner, limits, added, worldLimits, startRequest, navigateNext } = ctx;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
      let marks = 0;
      clock.after(2_000, () => void (marks += 1)); // the window restarts from the age cached at the next check
      const request = startRequest();
      await flush();
      let reflexSignal: AbortSignal | undefined;
      const claim = claimed(runner.claim("hostile_reflex", "fight", (signal) => { reflexSignal = signal; return work(signal, gate); }, undefined, worldLimits(100, 200, () => marks)));
      const settles = { count: 0, rejected: false };
      void (claim.outcome as Promise<string>).then(() => void (settles.count += 1), () => void ((settles.count += 1), (settles.rejected = true)));
      await clock.advance(3_000);
      assert.equal(settles.count, 0, "the claim holds the body until the exit");
      act(ctx, releaseGate);
      if (name.startsWith("a dimension")) { // resumed into the new world: its second attempt is the request's to end
        await clock.advance(1_000);
        assert.equal(runner.cancelRequest("request-1", "operator stop").kind, "cancellation_requested");
      }
      if (reflexUntouched) assert.equal(reflexSignal?.aborted, false, "the request's cancel never aborts the reflex");
      const output = await clock.settle(request, 5_000);
      await clock.advance(1_000);
      assert.equal(settles.count, 1);
      assert.equal(settles.rejected, claimEnds === "rejects");
      assert.equal(output.result.status, status);
      assert.equal(ctx.attempts.count, attempts);
      await clock.advance(serverPacedWallMs(200) + 1_000, 250);
      assert.deepEqual(limits, [], "no limit incident, however far past the ceiling's wall");
      assert.equal(settles.count, 1, "settled once");
      assert.equal(clock.pendingTimers(), 0);
      for (const event of ["time", "physicsTick", "entityGone", "death", "end"]) assert.equal(added(event), 0, event);
      assert.equal((await clock.settle(navigateNext(), 5_000)).result.status, "succeeded");
    });
  }

  test(`a disconnect during the claim fails the request and settles the claim once, with no timer left (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { runner, limits, added, worldLimits, startRequest } = await onServer(ticksPerSecond, clock);
    const request = startRequest();
    await flush();
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, worldLimits(100, 200))));
    await clock.advance(3_000);
    runner.disconnect("socket closed");
    const output = await clock.settle(request, 5_000);
    assert.match(output.result.status === "failed" ? (output.result.error ?? "") : "", /MINECRAFT_DISCONNECTED/);
    const done = end();
    assert.ok(done && "failed" in done);
    await clock.advance(serverPacedWallMs(200) + 1_000, 250);
    assert.deepEqual(limits, []);
    assert.equal(clock.pendingTimers(), 0);
    for (const event of ["time", "physicsTick", "entityGone", "death", "end"]) assert.equal(added(event), 0, event);
  });

  // The successor's window starts when it holds the body: the predecessor's cleanup takes 2 s after the abort (a packet or
  // more of age), and the successor's own work starts after it. Its limit counts 120 ticks from the age cached then, not
  // from the claim's admission 2 s earlier.
  test(`a higher reflex taking over mid-claim starts its own window when it holds the body, after a predecessor's slow cleanup (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { runner, limits, bot, worldLimits, navigateNext, startRequest } = await onServer(ticksPerSecond, clock);
    const request = startRequest();
    await flush();
    const slowCleanup = (signal: AbortSignal) => new Promise<ClaimSettlement<string>>((resolve) => {
      signal.addEventListener("abort", () => void clock.after(2_000, () => resolve({ value: "stopped", continuation: { kind: "resume" } })), { once: true });
    });
    const first = watching(claimed(runner.claim("hostile_reflex", "fight", slowCleanup, undefined, worldLimits(100))));
    await clock.advance(60 * msPerTick - CREATED_AFTER_MS + 100); // the cached age is A + 60 when the successor is admitted
    assert.equal(bot.time.age, START_AGE + 60);
    let workAtAge = 0;
    let workAtMs = 0;
    const second = watching(claimed(runner.claim("fire_reflex", "burning", () => {
      [workAtAge, workAtMs] = [bot.time.age, clock.now()];
      return new Promise<never>(() => {});
    }, undefined, worldLimits(100))));
    assert.equal(workAtAge, 0, "the successor waits for the predecessor's release");
    await clock.advance(2_500);
    assert.notEqual(first(), null, "the first claim settled after its cleanup");
    assert.ok(workAtAge >= START_AGE + 60 + 20 * Math.floor(2_000 / (20 * msPerTick)), "the successor holds the body a cleanup later");
    await clock.advance(100 * msPerTick + CHECK_MS - (clock.now() - workAtMs));
    assert.equal(bot.time.age - workAtAge, 100);
    assert.deepEqual(limits, [], "A' + 100 (A' the age cached when it held the body): an origin at its admission would have ended it");
    await clock.advance(20 * msPerTick + 500 + CHECK_MS);
    assert.deepEqual(limits, [["fire_reflex", "no_progress"]]);
    const done = second();
    assert.ok(done && "failed" in done);
    assert.equal(limitOf(done.failed).elapsedTicks, 120, "counted from the age cached when the successor held the body");
    await clock.settle(request, 5_000);
    assert.equal((await clock.settle(navigateNext(), 5_000)).result.status, "succeeded");
  });
}

test("a cancelled claim whose work ignores the cancel, with no physics tick since, is released after the grace with no limit incident", async () => {
  const { runner, limits, pass } = fixture({ physicsStallMs: 30_000 });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(1_200))));
  await pass(200, false);
  runner.cancelActive("stop", { kind: "cancelled", by: "model" });
  await pass(450, false);
  assert.equal(end(), null);
  await pass(150, false);
  const done = end();
  assert.ok(done && "failed" in done);
  assert.ok(done.failed instanceof BodyAbort && done.failed.detail.kind === "cancelled", "the model's cancel is the reason, not a limit");
  assert.deepEqual(limits, []);
  assert.equal(runner.status().owner, "idle");
});
