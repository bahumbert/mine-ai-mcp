// ActionRunner: a task preempted by a reflex, the handoff, disconnect and reflex priority.
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { defineAction, actionResultSchema, type ActionExecution } from "../actions/index.js";
import { ActionRunner } from "./action-runner.js";
import { stubAction, stubResultSchema, stubInputSchema, StubAction, started, untilOwner } from "./action-runner-fixtures.test.js";

/** A task that yields to any abort by throwing its reason, and counts its runs. */
function preemptible(runs: { count: number }, execution: ActionExecution): StubAction {
  return stubAction(async (_request, context) => {
    runs.count += 1;
    await new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw context.signal?.reason;
  }, execution);
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
