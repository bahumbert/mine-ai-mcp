import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../test-support/navigation.js";
import { LANDING_WALL_MS, awaitLanding } from "./landing-wait.js";

type Stabilize = (signal: AbortSignal) => Promise<{ kind: "stable" } | { kind: "failed"; observation: string }>;

/** A bot whose stabilize ends as the test says; a hung one settles only on its signal, as one with no physics tick does. */
function landingBot(stabilize: Stabilize) {
  return { stabilize, observe: () => ({ ...observation(2, 70), stance: "airborne" as const }) };
}

const hangUntilAborted: Stabilize = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

test("a landing seen within the bound is stable", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await awaitLanding(
    landingBot(async () => ({ kind: "stable" })),
    new AbortController().signal,
  );
  assert.deepEqual(result, { kind: "stable" });
});

test("no tick for the bound reads as unstable with the position", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const landing = awaitLanding(landingBot(hangUntilAborted), new AbortController().signal);
  context.mock.timers.tick(LANDING_WALL_MS);
  const result = await landing;
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.observation : "", /No physics tick for 2 s while airborne at 2\.50, 70\.00, 0\.50/);
});

test("the run's abort reads as stopped", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const run = new AbortController();
  const landing = awaitLanding(landingBot(hangUntilAborted), run.signal);
  run.abort(new Error("cancelled"));
  assert.deepEqual(await landing, { kind: "stopped" });
});

test("a null signal is bounded by the wall clock only", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const landing = awaitLanding(landingBot(hangUntilAborted), null);
  context.mock.timers.tick(LANDING_WALL_MS);
  assert.equal((await landing).kind, "failed");
});

test("the wall timer is gone after a landing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  await awaitLanding(landingBot(async () => ({ kind: "stable" })), null);
  assert.equal(clear.mock.callCount(), 1);
});
