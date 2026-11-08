import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import type { CarriedStack, ProtectedArea } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { digShelterFlow, type ShelterContext, type ShelterHole, type ShelterTimings } from "./dig-in.ts";

/** Quick clocks for a night in the fake: the landing and the wait slices last milliseconds. */
const FAST = { landingMs: 60, landingPollMs: 5, waitSliceMs: 5 };
/** The middle of cell 0 64 0: the bot stands over its hole, so no flow test steps in unless it asks for it. */
const SURFACE = { x: 0.5, y: 64, z: 0.5 };
/** Where the bot starts when its box rests on the neighbour cell: its centre is over the hole, 0.35 off the cell's middle. */
const OFF_CENTRE = { x: 0.85, y: 64, z: 0.5 };

interface RigOptions {
  readonly inventory?: readonly CarriedStack[];
  readonly timings?: Partial<ShelterTimings>;
  readonly dayCame?: () => Promise<boolean>;
  readonly start?: { readonly x: number; readonly y: number; readonly z: number };
  /** The bot's box rests on the neighbour: a dig moves its feet down only after a `control` `forward` (scenario `shelter/off-centre-stays-up`). */
  readonly offCentre?: boolean;
  /** The fall is never seen after a dig (a lagging server or client), even after the step-in. */
  readonly neverLands?: boolean;
  readonly needed?: ReadonlySet<string>;
}

/**
 * A fake bot on flat dirt. A dig moves its feet down into the dug cell, to the middle of the cell (the game: the bot
 * falls when the block under it goes; scenario `shelter/dig-in-and-climb-out` shows it), a navigate puts it on the
 * middle of its target. With `offCentre` the fall waits for a `control` `forward` (scenario
 * `shelter/off-centre-stays-up`, 6 of 6 on 2026-11-08: a bot at x 0.85 stays up after the dig; `off-centre-drop-in`,
 * 6 of 6: two forward ticks drop it in), which also brings the bot to the middle of the cell.
 */
function rig(options: RigOptions = {}) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: options.start ?? (options.offCentre === true ? OFF_CENTRE : SURFACE), inventory: [...(options.inventory ?? [{ name: "dirt", count: 4 }])] };
  const controller = new AbortController();
  const night = { over: false };
  const moveTo = (x: number, y: number, z: number) => { runtime.snapshot = { ...runtime.snapshot, position: { x, y, z } }; };
  let pendingFall: { readonly x: number; readonly y: number; readonly z: number } | null = null;
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation === "dig") {
      const [x, y, z] = [Number(input.x), Number(input.y), Number(input.z)];
      runtime.world.set(`${x},${y},${z}`, "air");
      const here = runtime.snapshot.position;
      // The player box is 0.3 each side, so it fits a 1-wide hole when its centre is within 0.2 of the middle; only the
      // offset 0.35 (no fall) is measured, by the scenarios. The fake also puts the feet at the cell's middle: the game keeps the bot's x and z.
      const falls = options.offCentre !== true || Math.abs(here.x - (x + 0.5)) <= 0.2;
      if (options.neverLands === true) return;
      if (!falls) pendingFall = { x, y, z };
      else if (y < here.y) moveTo(x + 0.5, y, z + 0.5);
    }
    if (input.operation === "control" && input.state === "forward" && pendingFall !== null && options.neverLands !== true) {
      moveTo(pendingFall.x + 0.5, pendingFall.y, pendingFall.z + 0.5);
      pendingFall = null;
    }
  };
  runtime.succeedEffects.navigate = (input) => moveTo(Number(input.x) + 0.5, Number(input.y), Number(input.z) + 0.5);
  const context: ShelterContext = {
    runtime,
    body: new Body(runtime, () => undefined, INSTANT_TYPING),
    signal: controller.signal,
    areas: [],
    dayCame: options.dayCame ?? (async () => night.over),
    ...(options.needed !== undefined && { needed: options.needed }),
    timings: { ...FAST, ...options.timings },
  };
  /** The day comes `ms` after the call. */
  const dayIn = (ms: number) => { setTimeout(() => { night.over = true; }, ms); };
  const calls = (operation: string) => runtime.submitted.filter((call) => call.tool === "raw_action" && call.input.operation === operation).map((call) => call.input);
  const walks = () => runtime.submitted.filter((call) => call.tool === "navigate").map((call) => call.input);
  /** Runs `then` when the roof is placed. */
  const onPlace = (then: () => void) => {
    const before = runtime.succeedEffects.raw_action!;
    runtime.succeedEffects.raw_action = (input) => { before(input); if (input.operation === "place") then(); };
  };
  return { runtime, context, controller, moveTo, dayIn, calls, walks, onPlace };
}

