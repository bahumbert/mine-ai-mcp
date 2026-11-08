import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING, type ActOutcome } from "../body.ts";
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
    if (input.operation === "place") {
      const offsets: Record<string, readonly [number, number]> = { west: [-1, 0], east: [1, 0], north: [0, -1], south: [0, 1] };
      const [dx, dz] = offsets[String(input.face)] ?? [0, 0];
      runtime.world.set(`${Number(input.x) + dx},${Number(input.y)},${Number(input.z) + dz}`, String(input.block_name));
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
const failed = (error: string, status: ActOutcome["status"] = "failed"): ActOutcome => ({ status, error, preempted: false });

/** Intercepts body outcomes to model an unmeasured reflex handing control back. */
function intercept(r: ReturnType<typeof rig>, hook: (tool: string, input: Readonly<Record<string, unknown>>) => ActOutcome | null) {
  const original = r.context.body.act.bind(r.context.body);
  r.context.body.act = async (tool, input, reason, options) => hook(tool, input) ?? original(tool, input, reason, options);
}

test("by day without minutes nothing is submitted and the model is told how to shelter", async () => {
  const { runtime, context } = rig({ dayCame: async () => true });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done");
  assert.match(detailOf(result), /give minutes to stay in a while/u);
  assert.deepEqual(runtime.submitted, []);
});

test("minutes by day expire after digging and climbing out", async () => {
  const { context, calls } = rig({ dayCame: async () => true, timings: { minuteMs: 10, waitSliceMs: 1 } });
  let now = 0;
  const result = await digShelterFlow({ ...context, now: () => now, alive: () => { now += 5; } }, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(calls("dig").map((dig) => dig.y), [63, 62, 61, 63]);
  assert.equal(now, 20);
});

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

test("a reflex interrupts the second dig two blocks away: return to the floor and dig it again", async () => {
  const r = rig(); let once = true;
  intercept(r, (tool, input) => {
    if (tool === "raw_action" && input.operation === "dig" && input.y === 62 && once) {
      once = false; r.moveTo(2.5, 64, 0.5); return failed("[HOSTILE_CONTACT] a zombie hit me");
    }
    return null;
  });
  r.onPlace(() => r.dayIn(20));
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(r.walks()[0], { x: 0, y: 63, z: 0, range: 0 });
  assert.deepEqual(r.calls("dig").slice(0, 3).map((x) => x.y), [63, 62, 61]);
  assert.match(detailOf(result), /resumes: 1 \(\[HOSTILE_CONTACT\]/u);
});

for (const reason of ["a broken tool", "[HOSTILE_CONTACT] evade response outmatched"]) {
  test(`five dig failures (${reason}) give up after four resumes, naming position and cause`, async () => {
    const r = rig();
    intercept(r, (tool, input) => tool === "raw_action" && input.operation === "dig" ? failed(reason) : null);
    const result = await digShelterFlow(r.context);
    assert.equal(result.status, "failed");
    assert.match(detailOf(result), /gave up after 4 resumes; now at 0 64 0/u);
    assert.ok(detailOf(result).includes(`resumes: 4 (${reason}`));
  });
}

test("a failed walk back counts another resume and retries", async () => {
  const r = rig(); let interrupted = false; let failedWalk = false;
  intercept(r, (tool, input) => {
    if (tool === "raw_action" && input.operation === "dig" && !interrupted) { interrupted = true; r.moveTo(2.5, 64, 0.5); return failed("hit"); }
    if (tool === "navigate" && !failedWalk) { failedWalk = true; return failed("no path yet"); }
    return null;
  });
  r.onPlace(() => r.dayIn(20));
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /resumes: 2 \(hit; no path yet\)/u);
});

test("a busy dig until the minutes expire is not a resume", async () => {
  const r = rig({ dayCame: async () => true, timings: { minuteMs: 5 } });
  intercept(r, (tool) => tool === "raw_action" ? failed("ACTION_BUSY: reflex", "refused") : null);
  const result = await digShelterFlow(r.context, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /resumes: 0/u);
});

test("a busy dig displaced outside at the deadline ends without a climb", async () => {
  let now = 0;
  const r = rig({ dayCame: async () => true, timings: { minuteMs: 10 } });
  intercept(r, (tool, input) => {
    if (tool === "raw_action" && input.operation === "dig" && input.y === 62) {
      r.moveTo(2.5, 64, 0.5); now = 20; return failed("ACTION_BUSY: reflex", "refused");
    }
    return null;
  });
  const result = await digShelterFlow({ ...r.context, now: () => now }, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(r.walks().length, 0);
  assert.match(detailOf(result), /resumes: 0/u);
});

test("a busy walk to the first spot until the deadline ends without another candidate", async () => {
  const r = rig({ dayCame: async () => true, timings: { minuteMs: 10 } }); let calls = 0;
  intercept(r, (tool) => { if (tool === "navigate") { calls++; return failed("ACTION_BUSY: reflex", "refused"); } return null; });
  const result = await digShelterFlow({ ...r.context, areas: [OWN_COLUMN_PROTECTED] }, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.ok(calls >= 1);
  assert.equal(r.calls("dig").length, 0);
});

test("minutes expire at night even if dawn never comes", async () => {
  const r = rig({ timings: { minuteMs: 10 } });
  const result = await digShelterFlow(r.context, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(r.runtime.snapshot.position.y, 64);
});

test("three ACTION_BUSY refusals do not count as resumes", async () => {
  const r = rig(); let busy = 3;
  intercept(r, (tool, input) => tool === "raw_action" && input.operation === "dig" && busy-- > 0 ? failed("ACTION_BUSY: reflex holds body", "refused") : null);
  r.onPlace(() => r.dayIn(20));
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /resumes: 0/u);
});

test("a reflex moving twenty blocks away causes a new search there", async () => {
  const r = rig(); let once = true;
  intercept(r, (tool, input) => {
    if (tool === "raw_action" && input.operation === "dig" && once) { once = false; r.moveTo(20.5, 64, 0.5); return failed("[HOSTILE_CONTACT] evade"); }
    return null;
  });
  r.onPlace(() => r.dayIn(20));
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(r.calls("dig")[0]?.x, 20);
});

test("an order after a failed dig prevents the walk back", async () => {
  const r = rig(); let handedBack = false;
  const status = r.runtime.status.bind(r.runtime);
  r.runtime.status = async () => {
    const snapshot = await status();
    if (handedBack) r.controller.abort();
    return snapshot;
  };
  intercept(r, (tool, input) => {
    if (tool === "raw_action" && input.operation === "dig") { r.moveTo(2.5, 64, 0.5); handedBack = true; return failed("[HOSTILE_CONTACT] evade"); }
    return null;
  });
  assert.equal((await digShelterFlow(r.context)).status, "stopped");
  assert.equal(r.walks().length, 0);
});

test("minutes at night end at dawn before the deadline", async () => {
  let now = 0;
  const r = rig({ dayCame: async () => now >= 10, timings: { minuteMs: 10, waitSliceMs: 1 } });
  const result = await digShelterFlow({ ...r.context, now: () => now, alive: () => { now += 5; } }, { minutes: 2 });
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(r.runtime.snapshot.position.y, 64);
  assert.equal(now, 10);
});

test("each shelter wait slice reports alive", async () => {
  const r = rig(); let alive = 0; r.onPlace(() => r.dayIn(30));
  const result = await digShelterFlow({ ...r.context, alive: () => { alive++; } });
  assert.equal(result.status, "done"); assert.ok(alive >= 2);
});

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
  let checks = 0;
  const { runtime, context } = rig({ dayCame: async () => ++checks > 1 });
  const result = await digShelterFlow(context);
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted, []);
});

test("the day coming after the second dig stops the digging and climbs out from depth 2, no roof placed", async () => {
  let day = false;
  const { runtime, context, calls } = rig({ dayCame: async () => day });
  const dug = runtime.succeedEffects.raw_action!;
  runtime.succeedEffects.raw_action = (input) => { dug(input); if (input.operation === "dig" && input.y === 62) day = true; };
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
    made.runtime.failures.raw_action = "[OUT_OF_REACH] the roof is too far";
    made.runtime.failures.navigate = "[NO_PATH] no route out of the hole";
  });
  return made;
}

