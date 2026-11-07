import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "./body.ts";
import { shelterForNight, type ShelterContext, type ShelterTimings } from "./night-shelter.ts";
import { FakeRuntime } from "./testing.ts";

/** Quick clocks for a night in the fake: the landing and the wait slices last milliseconds. */
const FAST = { landingMs: 60, landingPollMs: 5, waitSliceMs: 5 };
const SURFACE = { x: 0, y: 64, z: 0 };

/**
 * A fake bot on flat dirt at {@link SURFACE}. A dig moves its feet down into the dug cell (the game: the bot falls when
 * the block under it goes; scenario `shelter/dig-in-and-climb-out` shows it), a navigate puts it on its target.
 */
function rig(options: { readonly inventory?: readonly { name: string; count: number }[]; readonly timings?: Partial<ShelterTimings>; readonly dayCame?: () => Promise<boolean> } = {}) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: SURFACE, inventory: [...(options.inventory ?? [{ name: "dirt", count: 4 }])] };
  const controller = new AbortController();
  const night = { over: false };
  const moveTo = (x: number, y: number, z: number) => { runtime.snapshot = { ...runtime.snapshot, position: { x, y, z } }; };
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") moveTo(0, Math.min(runtime.snapshot.position.y, Number(input.y)), 0);
  };
  runtime.succeedEffects.navigate = (input) => moveTo(Number(input.x), Number(input.y), Number(input.z));
  const context: ShelterContext = {
    runtime,
    body: new Body(runtime, () => undefined, INSTANT_TYPING),
    signal: controller.signal,
    areas: [],
    dayCame: options.dayCame ?? (async () => night.over),
    timings: { ...FAST, ...options.timings },
  };
  /** The day comes `ms` after the call. */
  const dayIn = (ms: number) => { setTimeout(() => { night.over = true; }, ms); };
  const calls = (operation: string) => runtime.submitted.filter((call) => call.tool === "raw_action" && call.input.operation === operation).map((call) => call.input);
  return { runtime, context, controller, moveTo, dayIn, calls };
}

test("a night in the hole: three digs, the roof placed against its support, the day, the roof dug, the climb out: done", async () => {
  const { runtime, context, dayIn, calls } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "place") dayIn(20); };
  const result = await shelterForNight(context);
  assert.equal(result.status, "done");
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62, 61, 63]);
  assert.deepEqual(calls("place"), [{ operation: "place", block_name: "dirt", x: 1, y: 63, z: 0, face: "west" }]);
  assert.deepEqual(runtime.submitted.at(-1), { tool: "navigate", input: { x: 0, y: 64, z: 0, range: 1 } });
  assert.match(result.status === "done" ? result.detail : "", /roofed with dirt at 0 61 0.*climbed out/u);
  assert.equal(runtime.snapshot.position.y, 64);
});

/** A night whose roof dig and climb out both fail (the roof placed, then the day comes). */
function failedClimb() {
  const made = rig();
  const { runtime, dayIn } = made;
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation !== "place") return;
    dayIn(20);
    runtime.failNext.raw_action = { error: "[OUT_OF_REACH] the roof is too far" };
    runtime.failNext.navigate = { error: "[NO_PATH] no route out of the hole" };
  };
  return made;
}

test("a failed climb out is failed with the hole's floor and the roof still on when its dig failed (SKL-01)", async () => {
  const { context } = failedClimb();
  const result = await shelterForNight(context);
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /still in my hole: feet at 0 61 0; its roof is still on: \[NO_PATH\]/u);
  assert.match(detail, /go_to a spot on the surface nearby \(0 64 0\)/u);
});

test("after a failed climb out the next step runs from the hole: a go_to from the floor position is submitted and settles", async () => {
  const { runtime, context } = failedClimb();
  const result = await shelterForNight(context);
  assert.equal(runtime.snapshot.position.y, 61);
  const [, x, y, z] = /nearby \((-?\d+) (-?\d+) (-?\d+)\)/u.exec(result.status === "failed" ? result.detail : "") ?? [];
  assert.ok(x !== undefined);
  const next = await context.body.act("navigate", { x: Number(x), y: Number(y), z: Number(z), range: 1 }, "the order after the shelter");
  assert.equal(next.status, "succeeded");
  assert.equal(runtime.snapshot.position.y, 64);
});