const detailOf = (result: { readonly status: string; readonly detail?: string }) => result.detail ?? "";

test("a night in the hole: three digs, the roof placed against its support, the day, the roof dug, the climb out: done", async () => {
  const { runtime, context, dayIn, calls, onPlace } = rig();
  const order: string[] = [];
  let hole: ShelterHole | null = null;
  onPlace(() => { order.push("place"); dayIn(20); });
  const result = await digShelterFlow({ ...context, onHole: (made) => { order.push("onHole"); hole = made; } });
  assert.equal(result.status, "done");
  assert.deepEqual(order, ["place", "onHole"], "onHole after the roof step, never before it");
  assert.deepEqual(hole, { x: 0, y: 64, z: 0, depth: 3, roofed: true });
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62, 61, 63]);
  assert.deepEqual(calls("place"), [{ operation: "place", block_name: "dirt", x: 1, y: 63, z: 0, face: "west" }]);
  assert.deepEqual(runtime.submitted.at(-1), { tool: "navigate", input: { x: 0, y: 64, z: 0, range: 1 } });
  assert.match(detailOf(result), /roofed with dirt at 0 61 0.*climbed out/u);
  assert.equal(runtime.snapshot.position.y, 64);
  assert.equal(calls("control").length, 0, "a bot over its hole never steps in");
});

test("off-centre: dig 63, look at the hole, control forward 2 ticks, lands, digs on, roofs, done", async () => {
  const { runtime, context, dayIn, calls, onPlace } = rig({ offCentre: true });
  onPlace(() => dayIn(20));
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  const raw = runtime.submitted.filter((call) => call.tool === "raw_action").map((call) => call.input);
  assert.deepEqual(raw.slice(0, 6).map((input) => input.operation), ["dig", "look", "control", "dig", "dig", "place"]);
  // The bot is 0.35 east of the cell's middle: it faces west (yaw pi/2 in mineflayer: forward is -x), level. `look` at a cell takes whole numbers, so angles.
  assert.equal(raw[1]?.operation, "look");
  assert.ok(Math.abs(Number(raw[1]?.yaw) - Math.PI / 2) < 1e-9, `yaw ${String(raw[1]?.yaw)}`);
  assert.equal(raw[1]?.pitch, 0);
  assert.deepEqual(raw[2], { operation: "control", state: "forward", ticks: 2 });
  assert.deepEqual(calls("dig").slice(0, 3).map((dig) => dig.y), [63, 62, 61]);
});

test("still not landed after the step-in: one dig, failed could not drop into the hole", async () => {
  const { context, calls } = rig({ offCentre: true, neverLands: true });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.equal(calls("dig").length, 1);
  assert.match(detailOf(result), /could not drop into the hole at 0 63 0 \(feet at 0 64 0\)/u);
});

test("an order between the dig and the step-in: stopped at once, no look and no control submitted", async () => {
  const { runtime, context, controller, calls } = rig({ offCentre: true, timings: { landingMs: 60_000, landingPollMs: 60_000 } });
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "dig") setTimeout(() => controller.abort(), 20); };
  const started = performance.now();
  const result = await digShelterFlow(context);
  assert.equal(result.status, "stopped");
  assert.deepEqual([calls("look").length, calls("control").length], [0, 0]);
  assert.ok(performance.now() - started < 2_000, "the abort ended the landing wait at once");
});