test("a failed climb out is failed with the hole's floor and the roof still on when its dig failed (SKL-01)", async () => {
  const { runtime, context, walks } = failedClimb();
  const result = await digShelterFlow(context);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /still in my hole: feet at 0 61 0; its roof is still on: \[NO_PATH\]/u);
  assert.match(detailOf(result), /go_to a spot on the surface nearby \(0 64 0\)/u);
  assert.equal(walks().filter((walk) => walk.range === 1).length, 2);
  assert.equal(runtime.snapshot.position.y, 61);
  delete runtime.failures.navigate;
  const [, x, y, z] = /nearby \((-?\d+) (-?\d+) (-?\d+)\)/u.exec(detailOf(result)) ?? [];
  assert.ok(x !== undefined);
  const next = await context.body.act("navigate", { x: Number(x), y: Number(y), z: Number(z), range: 1 }, "the order after the shelter");
  assert.equal(next.status, "succeeded");
  assert.equal(runtime.snapshot.position.y, 64);
});

test("a transient failed climb succeeds on the single retry", async () => {
  const r = rig();
  r.onPlace(() => { r.dayIn(20); r.runtime.failNext.navigate = { error: "[NO_PATH] temporary" }; });
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /resumes: 1 \(\[NO_PATH\] temporary\)/u);
  assert.equal(r.runtime.snapshot.position.y, 64);
});

