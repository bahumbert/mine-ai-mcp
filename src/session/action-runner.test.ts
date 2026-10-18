import { getAmbientHighlighterContext } from "@aibengineering/minecraft-block-highlighter";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { z } from "zod";
import {
  defineAction,
  actionResultSchema,
  type Action,
  type ActionExecution,
} from "../actions/index.js";
import { ReflexDriver } from "../survival/control/driver.js";
import { attachFootingReflex } from "../survival/reflexes/footing.js";
import { BodyAbort } from "./abort.js";
import type { StallClock } from "../actions/stall-watch.js";
import { ActionRunner } from "./action-runner.js";
import { RouteOutcomes } from "../navigation/index.js";
import { PinnedWatch, type PinnedEscape } from "./pinned-watch.js";

test("disconnect fails an executor that never settles and permanently closes admission", async () => {
  const runner = new ActionRunner();
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = stubAction(async () => {
    entered();
    return new Promise<never>(() => {});
  });
  const pending = runner.run(action, { block_name: "stone" }, undefined, 1236);
  await executing;
  assert.equal(runner.requestContext().requestId, 1236);
  runner.disconnect("Minecraft connection ended: socketClosed");
  const output = await pending;
  assert.equal(runner.requestContext().requestId, null);
  assert.equal(runner.requestContext().preceding?.requestId, 1236);
  assert.equal(output.result.status, "failed");
  assert.match(output.result.error ?? "", /MINECRAFT_DISCONNECTED.*socketClosed/);
  assert.equal(runner.status().busy, false);
  const refused = (await runner.run(action, {})).result;
  assert.equal(refused.status, "failed");
  assert.match("error" in refused ? refused.error : "", /MINECRAFT_DISCONNECTED/);
});

const stubInputSchema = z.object({ block_name: z.string().optional() });

test("an admitted footing claim releases navigation before its recovery takes the airborne body", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  const order: string[] = [];
  let release!: () => void;
  const navigationReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = stubAction(async (_request, context) => {
    await navigationReleased;
    order.push("foreground released");
    context.signal!.throwIfAborted();
    return { status: "succeeded" };
  });
  const pending = runner.run(action, { block_name: "stone" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  let needed = true;
  const recovery = {
    get needed() {
      return needed;
    },
    async recover(): Promise<"landed"> {
      needed = false;
      order.push("recovery owns body");
      return "landed";
    },
  };
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(driver, { activeEngagement: () => null }, recovery, () => {
    assert.equal(runner.status().owner, "yielding", "The handoff must first reserve the next body owner.");
    order.push("navigation interrupted");
    release();
  });
  try {
    bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["navigation interrupted", "foreground released", "recovery owns body"]);
  } finally {
    release();
    await pending;
    await reflex[Symbol.asyncDispose]();
  }
});

test("footing recovery releases navigation while a cancelled lower reflex waits for its handoff", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  const order: string[] = [];
  let release!: () => void;
  const navigationReleased = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = runner.run(
    stubAction(async (_request, context) => {
      await navigationReleased;
      order.push("foreground released");
      context.signal!.throwIfAborted();
      return { status: "succeeded" };
    }),
    { block_name: "stone" },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lower = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
    order.push("cancelled reflex released");
    assert.equal(signal.aborted, true);
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  let needed = true;
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(
    driver,
    { activeEngagement: () => null },
    {
      get needed() {
        return needed;
      },
      async recover(): Promise<"landed"> {
        order.push("recovery owns body");
        needed = false;
        return "landed";
      },
    },
    () => {
      order.push("navigation interrupted");
      release();
    },
  );
  try {
    bot.emit("physicsTick");
    assert.deepEqual(order, ["navigation interrupted"]);
    if (lower.kind === "claimed") await lower.outcome;
    await pending;
    bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [
      "navigation interrupted",
      "foreground released",
      "cancelled reflex released",
      "recovery owns body",
    ]);
  } finally {
    release();
    await pending;
    if (lower.kind === "claimed") await lower.outcome;
    await reflex[Symbol.asyncDispose]();
  }
});