test("a look that is refused is not followed by a walk: the heading is unknown, so no control is sent", async () => {
  const { runtime, context, calls } = rig({ offCentre: true });
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation === "dig") runtime.failNext.raw_action = { error: "[ACTION_BUSY] a reflex holds the body" };
  };
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.equal(calls("control").length, 0);
  assert.match(detailOf(result), /could not drop into the hole at 0 63 0/u);
});

test("a bot already in the middle of its cell that is not seen landing: no look, no control, failed could not drop", async () => {
  const { context, calls } = rig({ neverLands: true });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.deepEqual([calls("dig").length, calls("look").length, calls("control").length], [1, 0, 0]);
  assert.match(detailOf(result), /could not drop into the hole at 0 63 0 \(feet at 0 64 0\)/u);
});

test("the fall of the third dig is not seen (lag): no roof, the bot waits for the day in the open hole, done", async () => {
  const { runtime, context, moveTo, dayIn, calls } = rig();
  runtime.succeedEffects.raw_action = (input) => {
    if (input.operation !== "dig") return;
    // Only the third dig's fall is late: the feet stay one cell up (the client shows the fall late, `LANDING_MS`).
    moveTo(0.5, Number(input.y) === 61 ? 62 : Number(input.y), 0.5);
    if (Number(input.y) === 61) dayIn(150);
  };
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(calls("place"), []);
  assert.deepEqual([calls("look").length, calls("control").length], [0, 0], "no step-in below the first cell");
  assert.match(detailOf(result), /in an open hole \(the roof was not placed\)/u);
});

/** A region of another owner over the bot's own column, so every spot is a walk away. */
const OWN_COLUMN_PROTECTED: ProtectedArea = { regionId: 1, label: "house", owner: "Ayla", min: { x: 0, y: 55, z: 0 }, max: { x: 0, y: 70, z: 0 } };

test("the first spot unreachable: the second is walked to and dug", async () => {
  const { runtime, context, dayIn, calls, walks, onPlace } = rig();
  onPlace(() => dayIn(20));
  runtime.failNext.navigate = { error: "[NO_PATH] no route to the first spot" };
  const result = await digShelterFlow({ ...context, areas: [OWN_COLUMN_PROTECTED] });
  assert.equal(result.status, "done", detailOf(result));
  const [first, second] = walks();
  assert.equal(first?.range, 0);
  assert.equal(second?.range, 0);
  assert.notDeepEqual([second?.x, second?.z], [first?.x, first?.z]);
  assert.deepEqual([calls("dig")[0]?.x, calls("dig")[0]?.z], [second?.x, second?.z]);
});

test("three unreachable spots: failed could not reach any of 3 spots, nothing dug", async () => {
  const { runtime, context, calls } = rig();
  runtime.failures.navigate = "[NO_PATH] no route";
  const result = await digShelterFlow({ ...context, areas: [OWN_COLUMN_PROTECTED] });
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^could not reach any of 3 spots to dig in: \[NO_PATH\] no route/u);
  assert.equal(calls("dig").length, 0);
});

test("only sand carried: done in an open hole (no carried block that stays put), nothing placed", async () => {
  const { runtime, context, dayIn, calls } = rig({ inventory: [{ name: "sand", count: 20 }] });
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "dig" && Number(input.y) === 61) dayIn(20); };
  let hole: ShelterHole | null = null;
  const result = await digShelterFlow({ ...context, onHole: (made) => { hole = made; } });
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /in an open hole \(no carried block that stays put\)/u);
  assert.deepEqual(calls("place"), []);
  assert.deepEqual(hole, { x: 0, y: 64, z: 0, depth: 3, roofed: false });
});