test("a busy climb after the shelter ends is not counted as a resume", async () => {
  const r = rig(); r.onPlace(() => r.dayIn(20));
  intercept(r, (tool, input) => tool === "navigate" && input.range === 1 ? failed("ACTION_BUSY: reflex", "refused") : null);
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /ACTION_BUSY/u);
  assert.match(detailOf(result), /resumes: 0/u);
});

test("a reflex displaces the bot during the climb: it reports its actual position", async () => {
  const r = rig(); r.onPlace(() => r.dayIn(20));
  intercept(r, (tool, input) => {
    if (tool === "navigate" && input.range === 1) { r.moveTo(20.5, 64, 0.5); return failed("[HOSTILE_CONTACT] evade"); }
    return null;
  });
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.match(detailOf(result), /now at 20 64 0/u);
  assert.match(detailOf(result), /resumes: 1/u);
});

test("a failed climb retry does not dig a roof already removed by the first attempt", async () => {
  const r = rig();
  r.onPlace(() => { r.dayIn(20); r.runtime.failures.navigate = "[NO_PATH] blocked"; });
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "failed");
  assert.deepEqual(r.calls("dig").map((dig) => dig.y), [63, 62, 61, 63]);
  assert.doesNotMatch(detailOf(result), /roof is still on/u);
});

test("giving up on a dig in the hole leaves a usable next go_to", async () => {
  const r = rig();
  intercept(r, (tool, input) => tool === "raw_action" && input.operation === "dig" && input.y === 62 ? failed("tool broke") : null);
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /go_to a spot on the surface/u);
  const next = await r.context.body.act("navigate", { x: 0, y: 64, z: 0, range: 1 }, "leave the partial hole");
  assert.equal(next.status, "succeeded");
});

test("pushed from the hole with its roof gone: returns, roofs again and waits", async () => {
  const r = rig(); let places = 0;
  r.onPlace(() => {
    places++;
    if (places === 1) { r.runtime.world.set("0,63,0", "air"); r.moveTo(2.5, 64, 0.5); }
    else r.dayIn(20);
  });
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.deepEqual(r.walks()[0], { x: 0, y: 61, z: 0, range: 0 });
  assert.equal(r.calls("place").length, 2);
});

test("death during the wait: search and dig at the distant respawn", async () => {
  const r = rig(); let places = 0;
  r.onPlace(() => { if (++places === 1) r.moveTo(300.5, 64, 0.5); else r.dayIn(20); });
  const result = await digShelterFlow(r.context);
  assert.equal(result.status, "done", detailOf(result));
  assert.ok(r.calls("dig").some((dig) => dig.x === 300));
  assert.match(detailOf(result), /resumes: 1/u);
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
  const { runtime, context, controller, onPlace } = rig({ timings: { waitSliceMs: 60_000 } });
  onPlace(() => setTimeout(() => controller.abort(), 20));
  const started = performance.now();
  const result = await digShelterFlow(context);
  assert.equal(result.status, "stopped");
  assert.ok(performance.now() - started < 2_000, "the abort ended the 60 s wait slice at once");
  const next = await context.body.act("navigate", { x: 0, y: 64, z: 0, range: 1 }, "the next order leaves the roofed hole");
  assert.equal(next.status, "succeeded");
  assert.equal(runtime.snapshot.position.y, 64);
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