for (const resumeInterrupted of [true, false]) {
  test(`a higher reflex preserves the original request until its ${resumeInterrupted ? "resume" : "stop"} verdict`, async () => {
    const runner = new ActionRunner();
    const order: string[] = [];
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const request = runner.run(
      stubAction(
        async (_request, context) => {
          attempts++;
          if (attempts === 1) {
            await cleanup;
            order.push("foreground released");
            context.signal!.throwIfAborted();
          }
          order.push("foreground resumed");
          return { status: "succeeded" };
        },
        { kind: "resumable_task" },
      ),
      { block_name: "stone" },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lower = runner.claim("hostile_reflex", "hostile contact", async (signal) => {
      order.push("lower released");
      signal.throwIfAborted();
      return { value: null, continuation: { kind: "resume" as const } };
    });
    const lowerFinished = lower.kind === "claimed" ? lower.outcome.catch(() => undefined) : Promise.resolve();
    const higher = runner.claim("recover_footing", "unsafe impulse", async () => {
      order.push("recovery owns body");
      return {
        value: null,
        continuation: resumeInterrupted ? { kind: "resume" as const } : { kind: "return" as const, reason: null },
      };
    });
    try {
      assert.equal(higher.kind, "claimed");
      assert.deepEqual(order, []);
      release();
      await lowerFinished;
      if (higher.kind === "claimed") await higher.outcome;
      const output = await request;
      assert.equal(output.result.status, resumeInterrupted ? "succeeded" : "cancelled");
      assert.equal(attempts, resumeInterrupted ? 2 : 1);
      assert.deepEqual(order, [
        "foreground released",
        "lower released",
        "recovery owns body",
        ...(resumeInterrupted ? ["foreground resumed"] : []),
      ]);
    } finally {
      release();
      await lowerFinished;
      if (higher.kind === "claimed") await higher.outcome;
      await request;
    }
  });
}

test("operator cancellation during a higher reflex cannot resume the original request", async () => {
  const runner = new ActionRunner();
  let releaseRoute!: () => void;
  const route = new Promise<void>((resolve) => {
    releaseRoute = resolve;
  });
  let releaseRecovery!: () => void;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  let recoveryStarted = false;
  let attempts = 0;
  const request = runner.run(
    stubAction(
      async (_request, context) => {
        attempts++;
        if (attempts === 1) {
          await route;
          context.signal!.throwIfAborted();
        }
        return { status: "succeeded" };
      },
      { kind: "resumable_task" },
    ),
    { block_name: "stone" },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lower = runner.claim("hostile_reflex", "contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: null },
  }));
  const higher = runner.claim("recover_footing", "impulse", async () => {
    recoveryStarted = true;
    await recovery;
    return { value: null, continuation: { kind: "resume" as const } };
  });
  try {
    assert.equal(higher.kind, "claimed");
    releaseRoute();
    if (lower.kind === "claimed") await lower.outcome;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(recoveryStarted, true);
    runner.cancelActive("operator cancellation");
    releaseRecovery();
    if (higher.kind === "claimed") await higher.outcome;
    assert.equal((await request).result.status, "cancelled");
    assert.equal(attempts, 1);
  } finally {
    releaseRoute();
    releaseRecovery();
    if (lower.kind === "claimed") await lower.outcome;
    if (higher.kind === "claimed") await higher.outcome;
    await request;
  }
});

test("a refused footing claim cannot release another reflex's navigation", async () => {
  const runner = new ActionRunner();
  const bot = new EventEmitter() as unknown as Bot;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fire = runner.claim("fire_reflex", "leave lava", async () => {
    await held;
    return { value: null, continuation: { kind: "return" as const, reason: null } };
  });
  let navigationReleased = false;
  await using driver = new ReflexDriver(bot, runner);
  const reflex = attachFootingReflex(
    driver,
    { activeEngagement: () => null },
    {
      needed: true,
      async recover() {
        throw new Error("A refused claim must not drive.");
      },
    },
    () => {
      navigationReleased = true;
    },
  );
  try {
    bot.emit("physicsTick");
    assert.equal(navigationReleased, false);
    assert.equal(runner.status().activeAction?.action, "fire_reflex");
  } finally {
    release();
    if (fire.kind === "claimed") await fire.outcome;
    await reflex[Symbol.asyncDispose]();
  }
});

