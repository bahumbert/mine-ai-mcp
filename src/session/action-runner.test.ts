import assert from "node:assert/strict";
import test from "node:test";
import { ReflexDriver } from "../survival/control/driver.js";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { watch } from "../test-support/pending.js";
import { attachFootingReflex } from "../survival/reflexes/footing.js";
import { ActionRunner } from "./action-runner.js";
import { stubAction } from "./action-runner-fixtures.test.js";

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

test("an admitted footing claim releases navigation before its recovery takes the airborne body", async () => {
  const runner = new ActionRunner();
  const { bot } = createFakeBot();
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
  const { bot } = createFakeBot();
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
  const { bot } = createFakeBot();
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
  const pending = runner.run(task, { block_name: "stone" }, undefined, 42);
  const returned = watch(pending);
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
  assert.equal(returned.over, false);
  assert.equal(runner.status().owner, "takeover");
  assert.equal(runner.requestContext().requestId, 42);
  complete();
  const output = await pending;
  if (claim.kind === "claimed") await claim.outcome;
  assert.equal(output.result.status, "succeeded");
  assert.equal(attempts, 2);
  assert.equal(runner.status().owner, "idle");
});
