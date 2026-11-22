// A later spawn must not erase the wave state at action settlement.
import assert from "node:assert/strict";
import test from "node:test";
import { runExpeditionAction } from "./expedition-action.ts";

test("a hunt failure retains the pending wave at settlement while incident capture waits", async () => {
  let pending = true;
  const captured = Promise.withResolvers<void>();
  const capturing = Promise.withResolvers<void>();
  const result = runExpeditionAction({
    name: "collect_mob_drop",
    run: async () => ({ result: { status: "failed", message: "HUNT_TARGET_NOT_LOADED" } }),
    isWavePending: () => pending,
    capture: async () => { capturing.resolve(); await captured.promise; },
    record: () => {},
  });
  await capturing.promise;
  pending = false;
  captured.resolve();
  assert.equal((await result).settledWithWavePending, true);
});

test("other outcomes and completed waves do not report the pending-wave hunt race", async () => {
  for (const [name, pending, message] of [
    ["collect_mob_drop", false, "HUNT_TARGET_NOT_LOADED"],
    ["navigate", true, "HUNT_TARGET_NOT_LOADED"],
    ["collect_mob_drop", true, "another failure"],
  ] as const) {
    const result = await runExpeditionAction({ name, run: async () => ({ message }), isWavePending: () => pending,
      capture: async () => {}, record: () => {} });
    assert.equal(result.settledWithWavePending, false);
  }
});