test("a failed physical claim returns its observed settlement reason with the request", async () => {
  const runner = new ActionRunner();
  const task = stubAction(
    async (_request, context) => {
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      context.signal!.throwIfAborted();
      return { status: "succeeded" };
    },
    { kind: "resumable_task" },
  );
  const pending = runner.run(task, { block_name: "stone" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const claim = runner.claim("hostile_reflex", "blaze contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: "Cover route exhausted; health 12.25." },
  }));
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  assert.deepEqual(output.interruptions, ["Cover route exhausted; health 12.25."]);
});

test("a waiting claim keeps its interrupted request pending until defence settles", async () => {
  const runner = new ActionRunner();
  let attempts = 0;
  const task = stubAction(
    async (_request, context) => {
      if (++attempts > 1) return { status: "succeeded" };
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      context.signal!.throwIfAborted();
      return { status: "succeeded" };
    },
    { kind: "resumable_task" },
  );
  let returned = false;
  const pending = runner.run(task, { block_name: "stone" }, undefined, 42);
  void pending.then(() => {
    returned = true;
  });
  while (attempts === 0) await Promise.resolve();
  let complete!: () => void;
  const claim = runner.claim("hostile_reflex", "contact", async () => {
    await new Promise<void>((resolve) => {
      complete = resolve;
    });
    return { value: null, continuation: { kind: "resume" as const } };
  });
  while (!complete) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  assert.equal(runner.status().owner, "takeover");
  assert.equal(runner.requestContext().requestId, 42);
  complete();
  const output = await pending;
  if (claim.kind === "claimed") await claim.outcome;
  assert.equal(output.result.status, "succeeded");
  assert.equal(attempts, 2);
  assert.equal(runner.status().owner, "idle");
});
const stubResultSchema = actionResultSchema({});
type StubResult = z.output<typeof stubResultSchema>;
type StubAction = Action<"stub", { block_name: string }, StubResult>;

/** One stub action so the runner is tested without any physics. */
function stubAction(
  execute: NonNullable<StubAction["execute"]>,
  execution: ActionExecution = { kind: "task" },
  movement: false | "travel" | "work" = false,
): StubAction {
  return defineAction({
    name: "stub",
    ...(movement && { movement }),
    description: "stub",
    inputSchema: stubInputSchema,
    resultSchema: stubResultSchema,
    formatResult: (result) => result.status,
    parse: (input: unknown) => {
      const request = stubInputSchema.parse(input);
      if (!request.block_name) throw new Error("block_name is required.");
      return { block_name: request.block_name };
    },
    ...(execution.kind === "resumable_task"
      ? {
          execution,
          begin: (request: { block_name: string }) => (context: Parameters<typeof execute>[1]) =>
            execute(request, context),
        }
      : { execution, execute }),
  });
}

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

/** A task that yields to any abort by throwing its reason, and counts its runs. */
function preemptible(runs: { count: number }, execution: ActionExecution): StubAction {
  return stubAction(async (_request, context) => {
    runs.count += 1;
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw context.signal?.reason;
  }, execution);
}

/** Let the executor start: the runner prepares a task a microtask after `run` returns. */
async function started(runs: { count: number }, count: number): Promise<void> {
  for (let turn = 0; turn < 50 && runs.count < count; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runs.count, count);
}

