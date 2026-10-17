import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "./body.ts";
import { FakeRuntime } from "./testing.ts";

/** A runtime whose action is still `pending` however often it is cancelled (the live 2026-10-11 Vex collect_block). */
class StuckRuntime extends FakeRuntime {
  readonly cancels: string[] = [];

  override async cancel(actionId: string): Promise<void> {
    this.cancels.push(actionId);
  }

  override async submit(): Promise<never> {
    return { state: "pending", actionId: "stuck" } as never;
  }

  override async wait(): Promise<never> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { state: "pending", actionId: "stuck" } as never;
  }
}

// Live 2026-10-11 (orders test, Vex): collect_block was `stopping` after the cancel at 10:48:15 and never settled; the
// brain waited 378 one-second slices until the runtime closed at 10:51:22. Body.run cancels once and then waits with no
// deadline, so neither a new order nor "stop" nor the no-gain watcher could end the step.
test("an action that stays pending after its cancel does not hold the step for ever", async () => {
  const runtime = new StuckRuntime();
  const body = new Body(runtime, () => undefined, undefined, { recancelMs: 40, giveUpMs: 200 });
  const controller = new AbortController();
  const act = body.act("collect_block", { block_name: "stone", count: 10 }, "test", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([act, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
  assert.notEqual(outcome, "hung");
  assert.equal((outcome as { status: string }).status, "failed");
  assert.match((outcome as { error: string }).error, /did not stop/);
  assert.ok(runtime.cancels.length >= 3, `cancel sent again while it stayed pending: ${runtime.cancels.length}`);
});

class BusyRuntime extends StuckRuntime {
  override async submit(): Promise<never> {
    return { state: "refused", code: "ACTION_BUSY", error: "an action is running", activeActionId: "stuck", unretrievedActionId: null } as never;
  }
}

test("a new action meeting a blocker that will not stop is refused, not waited for for ever", async () => {
  const runtime = new BusyRuntime();
  const body = new Body(runtime, () => undefined, undefined, { recancelMs: 40, giveUpMs: 200 });
  const outcome = await Promise.race([
    body.act("collect_block", { block_name: "stone", count: 10 }, "test"),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
  ]);
  assert.notEqual(outcome, "hung");
  assert.equal((outcome as { status: string }).status, "refused");
  assert.ok(runtime.cancels.length >= 2);
});

/** A runtime whose wait never answers at all (a stopped clock on its side). */
class SilentRuntime extends StuckRuntime {
  override async wait(): Promise<never> {
    return new Promise<never>(() => undefined);
  }
}

test("a wait that never answers does not hold the step: the abort still cancels it and the give-up still ends it", async () => {
  const runtime = new SilentRuntime();
  const body = new Body(runtime, () => undefined, undefined, { recancelMs: 40, giveUpMs: 200 });
  const controller = new AbortController();
  const act = body.act("collect_block", { block_name: "stone", count: 10 }, "test", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([act, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3_000))]);
  assert.notEqual(outcome, "hung");
  assert.equal((outcome as { status: string }).status, "failed");
  assert.ok(runtime.cancels.length >= 1, "the cancel went out");
});
