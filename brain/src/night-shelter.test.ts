import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "./body.ts";
import { coverOver, isInHole, roofBlock, shelterBox, shelterForNight, shelterSpot, type ShelterContext, type ShelterTimings } from "./night-shelter.ts";
import { areaKey, type BlockArea, type ProtectedArea } from "./runtime-client.ts";
import { FakeRuntime } from "./testing.ts";

const KINDS = {
  air: { tool: null, solid: false, harvest: null },
  short_grass: { tool: null, solid: false, harvest: null },
  water: { tool: null, solid: false, harvest: null },
  grass_block: { tool: "shovel" as const, solid: true, harvest: null },
  dirt: { tool: "shovel" as const, solid: true, harvest: null },
  stone: { tool: "pickaxe" as const, solid: true, harvest: ["wooden_pickaxe"] },
  bedrock: { tool: null, solid: true, harvest: null },
};

/** Flat ground: grass at y 63, dirt to 60, stone under; air above. `change` edits single cells. */
function ground(change: Record<string, string> = {}): BlockArea {
  const blocks = new Map<string, string>();
  const box = shelterBox({ x: 0, y: 64, z: 0 });
  for (let x = box.min.x - 4; x <= box.max.x + 4; x += 1) {
    for (let y = box.min.y; y <= box.max.y; y += 1) {
      for (let z = box.min.z - 4; z <= box.max.z + 4; z += 1) {
        blocks.set(areaKey(x, y, z), y > 63 ? "air" : y === 63 ? "grass_block" : y >= 60 ? "dirt" : "stone");
      }
    }
  }
  for (const [key, name] of Object.entries(change)) blocks.set(key, name);
  return { blocks, kinds: KINDS };
}

test("on flat ground the hole is dug where she stands, roofed against the ground beside it", () => {
  assert.deepEqual(shelterSpot(ground(), { x: 0.5, y: 64, z: 0.5 }, []), { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west" });
});

test("a cave under her, an opening beside the hole, bedrock or a protected area move the hole aside", () => {
  // A cave cell right under the hole's floor: the hole would open into it.
  const cave = shelterSpot(ground({ [areaKey(0, 60, 0)]: "air" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.ok(cave !== null);
  assert.notDeepEqual([cave.x, cave.z], [0, 0]);
  // Water beside where she would stand in the hole.
  const wet = shelterSpot(ground({ [areaKey(1, 61, 0)]: "water" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.notDeepEqual([wet?.x, wet?.z], [0, 0]);
  const hard = shelterSpot(ground({ [areaKey(0, 62, 0)]: "bedrock" }), { x: 0.5, y: 64, z: 0.5 }, []);
  assert.notDeepEqual([hard?.x, hard?.z], [0, 0]);
  const house: ProtectedArea = { regionId: 1, label: "house", owner: "Ayla", min: { x: -1, y: 60, z: -1 }, max: { x: 1, y: 70, z: 1 } };
  const spot = shelterSpot(ground(), { x: 0.5, y: 64, z: 0.5 }, [house]);
  assert.ok(spot !== null && (Math.abs(spot.x) > 1 || Math.abs(spot.z) > 1));
});

test("no hole anywhere near on open water", () => {
  const sea: Record<string, string> = {};
  const box = shelterBox({ x: 0, y: 64, z: 0 });
  for (let x = box.min.x; x <= box.max.x; x += 1) for (let z = box.min.z; z <= box.max.z; z += 1) for (let y = 58; y <= 63; y += 1) sea[areaKey(x, y, z)] = "water";
  assert.equal(shelterSpot(ground(sea), { x: 0.5, y: 64, z: 0.5 }, []), null);
});

test("rock or a roof over her head is cover, open sky or leaves are not", () => {
  const at = { x: 0.5, y: 64, z: 0.5 };
  const kinds = { ...KINDS, oak_leaves: { tool: null, solid: true, harvest: null } };
  const column = (names: Record<number, string>): ReturnType<typeof ground> => ({ blocks: new Map(Object.entries(names).map(([y, name]) => [areaKey(0, Number(y), 0), name])), kinds });
  assert.equal(coverOver(column({ 66: "air", 70: "air" }), at), false);
  assert.equal(coverOver(column({ 66: "air", 72: "oak_leaves" }), at), false);
  assert.equal(coverOver(column({ 66: "air", 80: "stone" }), at), true);
  // Higher than 24 blocks over her head: open sky as far as the night goes.
  assert.equal(coverOver(column({ 95: "stone" }), at), false);
});

test("the roof is a common carried block, else planks or a log, never sand", () => {
  assert.equal(roofBlock([{ name: "sand" }, { name: "oak_planks" }, { name: "cobblestone" }]), "cobblestone");
  assert.equal(roofBlock([{ name: "sand" }, { name: "spruce_log" }]), "spruce_log");
  assert.equal(roofBlock([{ name: "sand" }, { name: "gravel" }]), null);
});

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

test("isInHole: the column and the depth, not a neighbour column, not the surface", () => {
  const spot = { x: 0, y: 64, z: 0, support: { x: 1, y: 63, z: 0 }, face: "west" as const };
  assert.equal(isInHole({ x: 0.5, y: 61, z: 0.5 }, spot), true);
  assert.equal(isInHole({ x: 0.5, y: 63, z: 0.5 }, spot), true);
  assert.equal(isInHole({ x: 1.5, y: 61, z: 0.5 }, spot), false);
  assert.equal(isInHole({ x: 0.5, y: 64, z: 0.5 }, spot), false);
  assert.equal(isInHole({ x: 0.5, y: 70, z: 0.5 }, spot), false);
});