async function untilOwner(runner: ActionRunner, owner: string): Promise<void> {
  for (let turn = 0; turn < 50 && runner.status().owner !== owner; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runner.status().owner, owner);
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

test("a preempted task stays cancelled when the reflex withdrew, was hurt, or threw", async () => {
  for (const work of [
    async () => ({ value: "evaded", continuation: { kind: "return" as const, reason: null } }),
    async () => {
      throw new Error("session torn down");
    },
  ]) {
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
  }
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


test("an action without a highlighter skips collection display work", async () => {
  let visited = 0;
  const action = stubAction(async () => {
    assert.equal(getAmbientHighlighterContext()?.enabled, false);
    const position = { get x() { visited++; return 0; }, y: 0, z: 0 };
    await [position].toHighlightableBlocks().highlight("#ffffff");
    return { status: "succeeded" };
  });
  const output = await new ActionRunner().run(action, { block_name: "stone" });
  assert.equal(output.result.status, "succeeded");
  assert.equal(visited, 0);
});

// Run 14: twelve bots left mounted at sea never ticked again; their navigate waited for a tick for ever and ignored its cancel.
test("an action that owns the body with no physics tick fails RUNTIME_PHYSICS_STALLED and releases the body", async () => {
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 40 });
  const action = stubAction(() => new Promise<never>(() => {}));
  const output = await runner.run(action, { block_name: "stone" });
  assert.equal(output.result.status, "failed");
  assert.match("error" in output.result ? output.result.error ?? "" : "", /RUNTIME_PHYSICS_STALLED/);
  assert.equal(runner.status().busy, false);
  // The next action starts at once on the freed body.
  const next = stubAction(async () => ({ status: "succeeded" }));
  assert.equal((await runner.run(next, { block_name: "stone" })).result.status, "succeeded");
});

test("an action that keeps getting physics ticks is not stalled, however long it waits", async () => {
  const runner = new ActionRunner({ physicsStallMs: 80 });
  const ticking = setInterval(() => runner.observePhysicsTick(), 10);
  try {
    const action = stubAction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: "succeeded" };
    });
    assert.equal((await runner.run(action, { block_name: "stone" })).result.status, "succeeded");
  } finally {
    clearInterval(ticking);
  }
});

test("a passenger owes no physics tick, an idle runner is never failed", async () => {
  let riding = true;
  const runner = new ActionRunner({ physicsStallMs: 40, physicsExpected: () => !riding });
  const action = stubAction(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { status: "succeeded" };
  });
  assert.equal((await runner.run(action, { block_name: "stone" })).result.status, "succeeded");
  riding = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(runner.status().busy, false);
});

test("a cancelled action that cannot stop for want of ticks settles as cancelled, and the next action runs", async () => {
  const runner = new ActionRunner({ physicsStallMs: 10_000, cancelGraceMs: 60 });
  let entered!: () => void;
  const running = new Promise<void>((resolve) => { entered = resolve; });
  const action = stubAction(async () => {
    entered();
    return new Promise<never>(() => {});
  });
  const pending = runner.run(action, { block_name: "stone" });
  await running;
  runner.cancelActive("stop");
  const output = await pending;
  assert.equal(output.result.status, "cancelled");
  // The model is told the stop is done, or it repeats it (review V5).
  assert.match("error" in output.result ? output.result.error ?? "" : "", /the next action may start/);
  assert.equal(runner.status().busy, false);
  const next = stubAction(async () => ({ status: "succeeded" }));
  assert.equal((await runner.run(next, { block_name: "stone" })).result.status, "succeeded");
});

// Run 14b (review V2): the stall released the body but left the old navigate running; it held the navigation for good.
test("a stalled action's signal is aborted with the stall reason", async () => {
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 40 });
  let seen: AbortSignal | undefined;
  const action = stubAction((_request, context) => {
    seen = context.signal;
    return new Promise<never>(() => {});
  });
  const output = await runner.run(action, { block_name: "stone" });
  assert.equal(output.result.status, "failed");
  assert.equal(seen?.aborted, true);
  assert.match(seen?.reason instanceof Error ? seen.reason.message : String(seen?.reason), /RUNTIME_PHYSICS_STALLED/);
});

