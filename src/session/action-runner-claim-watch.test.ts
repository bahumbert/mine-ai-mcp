// The claim watch: a reflex that holds the body is held to the physics-stall limit, a ceiling and a no-progress limit
// (SRV-01, SEC-09), on the runner's own clock.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { actionResultSchema, defineAction, type Action } from "../actions/index.js";
import { flush, handClock } from "../test-support/hand-clock.js";
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

const noProgress = (ms: number, marks: () => number = () => 0): ClaimLimits => ({ ceilingMs: 600_000, noProgressMs: ms, progressMarks: marks });
const ceiling = (ms: number): ClaimLimits => ({ ceilingMs: ms, noProgressMs: 600_000, progressMarks: () => 0 });

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
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(10_000))));
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
  const end = watching(claimed(runner.claim("fire_reflex", "burning", deaf(), undefined, noProgress(6_000, () => marks))));
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
  watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(5_000))));
  await time.advance(4_900);
  assert.deepEqual(limits, []);
  await time.advance(200);
  assert.deepEqual(limits, ["ceiling"]);
});

test("a claim on a server that ticks every 150 ms is limited by wall time only", async () => {
  const { runner, time, limits } = fixture({ physicsStallMs: 1_000 });
  watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(20_000))));
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
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", () => late, undefined, ceiling(2_000))));
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
  const end = watching<string>(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(2_000))));
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
  watching(claimed(runner.claim("hostile_reflex", "[HOSTILE] contact", deaf(), undefined, ceiling(3_000))));
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
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, { ceilingMs: 60_000, noProgressMs: 30_000, progressMarks: () => 0 })));
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
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(5_000))));
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
    const end = watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(5_000))));
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
    return watching(claimed(runner.claim("hostile_reflex", "fight", work, undefined, ceiling(60_000))));
  });
  await time.advance(500);
  assert.equal(time.timers(), 40, "the limit timer and the no-progress sampler of each claim");
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

test("a cancelled claim whose work ignores the cancel, with no physics tick since, is released after the grace with no limit incident", async () => {
  const { runner, limits, pass } = fixture({ physicsStallMs: 30_000 });
  const end = watching(claimed(runner.claim("hostile_reflex", "fight", deaf(), undefined, ceiling(60_000))));
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