test("the day coming after the second dig stops the digging and climbs out from depth 2, no roof placed", async () => {
  const answers = [false, false];
  const { runtime, context, calls } = rig({ dayCame: async () => answers.shift() ?? true });
  const result = await shelterForNight(context);
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62]);
  assert.deepEqual(calls("place"), []);
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /at 0 62 0/u);
  assert.equal(runtime.snapshot.position.y, 64);
});

test("day already when the bot reaches the spot: nothing dug, done", async () => {
  const { runtime, context } = rig({ dayCame: async () => true });
  const result = await shelterForNight(context);
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted, []);
});

test("a bot that is no longer in the hole at night (a death, a reflex) ends failed at once, no roof dug, no walk back", async () => {
  const { runtime, context, moveTo, calls } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "place") moveTo(50, 70, 50); };
  const result = await shelterForNight(context);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /no longer in my hole \(now at 50 70 50: a death, a reflex or a push\)/u);
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62, 61]);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 0);
});

test("a bot not yet landed after LANDING_MS places no roof and still waits out the night in the open hole", async () => {
  const { runtime, context, moveTo, dayIn, calls } = rig();
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation !== "dig") return;
    // The third dig's fall is not seen by the client (a lagging server): the feet stay one cell up.
    moveTo(0, Number(input.y) === 61 ? 62 : Number(input.y), 0);
    if (Number(input.y) === 61) dayIn(150);
  };
  const result = await shelterForNight(context);
  assert.deepEqual(calls("place"), []);
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /in an open hole \(the roof was not placed\)/u);
});

test("a roof the server refuses leaves the hole open and says so", async () => {
  const { runtime, context, dayIn } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation === "dig" && Number(input.y) === 61) { runtime.failNext.raw_action = { error: "[PLACE_FAILED] no face" }; dayIn(20); }
  };
  const result = await shelterForNight(context);
  assert.equal(result.status, "done");
  assert.match(result.status === "done" ? result.detail : "", /open hole \(the roof was not placed\)/u);
});

test("a dig that fails below the first says the bot is in a hole and where the surface is", async () => {
  const { runtime, context } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (Number(input.y) === 63) runtime.failNext.raw_action = { error: "[DIG_FAILED] a tool is needed" };
  };
  const result = await shelterForNight(context);
  assert.equal(result.status, "failed");
  const detail = result.status === "failed" ? result.detail : "";
  assert.match(detail, /could not dig the hole at 0 62 0: \[DIG_FAILED\]/u);
  assert.match(detail, /in a hole 1 deep.*go_to a spot on the surface nearby \(0 64 0\)/u);
});

test("a stop while waiting returns stopped and leaves no timer", async () => {
  const { runtime, context, controller } = rig({ timings: { waitSliceMs: 60_000 } });
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "place") setTimeout(() => controller.abort(), 20); };
  const started = performance.now();
  const result = await shelterForNight(context);
  assert.equal(result.status, "stopped");
  assert.ok(performance.now() - started < 2_000, "the abort ended the 60 s wait slice at once");
});

test("a stop while waiting for the landing returns stopped at once", async () => {
  const { runtime, context, controller } = rig({ timings: { landingMs: 60_000, landingPollMs: 60_000 } });
  runtime.succeedEffects.raw_action = () => { setTimeout(() => controller.abort(), 20); };
  const started = performance.now();
  const result = await shelterForNight(context);
  assert.equal(result.status, "stopped");
  assert.ok(performance.now() - started < 2_000);
});

test("a stop during the climb out is stopped, not a failed climb", async () => {
  const { runtime, context, controller, dayIn } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation !== "place") return;
    dayIn(20);
    runtime.failNext.navigate = { error: "cancelled by caller", effect: () => controller.abort() };
  };
  const result = await shelterForNight(context);
  assert.equal(result.status, "stopped");
});
