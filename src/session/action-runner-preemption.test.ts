// ActionRunner: a task preempted by a reflex, the handoff, disconnect and reflex priority.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { z } from "zod";
import { defineAction, actionResultSchema, type ActionExecution } from "../actions/index.js";
import { BodyAbort } from "./abort.js";
import { ActionRunner } from "./action-runner.js";
import type { Continuation } from "./abort.js";
import { createFakeBot, createFakeClock, flush, type FakeClock } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { stubAction, stubResultSchema, stubInputSchema, StubAction, type StubResult, started, untilOwner } from "./action-runner-fixtures.test.js";

/** A task that yields to any abort by throwing its reason, and counts its runs. */
function preemptible(runs: { count: number }, execution: ActionExecution): StubAction {
  return stubAction(async (_request, context) => {
    runs.count += 1;
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw context.signal?.reason;
  }, execution);
}

const CONTACT = "[HOSTILE_CONTACT] evade response for zombie#12 at 1,2,3 (4.0 blocks).";
const SETTLED = "[HOSTILE_SETTLED] evade ended with capability_limit at health 6: x.";

for (const { name, continuation, result, expectedResult } of [
  {
    name: "a returned preemption appends its settle reason to the cancelled error",
    continuation: { kind: "return", reason: SETTLED }, result: { status: "cancelled", error: CONTACT },
    expectedResult: { status: "cancelled", error: `${CONTACT} ${SETTLED}` },
  },
  {
    name: "a returned preemption does not duplicate its settle suffix",
    continuation: { kind: "return", reason: SETTLED }, result: { status: "cancelled", error: `${CONTACT} ${SETTLED}` },
    expectedResult: { status: "cancelled", error: `${CONTACT} ${SETTLED}` },
  },
  {
    name: "a resumed preemption keeps its error untouched",
    continuation: { kind: "resume", reason: SETTLED }, result: { status: "cancelled", error: CONTACT },
    expectedResult: { status: "cancelled", error: CONTACT },
  },
  {
    name: "a returned verdict without a reason keeps the error",
    continuation: { kind: "return", reason: null }, result: { status: "cancelled", error: CONTACT },
    expectedResult: { status: "cancelled", error: CONTACT },
  },
  {
    name: "a returned preemption keeps a succeeded result untouched",
    continuation: { kind: "return", reason: SETTLED }, result: { status: "succeeded" },
    expectedResult: { status: "succeeded" },
  },
  ...(["failed", "partial"] as const).map((status) => ({
    name: `a returned preemption keeps a ${status} result untouched`,
    continuation: { kind: "return", reason: SETTLED } as const, result: { status, error: CONTACT },
    expectedResult: { status, error: CONTACT },
  })),
  ...([CONTACT, `${CONTACT} ${SETTLED}`]).map((error) => ({
    name: `a non-resumable held preemption appends its receipt once to ${error}`,
    continuation: { kind: "hold", owner: "hostile_reflex", backstopTicks: 600, reason: SETTLED } as const,
    result: { status: "cancelled", error } as const,
    expectedResult: { status: "cancelled", error: `${CONTACT} ${SETTLED}` } as const,
  })),
] satisfies { name: string; continuation: Continuation; result: StubResult; expectedResult: StubResult }[]) {
  test(name, async () => {
    stubResultSchema.parse(result);
    const runner = new ActionRunner();
    const runs = { count: 0 };
    const task = stubAction(async (_request, context) => {
      runs.count++;
      if (runs.count === 1) {
        await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      }
      return result;
    }, { kind: continuation.kind === "hold" ? "task" : "resumable_task" });
    const pending = runner.run(task, { block_name: "iron_ore" });
    await started(runs, 1);
    const claim = runner.claim("hostile_reflex", CONTACT, async () => ({ value: null, continuation }));
    assert.equal(claim.kind, "claimed");
    const output = await pending;
    assert.deepEqual(output.result, expectedResult);
    assert.deepEqual(output.interruptions, continuation.kind === "resume"
      ? [CONTACT, SETTLED] : continuation.reason === null ? undefined : [SETTLED]);
    assert.equal(runs.count, continuation.kind === "resume" ? 2 : 1);
    assert.equal(runner.status().busy, false);
  });
}