/** Physics ticks the test drives: each one reaches the runner's watch and the stub actions' waits. */
function tickSource(runner: ActionRunner) {
  const ticks = new EventEmitter();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    next: (signal: AbortSignal) => new Promise<void>((resolve) => {
      ticks.once("tick", resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    start: () => {
      timer ??= setInterval(() => { runner.observePhysicsTick(); ticks.emit("tick"); }, 10);
    },
    stop: () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}

// Run 14b: physics stopped after a ride; the old navigate woke when ticks came back and steered beside the new one.
test("ticks resume after a stall: the old action stops before the body is released, and only the new action moves", async () => {
  const moves: string[] = [];
  let stalls = 0;
  let oldStopped = false;
  // The runtime's recovery turns physics back on: here, the ticks start.
  const runner = new ActionRunner({ physicsStallMs: 80, cancelGraceMs: 2_000, onPhysicsStall: () => { stalls += 1; source.start(); } });
  const source = tickSource(runner);
  try {
    // Waits for ticks that do not come; when they come back it moves, unless it was stopped.
    const old = stubAction(async (_request, context) => {
      for (;;) {
        await source.next(new AbortController().signal);
        if (context.signal?.aborted) {
          oldStopped = true;
          return { status: "failed", error: "stopped" };
        }
        moves.push("old");
      }
    });
    const output = await runner.run(old, { block_name: "stone" });
    assert.equal(output.result.status, "failed");
    assert.match("error" in output.result ? output.result.error ?? "" : "", /RUNTIME_PHYSICS_STALLED/);
    assert.equal(stalls, 1);
    assert.equal(oldStopped, true, "the old action settled before the body was released");
    const next = stubAction(async (_request, context) => {
      for (let step = 0; step < 3; step += 1) {
        await source.next(context.signal ?? new AbortController().signal);
        moves.push("new");
      }
      return { status: "succeeded" };
    });
    assert.equal((await runner.run(next, { block_name: "stone" })).result.status, "succeeded");
    assert.deepEqual(moves, ["new", "new", "new"]);
  } finally {
    source.stop();
  }
});

// Review V3: WSL resyncs its wall clock after the host wakes; the watch must not read that step as 60 s without a tick.
test("a 60 s wall clock step fails nothing while ticks come", async () => {
  const runner = new ActionRunner({ physicsStallMs: 200 });
  const realNow = Date.now;
  let paused = false;
  const ticking = setInterval(() => { if (!paused) runner.observePhysicsTick(); }, 10);
  try {
    const action = stubAction(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const stepped = realNow() + 60_000;
      const startedReal = realNow();
      Date.now = () => stepped + (realNow() - startedReal);
      // A gap between ticks shorter than the limit but longer than a check: a wall clock watch fails here.
      paused = true;
      await new Promise((resolve) => setTimeout(resolve, 120));
      paused = false;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: "succeeded" };
    });
    assert.equal((await runner.run(action, { block_name: "stone" })).result.status, "succeeded");
  } finally {
    Date.now = realNow;
    clearInterval(ticking);
  }
});

// ── Pinned watch (run 15: bots pinned for hours) ─────────────────────────────

const PINNED_MINUTES = 10 * 60_000;

/** A pinned bot's runner: a hand-stepped clock, a body the test moves, and an escape that records what it did. */
function pinnedRunner() {
  let now = 0;
  const clock: StallClock = { now: () => now, every: () => () => {} };
  const body = { x: 0, z: 0 };
  const position = () => ({ dimension: "overworld", x: body.x, y: 64, z: body.z });
  const watch = new PinnedWatch({ position, clock });
  const log: string[] = [];
  let routesAsEscape = false;
  const escape: PinnedEscape = {
    leave: async () => { log.push("leave"); },
    routesAsEscape: () => {
      routesAsEscape = true;
      return { [Symbol.dispose]: () => { routesAsEscape = false; } };
    },
  };
  const routes = new RouteOutcomes();
  const runner = new ActionRunner({ position, clock, pinned: watch, pinnedEscape: escape, routes });
  const failing = stubAction(async () => {
    routes.note({ status: "stopped", reason: "no path found", elapsedMs: 5, calculationFailed: true, routeFailed: true });
    return { status: "failed", error: "dead end: dig into water 4" };
  }, { kind: "task" }, "travel");
  const pin = async () => {
    for (let n = 0; n < 3; n++) await runner.run(failing, { block_name: "stone" });
    now += PINNED_MINUTES;
  };
  return { runner, watch, body, log, failing, pin, routes, escaping: () => routesAsEscape, advance: (ms: number) => { now += ms; } };
}

/** A movement action that failed without its route failing: nothing usable near, a tool lost, a full inventory. */
const failingWithoutRoute = (movement: "travel" | "work") =>
  stubAction(async () => ({ status: "failed", error: "none usable near" }), { kind: "task" }, movement);

test("a pinned bot's next movement action leaves the water or boat first and runs its routes as an escape", async () => {
  const { runner, log, pin, escaping } = pinnedRunner();
  await pin();
  let escapingDuringRun = false;
  const movement = stubAction(async () => {
    escapingDuringRun = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(log, ["leave"]);
  assert.equal(escapingDuringRun, true);
  assert.equal(escaping(), false, "the escape ends with the action");
});

test("the escape's relaxed routing lasts until a pinned movement action settles, not until it first awaits", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let escapingAfterAwait: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingAfterAwait = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(escapingAfterAwait, true, "the hold was still open when the action's route ran");
  assert.equal(escaping(), false, "and it is released with the result");
});

test("a pinned movement action that fails after its first await still releases the escape hold", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let escapingAfterAwait: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingAfterAwait = escaping();
    throw new Error("route exploded");
  }, { kind: "task" }, "travel");
  const result = (await runner.run(movement, { block_name: "stone" })).result;
  assert.equal(result.status, "failed");
  assert.equal(escapingAfterAwait, true);
  assert.equal(escaping(), false, "a failed escape does not leave the next route relaxed");
});

