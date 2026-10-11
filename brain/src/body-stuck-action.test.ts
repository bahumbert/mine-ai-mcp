import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "./body.ts";
import { FakeRuntime } from "./testing.ts";

/** A runtime whose action is still `pending` however often it is cancelled (the live 2026-10-11 Vex collect_block). */
class StuckRuntime extends FakeRuntime {
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
test("an action that stays pending after its cancel does not hold the step for ever", { skip: "reproduction of an open bug (B1): Body.run has no deadline after the cancel" }, async () => {
  const body = new Body(new StuckRuntime(), () => undefined);
  const controller = new AbortController();
  const act = body.act("collect_block", { block_name: "stone", count: 10 }, "test", { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  const outcome = await Promise.race([act, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
  assert.notEqual(outcome, "hung");
});