test("a resumable task preempted by a reflex runs again once the body is handed back fit", async () => {
  const runs = { count: 0 };
  const task = stubAction(
    async (_request, context) => {
      runs.count += 1;
      if (runs.count === 1) {
        await new Promise<void>((resolve) =>
          context.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        throw context.signal?.reason;
      }
      return { status: "succeeded" };
    },
    { kind: "resumable_task" },
  );
  const runner = new ActionRunner();

  const outcome = runner.run(task, { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "[HOSTILE_CONTACT] fight response for zombie#7.", async () => ({
    value: "killed",
    continuation: { kind: "resume" as const },
  }));

  assert.equal(claim.kind, "claimed");
  const output = await outcome;
  assert.equal(runs.count, 2);
  assert.deepEqual(output.result, { status: "succeeded" });
  assert.deepEqual(output.interruptions, ["[HOSTILE_CONTACT] fight response for zombie#7."]);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a request executor starts only after admission and is reused with fresh attempt signals", async () => {
  const runner = new ActionRunner();
  let begins = 0;
  const signals: AbortSignal[] = [];
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const task = defineAction({
    name: "transaction",
    description: "admitted request",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    execution: { kind: "resumable_task" },
    parse: (input: unknown) => {
      const value = stubInputSchema.parse(input);
      if (!value.block_name) throw new Error("required");
      return value;
    },
    begin: () => {
      begins++;
      return async ({ signal }) => {
        signals.push(signal!);
        if (signals.length === 1) {
          entered();
          await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
          signal!.throwIfAborted();
        }
        return { status: "succeeded" };
      };
    },
  });
  assert.equal((await runner.run(task, {})).result.status, "failed");
  assert.equal(begins, 0);
  const pending = runner.run(task, { block_name: "stone" });
  await started;
  assert.equal((await runner.run(task, { block_name: "stone" })).result.status, "failed");
  assert.equal(begins, 1);
  runner.claim("reflex", "ate", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  assert.equal((await pending).result.status, "succeeded");
  assert.equal(begins, 1);
  assert.equal(signals.length, 2);
  assert.equal(signals[0]!.aborted, true);
  assert.equal(signals[1]!.aborted, false);
});

test("a preempted task stays cancelled when the reflex throws", async () => {
  const work = async () => {
    throw new Error("session torn down");
  };
  const runs = { count: 0 };
  const runner = new ActionRunner();
  const outcome = runner.run(preemptible(runs, { kind: "resumable_task" }), { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "hostile contact", work);

  const output = await outcome;
  await (claim.kind === "claimed" ? claim.outcome.catch(() => undefined) : undefined);
  assert.equal(runs.count, 1);
  assert.equal(output.result.status, "cancelled");
  assert.equal(output.interruptions, undefined);
});

test("a task that did not declare its request safe to repeat is never resumed", async () => {
  const runs = { count: 0 };
  const runner = new ActionRunner();
  const outcome = runner.run(preemptible(runs, { kind: "task" }), { block_name: "iron_ore" });
  await started(runs, 1);
  runner.claim("hostile_reflex", "hostile contact", async () => ({
    value: "killed",
    continuation: { kind: "resume" as const },
  }));

  const output = await outcome;
  assert.equal(runs.count, 1);
  assert.equal(output.result.status, "cancelled");
});

for (const finish of ["complete", "cancel", "disconnect", "refuse"] as const) {
  test(`a fourth takeover waits for its verdict and honors ${finish}`, async () => {
    const runner = new ActionRunner();
    let attempts = 0;
    let begins = 0;
    const task = defineAction({
      name: "measured_task",
      description: "Preserve request progress across successful encounters",
      inputSchema: z.object({}),
      resultSchema: actionResultSchema({ collected: z.number() }),
      formatResult: (result) => result.status,
      execution: { kind: "resumable_task" },
      parse: () => ({}),
      begin: () => {
        begins++;
        let collected = 0;
        return async (context) => {
          attempts++;
          collected++;
          if (attempts === 5) return { status: "succeeded" as const, collected };
          const signal = context.signal;
          assert.ok(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          return { status: "partial" as const, error: String(signal.reason), collected };
        };
      },
    });
    let returned = false;
    const pending = runner.run(task, {}, undefined, 1311).then((result) => {
      returned = true;
      return result;
    });
    for (let encounter = 1; encounter <= 4; encounter++) {
      await untilOwner(runner, "foreground");
      await new Promise((resolve) => setImmediate(resolve));
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const claim = runner.claim("hostile_reflex", `contact ${encounter}`, async (signal) => {
        await held;
        return {
          value: null,
          continuation:
            !signal.aborted && !(finish === "refuse" && encounter === 4)
              ? { kind: "resume" as const }
              : { kind: "return" as const, reason: null },
        };
      });
      assert.equal(claim.kind, "claimed");
      if (claim.kind !== "claimed") throw new Error("Expected claim");
      if (encounter === 4) {
        await untilOwner(runner, "takeover");
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(returned, false, "the fourth verdict is still pending");
        assert.equal(runner.requestContext().requestId, 1311);
        if (finish === "cancel") runner.cancelActive("operator stop");
        if (finish === "disconnect") runner.disconnect("connection ended");
      }
      release();
      await claim.outcome.catch(() => undefined);
    }
    const output = await pending;
    assert.equal(begins, 1);
    assert.equal(attempts, finish === "complete" ? 5 : 4);
    if (finish === "complete") {
      assert.equal(output.result.status, "succeeded");
      assert.ok("collected" in output.result);
      assert.equal(output.result.collected, 5);
      assert.deepEqual(output.interruptions, ["contact 1", "contact 2", "contact 3", "contact 4"]);
    } else if (finish === "disconnect") assert.equal(output.result.status, "failed");
    else {
      assert.equal(output.result.status, "partial");
      assert.ok("collected" in output.result);
      assert.equal(output.result.collected, 4);
    }
  });
}

test("a control cancellation during the handoff is final: the task is not resumed", async () => {
  const runs = { count: 0 };
  const runner = new ActionRunner();
  const outcome = runner.run(preemptible(runs, { kind: "resumable_task" }), { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "hostile contact", async () => ({
    value: "killed",
    continuation: { kind: "resume" as const },
  }));
  runner.cancelActive("operator stop");

  const output = await outcome;
  if (claim.kind === "claimed") await claim.outcome.catch(() => undefined);
  assert.equal(runs.count, 1);
  assert.equal(output.result.status, "cancelled");
  assert.equal(output.interruptions, undefined);
});

test("cancelling the request during a reflex handoff stops the action for good", async () => {
  const runs = { count: 0 };
  const lifetimes: AbortSignal[] = [];
  const task = defineAction({
    name: "stub",
    description: "stub",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    execution: { kind: "resumable_task" },
    parse: (input: unknown) => {
      const value = stubInputSchema.parse(input);
      if (!value.block_name) throw new Error("required");
      return value;
    },
    begin: (_request, lifetime) => {
      lifetimes.push(lifetime);
      return async (context) => {
        runs.count += 1;
        await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw context.signal?.reason;
      };
    },
  });
  const runner = new ActionRunner();
  const outcome = runner.run(task, { block_name: "iron_ore" }, undefined, 1236, "request-cancelled-in-handoff");
  await started(runs, 1);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reflexSignal: AbortSignal | undefined;
  const claim = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
    reflexSignal = signal;
    await gate;
    return { value: "killed", continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  assert.equal(runner.cancelRequest("request-cancelled-in-handoff", "operator stop").kind, "cancellation_requested");

  const lifetime = lifetimes[0];
  assert.equal(lifetime?.aborted, true);
  assert.ok(lifetime?.reason instanceof BodyAbort);
  assert.deepEqual(lifetime.reason.detail, { kind: "cancelled", by: "model" });

  release();
  const output = await outcome;
  if (claim.kind !== "claimed") throw new Error("Expected claim");
  // The request's cancel stops the objective, not the reflex that holds the body: it finishes its work. (The interrupted
  // action's own controller is already aborted by the claim, so cancelRequest aborting it again changes nothing.)
  assert.equal(await claim.outcome, "killed", "the reflex finished its work");
  assert.equal(reflexSignal?.aborted, false, "the cancellation never aborted the reflex");
  assert.equal(runs.count, 1);
  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(output.interruptions, ["hostile contact"]);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("disconnect settles an action awaiting a reflex that never returns", async () => {
  const runner = new ActionRunner();
  const runs = { count: 0 };
  const pending = runner.run(preemptible(runs, { kind: "resumable_task" }), { block_name: "iron_ore" });
  await started(runs, 1);
  const claim = runner.claim("hostile_reflex", "hostile contact", () => new Promise<never>(() => {}));
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const ended = assert.rejects(claim.outcome, /MINECRAFT_DISCONNECTED/);
  await untilOwner(runner, "takeover");
  runner.disconnect("socket closed during reflex");
  const output = await pending;
  await ended;
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /MINECRAFT_DISCONNECTED/);
  assert.equal(runs.count, 1);
  assert.equal(runner.status().busy, false);
});

test("disconnect settles a yielding claim and late foreground cleanup cannot reacquire the body", async () => {
  const runner = new ActionRunner();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  const action = stubAction(
    async () => {
      entered = true;
      await blocked;
      return { status: "succeeded", collected: 1 };
    },
    { kind: "task" },
  );
  const pending = runner.run(action, { block_name: "iron_ore" });
  while (!entered) await Promise.resolve();
  let claimed = false;
  const claim = runner.claim("reflex", "contact", async () => {
    claimed = true;
    return { value: "done", continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") return;
  const rejected = assert.rejects(claim.outcome, /socket ended/);
  runner.disconnect("socket ended");
  assert.equal((await pending).result.status, "failed");
  await rejected;
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(claimed, false);
  assert.equal(runner.status().owner, "idle");
});

test("disconnect ends the admitted lifetime even when its physical executor never settles", async () => {
  const runner = new ActionRunner();
  let lifetime: AbortSignal | undefined;
  let disposed = 0;
  const action = defineAction({
    name: "unsettled_lifetime",
    description: "A lost connection may leave a physical promise unsettled.",
    inputSchema: z.object({}),
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: () => ({}),
    execution: { kind: "resumable_task" },
    begin: (_request, admitted) => {
      lifetime = admitted;
      admitted.addEventListener(
        "abort",
        () => {
          disposed++;
        },
        { once: true },
      );
      return async () => new Promise<never>(() => {});
    },
  });
  const pending = runner.run(action, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(lifetime);
  assert.equal(lifetime.aborted, false);
  runner.disconnect("socket closed");
  assert.equal((await pending).result.status, "failed");
  assert.equal(lifetime.aborted, true);
  assert.equal(disposed, 1);
});

test("higher priority reflexes request cancellation but cannot drive until the previous owner releases", async () => {
  const runner = new ActionRunner();
  let ownedSignal: AbortSignal | null = null;
  let release!: () => void;
  const releasing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lower = runner.claim("hostile_reflex", "fight", async (signal) => {
    ownedSignal = signal;
    await releasing;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(lower.kind, "claimed");
  await new Promise((resolve) => setImmediate(resolve));
  let higherStarted = false;
  const escape = async () => {
    higherStarted = true;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  };
  const breath = runner.claim("breath_reflex", "surface", escape);
  assert.equal(breath.kind, "claimed");
  assert.equal((ownedSignal as AbortSignal | null)?.aborted, true);
  assert.equal(higherStarted, false);
  const higher = runner.claim("fire_reflex", "escape", escape);
  assert.equal(higher.kind, "claimed");
  release();
  if (lower.kind === "claimed") await lower.outcome;
  if (breath.kind === "claimed") await breath.outcome;
  if (higher.kind === "claimed") await higher.outcome;
  assert.equal(higherStarted, true);
});

const SETTLED_HOLD = "[HOSTILE_SETTLED] evade ended with capability_limit at health 11.";
const CONTACT_2 = "[HOSTILE_CONTACT] fight response for zombie#12.";
const SETTLED_RESUME = "[HOSTILE_SETTLED] fight ended with target_died; 2nd response to zombie#12.";
const SETTLED_RETURN = "[HOSTILE_SETTLED] fight ended with capability_blocked; 2nd response to zombie#12.";
const HOLD: Continuation = { kind: "hold", owner: "hostile_reflex", reason: SETTLED_HOLD, backstopTicks: 600 };

/** Suspend the first attempt; a resumed attempt demonstrates a fresh usable body. */
async function heldWalk(clock: FakeClock, ticksPerSecond: number, resumable = true, receipted = false, holds = 1) {
  const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 1_000 } });
  const runner = new ActionRunner({ clock, worldAge: () => harness.bot.time.age });
  const caller = new AbortController();
  const runs = { count: 0 };
  const task = stubAction(async (_request, context) => {
    runs.count++;
    if (runs.count <= holds) {
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      if (receipted) return { status: "cancelled", error: `${CONTACT} ${SETTLED_HOLD}` };
      context.signal!.throwIfAborted();
    }
    return { status: "succeeded" };
  }, { kind: resumable ? "resumable_task" : "task" });
  const pending = runner.run(task, { block_name: "stone" }, caller.signal, 8, "held-walk");
  const settled = watch(pending);
  await started(runs, 1);
  const metadata = runner.status().activeAction;
  const first = runner.claim("hostile_reflex", CONTACT, async () => ({ value: null, continuation: HOLD }));
  assert.equal(first.kind, "claimed");
  if (first.kind !== "claimed") throw new Error("Expected initial claim");
  await first.outcome;
  await flush();
  return { ...harness, runner, caller, runs, pending, settled, metadata };
}

/** A claim whose physical release the test controls independently from its abort. */
function gatedClaim(runner: ActionRunner, name = "hostile_reflex") {
  let release!: (continuation: Continuation) => void;
  const verdict = new Promise<Continuation>((resolve) => { release = resolve; });
  const signals: AbortSignal[] = [];
  const claim = runner.claim(name, CONTACT_2, async (signal) => {
    signals.push(signal);
    return { value: null, continuation: await verdict };
  });
  assert.equal(claim.kind, "claimed");
  if (claim.kind !== "claimed") throw new Error("Expected attached claim");
  return { claim, release, signals };
}

/** Every terminal hold leaves either a usable body or a terminal disconnected session. */
async function nextWalk(runner: ActionRunner, connected = true) {
  const next = await runner.run(stubAction(async () => ({ status: "succeeded" })), { block_name: "stone" });
  assert.equal(next.result.status, connected ? "succeeded" : "failed");
  if (!connected) { assert.ok("error" in next.result); assert.match(next.result.error!, /MINECRAFT_DISCONNECTED/); }
}

for (const ticksPerSecond of [20, 10]) {
  // The stopped rows: `stopped` at once (0 ticks heard), `partial` after 100 server ticks heard, then the clock stops.
  for (const first of ["backstop", "stopped", "partial"] as const) {
    test(`held walk evidence ${first} wins before the retired deadline at ${ticksPerSecond} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { runner, pending, bot, server, runs, caller } = await heldWalk(clock, ticksPerSecond);
      const evidence = "no projectile in flight, target zombie#12 alive at 21.7 blocks";
      let settlements = 0;
      void pending.then(() => settlements++);
      if (first === "partial") await clock.advance(100 * (1_000 / ticksPerSecond), 100);
      if (first !== "backstop") server.stop();
      await clock.settle(pending, 100_000);
      const heard = bot.time.age - 1_000;
      if (first === "backstop") assert.ok(bot.time.age >= 1_620);
      if (first === "stopped") assert.equal(heard, 0);
      if (first === "partial") assert.ok(heard > 0 && heard < 600, `expected some ticks heard, got ${heard}`);
      assert.equal(runner.releaseHold("hostile_reflex", "stand_down", evidence), false);
      const output = await clock.settle(pending, 1_000);
      assert.equal(output.result.status, "cancelled");
      assert.equal(runs.count, 1);
      const receipt = output.interruptions!.at(-1)!;
      if (first === "backstop") assert.match(receipt, /within 600 world ticks\.$/);
      else {
        const match = /; no decision from hostile_reflex: the server clock stood still for (\d+) s \((\d+) world ticks heard\)\.$/
          .exec(receipt);
        assert.ok(match, `receipt names the stopped clock: ${receipt}`);
        assert.equal(Number(match[2]), heard);
        assert.ok(Number(match[1]) >= 20, `stood still for at least the 20 s stop bound, got ${match[1]} s`);
      }
      await nextWalk(runner);
      await clock.advance(100_000, 1_000);
      assert.equal(settlements, 1);
      assert.equal(clock.pendingGlobalTimers(), 0);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    });
  }
  for (const holds of [1, 2]) {
    test(`held walk resumes on evidence and preserves ${holds} hold records at ${ticksPerSecond} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { runner, runs, pending, bot, caller } = await heldWalk(clock, ticksPerSecond, true, false, holds);
      let settlements = 0;
      void pending.then(() => settlements++);
      const evidence = "no projectile in flight, no hostile tracked";
      const receipt = `${SETTLED_HOLD}; hostile_reflex stood down (${evidence}): the walk resumes.`;
      assert.equal(runner.releaseHold("hunger_reflex", "none_observed", evidence), false);
      assert.equal(runner.releaseHold("hostile_reflex", "none_observed", evidence), true);
      await started(runs, 2);
      if (holds === 2) {
        const second = gatedClaim(runner);
        second.release(HOLD);
        await second.claim.outcome;
        await flush();
        assert.equal(runner.releaseHold("hostile_reflex", "handled", null), true);
      }
      const output = await clock.settle(pending, 1_000);
      assert.equal(runs.count, 2);
      assert.equal(clock.now(), 0);
      assert.equal(bot.time.age, 1_000);
      assert.equal(output.result.status, holds === 1 ? "succeeded" : "cancelled");
      assert.deepEqual(output.interruptions, holds === 1 ? [receipt]
        : [receipt, `${SETTLED_HOLD}; hostile_reflex chose no further response (handled).`]);
      if (output.result.status === "cancelled") assert.ok(output.result.error.includes(SETTLED_HOLD));
      assert.equal(runner.releaseHold("hostile_reflex", "late", evidence), false);
      await nextWalk(runner);
      await clock.advance(100_000, 1_000);
      assert.equal(settlements, 1);
      assert.equal(clock.pendingGlobalTimers(), 0);
      assert.equal(getEventListeners(caller.signal, "abort").length, 0);
    });
  }
  for (const scenario of ["resume", "return", "release", "release-receipted", "hold-again", "hunger", "higher", "backstop", "backstop-receipted", "busy"] as const) {
    test(`held walk ${scenario}: preserves the request and ordered chain at ${ticksPerSecond} tps`, async () => {
      const ending = scenario === "release-receipted" ? "release" : scenario === "backstop-receipted" ? "backstop" : scenario;
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const fixture = await heldWalk(clock, ticksPerSecond, true, scenario.endsWith("-receipted"));
      const { runner, runs, pending, settled, metadata } = fixture;
      assert.equal(settled.over, false, "a hold must not return the request");
      assert.equal(runner.request()?.state.kind, "suspended");
      assert.equal(runner.status().owner, "idle");
      if (ending === "busy") {
        const refused = await runner.run(stubAction(async () => ({ status: "succeeded" })), { block_name: "stone" });
        assert.ok("error" in refused.result);
        assert.match(refused.result.error!, /ACTION_BUSY.*stub/);
        assert.equal(runner.request()?.id, "held-walk");
      }
      if (ending === "hunger") {
        const hunger = gatedClaim(runner, "hunger_reflex");
        hunger.release({ kind: "resume" });
        await hunger.claim.outcome;
        await flush();
        assert.equal(settled.over, false);
        assert.equal(runs.count, 1);
      }
      if (ending === "release" || ending === "busy") {
        assert.equal(runner.releaseHold("hunger_reflex", "stand_down"), false);
        assert.equal(runner.releaseHold("hostile_reflex", "stand_down"), true);
      } else if (ending === "backstop") {
        const startedMs = clock.now();
        await clock.advance(600 * 1_000 / ticksPerSecond);
        assert.equal(settled.over, false);
        await clock.settle(pending, 40 * 1_000 / ticksPerSecond);
        assert.ok(clock.now() - startedMs >= 600 * 1_000 / ticksPerSecond);
        assert.ok(fixture.bot.time.age! >= 1_620);
      } else {
        if (ending === "higher" || ending === "hold-again") await clock.advance(400 * 1_000 / ticksPerSecond);
        const attached = gatedClaim(runner);
        assert.deepEqual(attached.claim.interrupted, metadata);
        if (ending === "higher" || ending === "hold-again") {
          await clock.advance(700 * 1_000 / ticksPerSecond);
          assert.equal(settled.over, false, "an attached response outlives the old waiting deadline");
          assert.equal(clock.pendingGlobalTimers(), 0);
        }
        if (ending === "higher") {
          const higher = gatedClaim(runner, "recover_footing");
          attached.release({ kind: "return", reason: "superseded lower verdict" });
          higher.release({ kind: "resume" });
          await attached.claim.outcome;
          await higher.claim.outcome;
          await flush();
          assert.equal(settled.over, false, "footing cannot resume a hostile-held walk");
          await clock.advance(600 * 1_000 / ticksPerSecond);
          assert.equal(settled.over, false, "the inherited resume starts a new full hold budget");
          assert.equal(runner.releaseHold("hostile_reflex", "stand_down"), true);
        } else if (ending === "hold-again") {
          attached.release(HOLD);
          await attached.claim.outcome;
          await flush();
          assert.equal(settled.over, false);
          await clock.advance(600 * 1_000 / ticksPerSecond);
          assert.equal(settled.over, false, "a second hold starts a new full budget");
          const last = gatedClaim(runner);
          last.release({ kind: "resume", reason: SETTLED_RESUME });
          await last.claim.outcome;
        } else {
          attached.release(ending === "resume" ? { kind: "resume", reason: SETTLED_RESUME }
            : { kind: "return", reason: SETTLED_RETURN });
          await attached.claim.outcome;
        }
      }
      const output = await pending;
      const error = "error" in output.result ? output.result.error : undefined;
      assert.equal(runs.count, ending === "resume" || ending === "hold-again" ? 2 : 1);
      if (ending === "resume") assert.deepEqual(output.interruptions, [SETTLED_HOLD, CONTACT_2, SETTLED_RESUME]);
      else if (ending === "hold-again") assert.deepEqual(output.interruptions, [SETTLED_HOLD, CONTACT_2, SETTLED_HOLD, CONTACT_2, SETTLED_RESUME]);
      else if (ending === "return" || ending === "hunger") {
        assert.equal(error, `${CONTACT} ${SETTLED_HOLD} ${CONTACT_2} ${SETTLED_RETURN}`);
      } else if (ending === "backstop") assert.match(error!, /no decision from hostile_reflex within 600 world ticks/);
      else assert.ok(error!.endsWith(`${SETTLED_HOLD}${ending === "higher" ? ` ${CONTACT_2}` : ""}; hostile_reflex chose no further response (stand_down).`));
      if (scenario.endsWith("-receipted")) assert.equal(error!.split(SETTLED_HOLD).length - 1, 1, "one response receipt occurs once");
      assert.equal(output.result.status, ending === "resume" || ending === "hold-again" ? "succeeded" : "cancelled");
      assert.equal(runner.releaseHold("hostile_reflex", "late"), false);
      assert.equal(clock.pendingGlobalTimers(), 0);
      await nextWalk(runner);
      await clock.advance(100_000, 1_000);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }

  for (const stop of ["request", "signal", "death", "disconnect", "dimension"] as const) {
    for (const stage of ["waiting", "attached", "yielding"] as const) {
      if (stage === "yielding" && (stop === "disconnect" || stop === "dimension")) continue;
      test(`held walk ${stop} while ${stage} settles once and leaves the next action usable at ${ticksPerSecond} tps`, async () => {
        const clock = createFakeClock({ mode: "mocked" });
        using _timers = clock.install();
        const { runner, caller, pending, settled, runs } = await heldWalk(clock, ticksPerSecond);
        assert.equal(settled.over, false, "a hold must not return the request");
        let settlements = 0;
        void pending.then(() => { settlements++; });
        const attached = stage === "waiting" ? null : gatedClaim(runner);
        await flush();
        const higher = stage === "yielding" ? gatedClaim(runner, "recover_footing") : null;
        const attachedEnd = attached?.claim.outcome.catch(() => undefined);
        const higherEnd = higher?.claim.outcome.catch(() => undefined);
        const liveSignals = [...(attached?.signals ?? [])];
        const priorAborts = liveSignals.map((signal) => signal.aborted);
        if (stop === "request") runner.cancelRequest("held-walk", "operator stop");
        if (stop === "signal") caller.abort("caller stop");
        if (stop === "death") runner.cancelActive("died", { kind: "death" });
        if (stop === "disconnect") runner.disconnect("socket ended");
        if (stop === "dimension") runner.dimensionChanged("overworld", "nether");
        if (stop !== "dimension") {
          const output = await clock.settle(pending, 1);
          assert.equal(output.result.status, stop === "disconnect" ? "failed" : "cancelled");
          assert.equal(runs.count, 1);
          assert.equal(runner.request(), null);
          if (stop !== "disconnect") assert.deepEqual(liveSignals.map((signal) => signal.aborted), priorAborts, "request stops leave reflex signals untouched");
          if (attached && stop !== "disconnect") {
            const refused = await runner.run(stubAction(async () => ({ status: "succeeded" })), { block_name: "stone" });
            assert.ok("error" in refused.result);
            assert.match(refused.result.error!, /ACTION_BUSY/);
          }
        }
        attached?.release({ kind: "resume", reason: SETTLED_RESUME });
        higher?.release({ kind: "resume" });
        await attachedEnd;
        await higherEnd;
        if (stop === "dimension") {
          assert.equal((await pending).result.status, "succeeded");
          assert.equal(runs.count, 2);
        }
        await flush();
        assert.equal(settlements, 1);
        assert.equal(getEventListeners(caller.signal, "abort").length, 0);
        assert.equal(clock.pendingGlobalTimers(), 0);
        await nextWalk(runner, stop !== "disconnect");
        await clock.advance(100_000, 1_000);
        assert.equal(settlements, 1);
        assert.equal(clock.pendingGlobalTimers(), 0);
      });
    }
  }

  for (const ending of ["throw", "limit", "nonresumable", "ownership-listener"] as const) {
    test(`held walk ${ending} at ${ticksPerSecond} tps`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      if (ending === "ownership-listener") {
        const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 1_000 } });
        const runner = new ActionRunner({ clock, worldAge: () => harness.bot.time.age });
        const runs = { count: 0 };
        const pending = runner.run(preemptible(runs, { kind: "resumable_task" }), { block_name: "stone" });
        await started(runs, 1);
        let attached = false;
        const remove = runner.onOwnershipChange(() => {
          if (runner.status().owner !== "idle" || attached) return;
          attached = true;
          const successor = runner.claim("hostile_reflex", CONTACT_2, async () => ({ value: null, continuation: { kind: "return", reason: SETTLED_RETURN } }));
          assert.equal(successor.kind, "claimed");
          if (successor.kind === "claimed") assert.equal(successor.interrupted?.action, "stub");
        });
        const first = runner.claim("hostile_reflex", CONTACT, async () => ({ value: null, continuation: HOLD }));
        if (first.kind === "claimed") await first.outcome;
        const output = await pending;
        remove();
        assert.equal(attached, true);
        assert.ok("error" in output.result);
        assert.equal(output.result.error, `${CONTACT} ${SETTLED_HOLD} ${CONTACT_2} ${SETTLED_RETURN}`);
        await nextWalk(runner);
      } else {
        const { runner, pending, settled, runs } = await heldWalk(clock, ticksPerSecond, ending !== "nonresumable");
        if (ending === "nonresumable") {
          assert.equal(settled.over, true);
          const output = await pending;
          assert.ok("error" in output.result);
          assert.equal(output.result.error, `${CONTACT} ${SETTLED_HOLD}`);
          const later = runner.claim("hostile_reflex", CONTACT_2, async () => ({ value: null, continuation: { kind: "resume" } }));
          assert.equal(later.kind, "claimed");
          if (later.kind === "claimed") { assert.equal(later.interrupted, null); await later.outcome; }
        } else {
          assert.equal(settled.over, false, "a hold must not return the request");
          const claim = runner.claim("hostile_reflex", CONTACT_2, async () => {
            if (ending === "throw") throw new Error("claim failed");
            return { value: null, continuation: { kind: "return", reason: "[REFLEX_LIMIT] fight has no progress." } };
          });
          if (claim.kind === "claimed") await claim.outcome.catch(() => undefined);
          const output = await pending;
          assert.equal(output.result.status, "cancelled");
          assert.ok("error" in output.result);
          assert.ok(output.result.error!.includes(`${SETTLED_HOLD} ${CONTACT_2}`));
          if (ending === "limit") assert.ok(output.result.error!.endsWith("[REFLEX_LIMIT] fight has no progress."));
        }
        assert.equal(runs.count, 1);
        await nextWalk(runner);
      }
      assert.equal(clock.pendingGlobalTimers(), 0);
      await clock.advance(100_000, 1_000);
      assert.equal(clock.pendingGlobalTimers(), 0);
    });
  }
}