test("a pinned movement action cancelled mid-run releases the escape hold when it settles", async () => {
  const { runner, pin, escaping } = pinnedRunner();
  await pin();
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const movement = stubAction(async (_request, context) => {
    started();
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "cancelled", error: "stopped" };
  }, { kind: "task" }, "travel");
  const request = runner.run(movement, { block_name: "stone" });
  await running;
  assert.equal(escaping(), true, "the hold is open while the action runs");
  runner.cancelActive("operator stop");
  await request;
  assert.equal(escaping(), false);
});

test("a movement action of a bot that is not pinned never takes the escape hold", async () => {
  const { runner, escaping, log } = pinnedRunner();
  let escapingDuringRun: boolean | undefined;
  const movement = stubAction(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    escapingDuringRun = escaping();
    return { status: "succeeded" };
  }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(escapingDuringRun, false);
  assert.deepEqual(log, []);
});

test("a bot that failed twice and sat ten minutes runs its next movement action without an escape", async () => {
  const { runner, log, failing, body } = pinnedRunner();
  await runner.run(failing, { block_name: "stone" });
  await runner.run(failing, { block_name: "stone" });
  body.x = 0.2;
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  await runner.run(movement, { block_name: "stone" });
  assert.equal(ran, true);
  assert.deepEqual(log, []);
});