test("a needed dirt is not the roof: cobblestone is", async () => {
  const { context, dayIn, calls, onPlace } = rig({ inventory: [{ name: "dirt", count: 9 }, { name: "cobblestone", count: 5 }], needed: new Set(["dirt"]) });
  onPlace(() => dayIn(20));
  await digShelterFlow(context);
  assert.deepEqual(calls("place").map((place) => place.block_name), ["cobblestone"]);
});

// A dig that fails below the first says the bot is in a hole, where the surface is, and keeps the spot and the feet after it (a log tells a bad fall from a reflex).
for (const [after, failedAt, deep] of [[63, 62, 1], [62, 61, 2]] as const) {
  test(`the dig below ${after} fails: failed with the cell, the hole ${deep} deep, the way to the surface, the spot and the feet`, async () => {
    const { runtime, context } = rig();
    const dug = runtime.succeedEffects.raw_action!;
    runtime.succeedEffects.raw_action = (input) => {
      dug(input);
      if (Number(input.y) === after) runtime.failNext.raw_action = { error: "[HOSTILE_CONTACT] a zombie hit me" };
    };
    const result = await digShelterFlow(context);
    assert.equal(result.status, "failed");
    assert.match(detailOf(result), new RegExp(`could not dig the hole at 0 ${failedAt} 0: \\[HOSTILE_CONTACT\\] a zombie hit me; I am in a hole ${deep} deep: go_to a spot on the surface nearby \\(0 64 0\\) to get out \\(spot 0 64 0, feet 0 ${after} 0\\)`, "u"));
  });
}

test("an open hole dug before: no dig, the bot drops in by itself, roofs and waits", async () => {
  const { runtime, context, moveTo, dayIn, calls, onPlace } = rig();
  for (const y of [61, 62, 63]) runtime.world.set(`0,${y},0`, "air");
  onPlace(() => dayIn(20));
  setTimeout(() => moveTo(0.5, 61, 0.5), 20);
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63], "only the roof is dug on the way out");
  assert.equal(calls("place").length, 1);
});

test("a waterlogged stair in a wall cell of the best spot: the second spot is dug", async () => {
  const { runtime, context, dayIn, calls, walks, onPlace } = rig();
  runtime.waterCells.add("1,62,0");
  onPlace(() => dayIn(20));
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(walks()[0], { x: -1, y: 64, z: 0, range: 0 });
  assert.equal(calls("dig")[0]?.x, -1);
  assert.equal(runtime.cellsRead.length, 2, "one cell read per spot looked at");
});

test("every spot has an unloaded cell around its hole: failed, counted as unknown cells, nothing dug", async () => {
  const { runtime, context, calls } = rig();
  runtime.unloadedCells.add("0,62,0");
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  // The 3 best spots are neighbours and share the cell: the text must not claim the other 166 columns were looked at.
  assert.match(detailOf(result), /^the 3 best spots each had water or an unloaded cell around their hole \(0 with water, 3 unloaded\); the other columns were not read: go_to another place and dig in there/u);
  assert.equal(calls("dig").length, 0);
  assert.ok(runtime.cellsRead.length <= 3);
});

test("a cell read that fails does not stop the dig: the dig result tells the truth about the hole", async () => {
  const { runtime, context, dayIn, calls, onPlace } = rig();
  runtime.cellsAt = async () => { throw new Error("[MCP_CALL_FAILED] view_blocks: no answer"); };
  onPlace(() => dayIn(20));
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(calls("dig")[0]?.y, 63);
});

test("no ground: failed with how many columns failed and why, nothing submitted", async () => {
  const { runtime, context } = rig();
  runtime.groundTop = 0;
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  // Open air all around: the walls of the cells she would stand in are the first rule every column fails.
  assert.match(detailOf(result), /^no ground near here to dig a closed hole in \(of 169 columns: 169 water or open walls\)/u);
  assert.deepEqual(runtime.submitted, []);
});

