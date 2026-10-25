// ActionRunner: admission of one action at a time, preparation, measurement, cancellation and reflex claims.
import assert from "node:assert/strict";
import test from "node:test";
import { BodyAbort } from "./abort.js";
import { ActionRunner } from "./action-runner.js";
import { stubAction, StubResult, started, untilOwner } from "./action-runner-fixtures.test.js";

for (const resumeInterrupted of [true, false]) {
  test(`an admitted request stays current through takeover until its ${resumeInterrupted ? "resumed" : "cancelled"} response`, async () => {
    const runner = new ActionRunner();
    const attempts = { count: 0 };
    const action = stubAction(
      async (_request, context) => {
        attempts.count += 1;
        assert.equal(runner.requestContext().requestId, 1236);
        if (attempts.count === 1) {
          await new Promise<void>((_resolve, reject) => {
            context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
          });
        }
        return { status: "succeeded" };
      },
      { kind: "resumable_task" },
    );
    const pending = runner.run(action, { block_name: "stone" }, undefined, 1236);
    await started(attempts, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claim = runner.claim("hostile_reflex", "hostile contact", async () => {
      await gate;
      return {
        value: undefined,
        continuation: resumeInterrupted ? { kind: "resume" as const } : { kind: "return" as const, reason: null },
      };
    });
    assert.equal(claim.kind, "claimed");
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    await untilOwner(runner, "takeover");
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    const information = stubAction(async () => ({ status: "succeeded" }), { kind: "information" });
    await runner.run(information, { block_name: "stone" }, undefined, 1237);
    const busy = await runner.run(action, { block_name: "stone" }, undefined, 1238);
    assert.equal(busy.result.status, "failed");
    assert.ok("error" in busy.result);
    assert.match(busy.result.error, /ACTION_BUSY/);
    await runner.run(action, {}, undefined, 1239);
    assert.deepEqual(runner.requestContext(), { requestId: 1236, preceding: null });
    const settledAfter = Date.now();
    release();
    const output = await pending;
    assert.equal(output.result.status, resumeInterrupted ? "succeeded" : "cancelled");
    assert.equal(attempts.count, resumeInterrupted ? 2 : 1);
    const context = runner.requestContext();
    assert.equal(context.requestId, null);
    assert.equal(context.preceding?.requestId, 1236);
    assert.ok(context.preceding.completedAtMs >= settledAfter);
    await runner.run(information, { block_name: "stone" }, undefined, 1240);
    assert.deepEqual(runner.requestContext(), context);
  });
}

test("a task owns the preparation that runs before its executor", async () => {
  const calls: string[] = [];
  const action = stubAction(
    async () => {
      calls.push("execute");
      return { status: "succeeded" };
    },
    {
      kind: "task",
      prepare: () => {
        calls.push("prepare");
      },
    },
  );

  await new ActionRunner().run(action, { block_name: "sand" });

  assert.deepEqual(calls, ["prepare", "execute"]);
});

test("the action runner admits only one action at a time", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = stubAction(async () => {
    await gate;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const first = runner.run(action, { block_name: "sand" });
  assert.equal(runner.status().busy, true);
  const refused = await runner.run(action, { block_name: "sand" });
  assert.equal(refused.result.status, "failed");
  assert.match(refused.result.error, /ACTION_BUSY/);
  release();
  await first;
  assert.equal(runner.status().busy, false);
});

test("the action runner measures an action and combines caller cancellation with its owned signal", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const action = stubAction(async (_request, context) => {
    observed = context.signal;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" }, controller.signal);

  assert.notEqual(observed, controller.signal);
  assert.equal(observed?.aborted, false);
  assert.deepEqual(Object.keys(output).sort(), ["action", "durationMs", "progress", "request", "result"]);
  assert.deepEqual(output.result, { status: "succeeded" });
});

test("a control action can cancel the foreground action while the session is busy", async () => {
  const runner = new ActionRunner();
  const run = runner.run;
  const cancelActive = runner.cancelActive;
  const foreground = stubAction(
    async (_request, context) =>
      new Promise<StubResult>((_resolve, reject) => {
        context.signal?.addEventListener("abort", () => reject(context.signal?.reason), { once: true });
      }),
  );
  const control = stubAction(
    async () => {
      const cancellation = cancelActive("coal collection stopped by test");
      assert.equal(cancellation.kind, "cancellation_requested");
      return { status: "succeeded" };
    },
    { kind: "control" },
  );

  const running = run(foreground, { block_name: "coal_ore" });
  const cancelled = await run(control, { block_name: "coal_ore" });
  const foregroundOutcome = await running;

  assert.deepEqual(cancelled.result, { status: "succeeded" });
  assert.deepEqual(foregroundOutcome.result, {
    kind: "runtime_failure",
    status: "cancelled",
    error: "coal collection stopped by test",
  });
  assert.equal(runner.status().busy, false);
});

test("bad arguments fail before execution starts", async () => {
  let started = false;
  const action = stubAction(async () => {
    started = true;
    return { status: "succeeded" };
  });
  const runner = new ActionRunner();

  const refused = await runner.run(action, {});

  assert.equal(refused.result.status, "failed");
  assert.match(refused.result.error, /\[INVALID_ARGUMENTS\] block_name is required/);
  assert.equal(started, false);
});

test("the action runner reports an executor throw without inventing action evidence", async () => {
  const action = stubAction(async () => {
    throw new Error("physics failed");
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" });

  assert.deepEqual(output.result, { kind: "runtime_failure", status: "failed", error: "physics failed" });
  assert.deepEqual(action.outputSchema.parse(output), output);
});

test("the action runner owns cancellation of an interrupted executor", async () => {
  const controller = new AbortController();
  const action = stubAction(async () => {
    controller.abort(new Error("operator stopped"));
    throw controller.signal.reason;
  });
  const runner = new ActionRunner();

  const output = await runner.run(action, { block_name: "sand" }, controller.signal);

  assert.deepEqual(output.result, { kind: "runtime_failure", status: "cancelled", error: "operator stopped" });
  assert.deepEqual(action.outputSchema.parse(output), output);
});

test("a claim waits for the interrupted owner to settle and keeps the session exclusive", async () => {
  let releaseInterrupted!: () => void;
  const interruptedMaySettle = new Promise<void>((resolve) => {
    releaseInterrupted = resolve;
  });
  let claimStarted = false;
  const foreground = stubAction(async (_request, context) => {
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    await interruptedMaySettle;
    throw context.signal?.reason;
  });
  const runner = new ActionRunner();

  const foregroundOutcome = runner.run(foreground, { block_name: "coal_ore" });
  const admission = runner.claim("hostile_reflex", "hostile contact", async () => {
    claimStarted = true;
    return { value: "engaged", continuation: { kind: "return" as const, reason: null } };
  });

  assert.equal(admission.kind, "claimed");
  assert.equal(runner.status().owner, "yielding");
  assert.equal(claimStarted, false);
  const refused = await runner.run(foreground, { block_name: "stone" });
  assert.ok("error" in refused.result);
  assert.match(refused.result.error, /ACTION_BUSY/);

  releaseInterrupted();
  const interrupted = await foregroundOutcome;
  assert.deepEqual(interrupted.result, {
    kind: "runtime_failure",
    status: "cancelled",
    error: "hostile contact",
  });
  if (admission.kind !== "claimed") return;
  assert.equal(admission.interrupted?.action, "stub");
  assert.equal(await admission.outcome, "engaged");
  assert.equal(claimStarted, true);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a reflex may claim an idle body, and the claim refuses actions while it runs", async () => {
  let releaseReflex!: () => void;
  const reflexMayFinish = new Promise<void>((resolve) => {
    releaseReflex = resolve;
  });
  const foreground = stubAction(async () => ({ status: "succeeded" }));
  const runner = new ActionRunner();

  assert.equal(runner.status().owner, "idle");
  const admission = runner.claim("hostile_reflex", "hostile contact", async () => {
    await reflexMayFinish;
    return { value: "engaged", continuation: { kind: "return" as const, reason: null } };
  });

  assert.equal(admission.kind, "claimed");
  if (admission.kind !== "claimed") return;
  assert.equal(admission.interrupted, null);
  assert.equal(runner.status().owner, "takeover");
  assert.equal(runner.status().activeAction?.action, "hostile_reflex");

  const refused = await runner.run(foreground, { block_name: "stone" });
  assert.ok("error" in refused.result);
  assert.match(refused.result.error, /ACTION_BUSY/);

  releaseReflex();
  assert.equal(await admission.outcome, "engaged");
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("an information action answers while a reflex owns the body", async () => {
  const runner = new ActionRunner();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim = runner.claim("reflex", "test", async () => {
    await held;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  assert.equal(claim.kind, "claimed");
  const read = stubAction(async () => ({ status: "succeeded" }), { kind: "information" });
  const output = await runner.run(read, { block_name: "stone" });
  assert.deepEqual(output.result, { status: "succeeded" });
  release();
  await (claim as { outcome: Promise<unknown> }).outcome;
});

test("a second claim is refused while a reflex owns the body", async () => {
  let releaseReflex!: () => void;
  const reflexMayFinish = new Promise<void>((resolve) => {
    releaseReflex = resolve;
  });
  const runner = new ActionRunner();

  const first = runner.claim("hostile_reflex", "hostile contact", async () => {
    await reflexMayFinish;
    return { value: "first", continuation: { kind: "return" as const, reason: null } };
  });
  const second = runner.claim("hostile_reflex", "hostile contact", async () => ({
    value: "second",
    continuation: { kind: "return" as const, reason: null },
  }));

  assert.equal(second.kind, "busy");
  if (second.kind !== "busy") return;
  assert.equal(second.activeAction.action, "hostile_reflex");

  releaseReflex();
  assert.equal(first.kind === "claimed" ? await first.outcome : null, "first");
});

test("cancelling the active owner aborts a running claim", async () => {
  const runner = new ActionRunner();
  const admission = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { value: signal.reason, continuation: { kind: "return" as const, reason: null } };
  });

  const cancellation = runner.cancelActive("Minecraft runtime closed");

  assert.equal(cancellation.kind, "cancellation_requested");
  const cause = admission.kind === "claimed" ? await admission.outcome : null;
  assert.ok(cause instanceof BodyAbort);
  assert.equal(cause.message, "Minecraft runtime closed");
  assert.deepEqual(cause.detail, { kind: "cancelled", by: "model" });
});