test("an escape that leaves the bot in place makes movement actions fail at once with [PINNED], other actions still run", async () => {
  const { runner, pin, failing } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  let ran = 0;
  const movement = stubAction(async () => { ran++; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  const refused = (await runner.run(movement, { block_name: "stone" })).result;
  assert.equal(refused.status, "failed");
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\].*dig into water 4/u);
  assert.equal(ran, 0, "a refused movement action never reached the body");
  const other = stubAction(async () => { ran++; return { status: "succeeded" }; });
  assert.equal((await runner.run(other, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, 1);
});

test("after [PINNED], a move of 2 blocks by any action lets the next movement action run normally", async () => {
  const { runner, pin, failing, body, log } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  body.x = 2;
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, true);
  assert.deepEqual(log, ["leave"], "only the one escape ran; the freed bot needs no second");
});

test("a failing action that is not a movement action does not count toward pinned", async () => {
  const { runner, watch, body } = pinnedRunner();
  const notMovement = stubAction(async () => ({ status: "failed", error: "nope" }));
  for (let n = 0; n < 3; n++) await runner.run(notMovement, { block_name: "stone" });
  assert.equal(watch.isPinned(), false);
  body.x = 0;
});

test("ten minutes in one place and three movement failures that were not the route's leave the bot not pinned", async () => {
  const { runner, watch, log, advance } = pinnedRunner();
  for (const movement of ["travel", "work", "work"] as const) await runner.run(failingWithoutRoute(movement), { block_name: "stone" });
  advance(PINNED_MINUTES);
  assert.equal(watch.isPinned(), false);
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  await runner.run(movement, { block_name: "stone" });
  assert.deepEqual(log, [], "no escape ran: the bot was never pinned");
});

test("ten minutes in one place and three failed routes pin the bot", async () => {
  const { watch, pin } = pinnedRunner();
  await pin();
  assert.equal(watch.isPinned(), true);
});

test("a failure after a failed route that a later route made up for is not the route's", async () => {
  const { runner, watch, routes, advance } = pinnedRunner();
  const madeUp = stubAction(async () => {
    routes.note({ status: "stopped", reason: "no path found", elapsedMs: 5, routeFailed: true });
    routes.note({ status: "completed", elapsedMs: 5 });
    return { status: "failed", error: "[INVENTORY_FULL] all slots are occupied" };
  }, { kind: "task" }, "work");
  for (let n = 0; n < 3; n++) await runner.run(madeUp, { block_name: "stone" });
  advance(PINNED_MINUTES);
  assert.equal(watch.isPinned(), false);
});

test("a failed escape that was not the route's does not shut movement out", async () => {
  const { runner, pin } = pinnedRunner();
  await pin();
  await runner.run(failingWithoutRoute("travel"), { block_name: "stone" });
  let ran = false;
  const movement = stubAction(async () => { ran = true; return { status: "succeeded" }; }, { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal(ran, true, "an unsupported target is not an escape that left the bot in place");
});

test("after an escape failed, a work movement action (collecting what is within reach) still runs, as an escape", async () => {
  const { runner, pin, failing, log, escaping } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  const refused = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\]/u, "travel is shut out");
  assert.deepEqual(log, ["leave"]);
  let escapingDuringRun = false;
  const collect = stubAction(async () => { escapingDuringRun = escaping(); return { status: "succeeded" }; }, { kind: "task" }, "work");
  assert.equal((await runner.run(collect, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(log, ["leave", "leave"], "the collect left the water first, like the first escape");
  assert.equal(escapingDuringRun, true, "and its routes started as escapes");
});

test("two runners in one process escape and refuse independently", async () => {
  const first = pinnedRunner();
  const second = pinnedRunner();
  await first.pin();
  await first.runner.run(first.failing, { block_name: "stone" });
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  assert.equal((await second.runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.deepEqual(second.log, []);
  assert.equal((await first.runner.run(movement, { block_name: "stone" })).result.status, "failed");
});

test("a refused pinned bot runs the escape again after another window, and is refused again when it fails", async () => {
  const { runner, pin, failing, log, advance } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  assert.deepEqual(log, ["leave"]);
  const refused = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in refused ? refused.error : "", /^\[PINNED\]/u);
  assert.deepEqual(log, ["leave"], "refused without an escape inside the window");
  advance(PINNED_MINUTES);
  await runner.run(failing, { block_name: "stone" });
  assert.deepEqual(log, ["leave", "leave"], "the retry ran the escape");
  const again = (await runner.run(failing, { block_name: "stone" })).result;
  assert.match("error" in again ? again.error : "", /^\[PINNED\]/u, "refusal resumes");
});

test("a retry escape that succeeds frees the next movement action", async () => {
  const { runner, pin, failing, advance } = pinnedRunner();
  await pin();
  await runner.run(failing, { block_name: "stone" });
  advance(PINNED_MINUTES);
  const movement = stubAction(async () => ({ status: "succeeded" }), { kind: "task" }, "travel");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
  assert.equal((await runner.run(movement, { block_name: "stone" })).result.status, "succeeded");
});