test("a player standing in the best column: it is not dug, the next one is", async () => {
  const { runtime, context, dayIn, calls, onPlace } = rig();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Ayla", position: { x: 0.5, y: 64, z: 0.5 } }] };
  onPlace(() => dayIn(20));
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done", detailOf(result));
  assert.notDeepEqual([calls("dig")[0]?.x, calls("dig")[0]?.z], [0, 0]);
});

test("day already when the bot reaches the spot: nothing dug, done", async () => {
  const { runtime, context } = rig({ dayCame: async () => true });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted, []);
});

test("the day coming after the second dig stops the digging and climbs out from depth 2, no roof placed", async () => {
  const answers = [false, false];
  const { runtime, context, calls } = rig({ dayCame: async () => answers.shift() ?? true });
  const result = await digShelterFlow(context);
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62]);
  assert.deepEqual(calls("place"), []);
  assert.equal(result.status, "done");
  assert.match(detailOf(result), /at 0 62 0/u);
  assert.equal(runtime.snapshot.position.y, 64);
});

/** A night whose roof dig and climb out both fail (the roof placed, then the day comes). */
function failedClimb() {
  const made = rig();
  made.onPlace(() => {
    made.dayIn(20);
    made.runtime.failNext.raw_action = { error: "[OUT_OF_REACH] the roof is too far" };
    made.runtime.failNext.navigate = { error: "[NO_PATH] no route out of the hole" };
  });
  return made;
}

test("a failed climb out is failed with the hole's floor and the roof still on when its dig failed (SKL-01)", async () => {
  const { context } = failedClimb();
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /still in my hole: feet at 0 61 0; its roof is still on: \[NO_PATH\]/u);
  assert.match(detailOf(result), /go_to a spot on the surface nearby \(0 64 0\)/u);
});

test("after a failed climb out the next step runs from the hole: a go_to from the floor position is submitted and settles", async () => {
  const { runtime, context } = failedClimb();
  const result = await digShelterFlow(context);
  assert.equal(runtime.snapshot.position.y, 61);
  const [, x, y, z] = /nearby \((-?\d+) (-?\d+) (-?\d+)\)/u.exec(detailOf(result)) ?? [];
  assert.ok(x !== undefined);
  const next = await context.body.act("navigate", { x: Number(x), y: Number(y), z: Number(z), range: 1 }, "the order after the shelter");
  assert.equal(next.status, "succeeded");
  assert.equal(runtime.snapshot.position.y, 64);
});

test("a bot that is no longer in the hole at night (a death, a reflex) ends failed at once, no roof dug, no walk back", async () => {
  const { runtime, context, moveTo, calls, walks, onPlace } = rig();
  onPlace(() => moveTo(50.5, 70, 50.5));
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /no longer in my hole \(now at 50 70 50: a death, a reflex or a push\)/u);
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62, 61]);
  assert.equal(walks().length, 0);
  assert.equal(runtime.snapshot.position.y, 70);
});

test("a roof the server refuses leaves the hole open and says so", async () => {
  const { runtime, context, dayIn } = rig();
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => {
    dug(input);
    if (input.operation === "dig" && Number(input.y) === 61) { runtime.failNext.raw_action = { error: "[PLACE_FAILED] no face" }; dayIn(20); }
  };
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done");
  assert.match(detailOf(result), /open hole \(the roof was not placed\)/u);
});

test("a stop while waiting returns stopped and leaves no timer", async () => {
  const { context, controller, onPlace } = rig({ timings: { waitSliceMs: 60_000 } });
  onPlace(() => setTimeout(() => controller.abort(), 20));
  const started = performance.now();
  const result = await digShelterFlow(context);
  assert.equal(result.status, "stopped");
  assert.ok(performance.now() - started < 2_000, "the abort ended the 60 s wait slice at once");
});

test("a stop during the climb out is stopped, not a failed climb", async () => {
  const { runtime, context, controller, dayIn, onPlace } = rig();
  onPlace(() => {
    dayIn(20);
    runtime.failNext.navigate = { error: "cancelled by caller", effect: () => controller.abort() };
  });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "stopped");
});
