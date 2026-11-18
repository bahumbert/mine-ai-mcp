// The cover obligation of a resumed request: what is owed after a cover evade, and the veto over a route that would
// break it (plan 2026-11-18-evade-resume-bound T7, spec D4).
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { blockClass, observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import type { PlannedOperation, PlannedStep } from "../../navigation/movements/movement.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { movementStep } from "../../test-support/navigation.js";
import { COVER_REFUSED_CODE, CoverObligations, coverAdmission, JUMP_APEX, type CoverObligation } from "./cover-obligation.js";

const SHOOTER = 7;
const OTHER_SHOOTER = 8;
/** The bot stands at x 8 behind a wall at x 10; the shooter is 12 blocks east of the bot, at x 20. */
const WALL_X = 10;

interface SceneOptions {
  /** Heights (y) of the wall at x 10 over z -1..1; the shooter's eye is at y 65.69. */
  readonly wallYs?: readonly number[];
  /** First and last z of the wall's cells; -1..1 by default. */
  readonly wallZ?: readonly [number, number];
  /** Cells left unloaded. */
  readonly unloaded?: readonly string[];
  /** A second shooter, north of the first. */
  readonly second?: boolean;
}

/** A floor at y 63, open air above, and a wall; the shooter(s) stand on the floor east of it. */
function scene(options: SceneOptions = {}) {
  const harness = createFakeBot({
    position: new Vec3(8.5, 64, 0.5),
    groundY: 63,
    entities: options.second
      ? { [SHOOTER]: { name: "skeleton", position: new Vec3(20.5, 64, 0.5) }, [OTHER_SHOOTER]: { name: "skeleton", position: new Vec3(20.5, 64, 12.5) } }
      : { [SHOOTER]: { name: "skeleton", position: new Vec3(20.5, 64, 0.5) } },
  });
  const world = new MemoryWorld();
  const wallYs = options.wallYs ?? [64, 65, 66];
  const wallZ = options.wallZ ?? [-1, 1];
  for (let x = -2; x <= 24; x++) for (let z = -14; z <= 14; z++) for (let y = 63; y <= 70; y++) {
    if (options.unloaded?.includes(`${x},${y},${z}`)) continue;
    const wall = x === WALL_X && z >= wallZ[0] && z <= wallZ[1] && wallYs.includes(y);
    world.load({ x, y, z }, { stateId: y === 63 || wall ? 1 : 0 });
  }
  return { ...harness, world };
}

type Scene = ReturnType<typeof scene>;

function obligation(harness: Scene, over: Partial<CoverObligation> = {}): CoverObligation {
  const entity = harness.bot.entities[over.threatId ?? SHOOTER]!;
  return { requestId: "request-1", generation: 0, threatId: entity.id, name: "skeleton",
    body: { position: entity.position.clone(), width: entity.width, height: entity.height }, safeRange: 36, ...over };
}

const feet = (x: number, y: number, z: number) => ({ x, y, z });

function dig(x: number, y: number, z: number, stance?: { x: number; y: number; z: number }): PlannedOperation {
  return { kind: "break", position: feet(x, y, z), expectedStateId: 1, toolType: null, brings: [], ...(stance ? { stance } : {}) };
}

function place(x: number, y: number, z: number): PlannedOperation {
  return { kind: "place", placement: { position: feet(x, y, z), stateId: 1, itemType: 1, support: feet(x, y - 1, z), face: feet(0, 1, 0) } };
}

/** A step whose operations are `before`, then its move. */
function step(kind: PlannedStep["kind"], from: PlannedStep["from"], to: PlannedStep["to"], before: readonly PlannedOperation[] = [],
  extra: Partial<PlannedStep> = {}): PlannedStep {
  const bare = movementStep(kind, from, to);
  return { ...bare, operations: [...before, ...bare.operations], ...extra };
}

function check(harness: Scene, obligations: readonly CoverObligation[], steps: readonly PlannedStep[], start = steps[0]!.from) {
  return coverAdmission(harness.bot, obligations).check({ start, steps }, harness.world);
}

const REFUSAL = new RegExp(`^\\${COVER_REFUSED_CODE.slice(0, -1)}\\] step \\d+/\\d+ at -?\\d+ -?\\d+ -?\\d+ is in sight of skeleton#\\d+ at \\d+\\.\\d blocks; no committed route keeps cover\\. The reflex still protects the body; choose the next action\\.$`);

test("a covered detour is admitted and every body stays covered", () => {
  const harness = scene();
  const detour = [step("walk", feet(8, 64, 0), feet(7, 64, 0)), step("walk", feet(7, 64, 0), feet(7, 64, 1)), step("walk", feet(7, 64, 1), feet(6, 64, 1))];
  assert.equal(check(harness, [obligation(harness)], detour), null);
});

test("a route across the shooter line is refused with the cover text", () => {
  const harness = scene();
  const across = [step("walk", feet(8, 64, 0), feet(8, 64, 1)), step("walk", feet(8, 64, 1), feet(8, 64, 2)), step("walk", feet(8, 64, 2), feet(8, 64, 3))];
  const refused = check(harness, [obligation(harness)], across);
  assert.match(refused ?? "", REFUSAL);
  assert.match(refused ?? "", /^\[COVER_ROUTE_REFUSED\] step [23]\/3 at 8 64 [23] is in sight of skeleton#7 at 12\.\d blocks;/, "the first exposed step, counted in what remains, with its body's block and the distance");
  assert.equal(COVER_REFUSED_CODE, "[COVER_ROUTE_REFUSED]");
});

test("a dig at its stance exposes the stance while from and to stay covered: refused", () => {
  const harness = scene();
  // The dig opens the wall over the doorway cell z 0 at head height; the stance (8,64,0) sees the shooter through it,
  // the step itself starts and ends on the covered z -1 line.
  const opened = step("walk", feet(8, 64, -1), feet(8, 64, -1), [dig(WALL_X, 65, 0, feet(8, 64, 0))]);
  assert.match(check(harness, [obligation(harness)], [opened]) ?? "", REFUSAL);
  const stanceCovered = step("walk", feet(8, 64, -1), feet(8, 64, -1), [dig(WALL_X, 65, 0, feet(8, 64, -1))]);
  assert.equal(check(harness, [obligation(harness)], [stanceCovered]), null, "the same dig from a covered stance is admitted");
});

test("a placement later in the step does not hide the dig's exposure", () => {
  const harness = scene();
  const dugThenPlaced = step("walk", feet(8, 64, 0), feet(7, 64, 0), [dig(WALL_X, 65, 0), place(WALL_X, 65, 0)]);
  assert.match(check(harness, [obligation(harness)], [dugThenPlaced]) ?? "", REFUSAL, "the stance was seen between the break and the placement");
  const placedOnly = step("walk", feet(8, 64, 0), feet(7, 64, 0), [place(WALL_X, 67, 0)]);
  assert.equal(check(harness, [obligation(harness)], [placedOnly]), null, "a placement that opens nothing is admitted");
});

test("a block to be dug never counts as cover", () => {
  const harness = scene({ wallYs: [64, 65] });
  // Standing in the doorway column while its own cover is the block being dug: the first ray after the break is clear.
  const digThrough = step("walk", feet(8, 64, 0), feet(9, 64, 0), [dig(WALL_X, 64, 0), dig(WALL_X, 65, 0)]);
  assert.match(check(harness, [obligation(harness)], [digThrough]) ?? "", REFUSAL);
});

test("a low-wall jump: endpoints covered, apex exposed: refused", () => {
  const harness = scene({ wallYs: [64, 65] });
  const obligations = [obligation(harness)];
  assert.equal(check(harness, obligations, [step("walk", feet(8, 64, 0), feet(6, 64, 0))]), null, "walking behind the wall is covered");
  for (const kind of ["jump", "sprint_jump", "parkour", "step_up", "pillar"] as const)
    assert.match(check(harness, obligations, [step(kind, feet(8, 64, 0), feet(6, 64, 0))]) ?? "", REFUSAL, `${kind} raises the body by the apex`);
  assert.equal(JUMP_APEX, 1.25);
  const taller = scene({ wallYs: [64, 65, 66, 67] });
  assert.equal(check(taller, [obligation(taller)], [step("sprint_jump", feet(8, 64, 0), feet(6, 64, 0))]), null, "a wall over the apex covers the jump");
});

test("a movement the check cannot model is refused, an inherited property name included", () => {
  const harness = scene();
  for (const kind of ["teleport", "constructor", "toString", "__proto__"]) {
    const unknown = step("walk", feet(8, 64, 0), feet(7, 64, 0), [], { kind: kind as PlannedStep["kind"] });
    const refused = check(harness, [obligation(harness)], [unknown]);
    assert.match(refused ?? "", new RegExp(`^\\[COVER_ROUTE_REFUSED\\] step 1/1 .*${kind}`), kind);
  }
});

test("a step that rises is judged at the apex whatever its kind", () => {
  const harness = scene({ wallYs: [64, 65, 66] });
  const flat = step("climb", feet(8, 64, 0), feet(7, 64, 0));
  const rising = step("climb", feet(8, 64, 0), feet(7, 65, 0));
  assert.equal(check(harness, [obligation(harness)], [flat]), null, "a flat climb stays behind the wall");
  assert.match(check(harness, [obligation(harness)], [rising]) ?? "", REFUSAL, "a body that rises over a three-high wall's edge is judged at the apex");
});

test("a door the route opens is judged open: the closed door covers, the opened one does not", () => {
  const harness = scene();
  // A closed oak door (lower and upper half) in the wall's doorway cell z 0, with stone above it.
  const halves = [[64, "lower"], [65, "upper"]] as const;
  const effects: PlannedStep["effects"][number][] = [];
  for (const [y, half] of halves) {
    const block = blockClass(harness.bot).fromProperties(harness.bot.registry.blocksByName.oak_door!.id,
      { facing: "east", half, hinge: "left", open: "false", powered: "false" }, 0);
    harness.world.load(feet(WALL_X, y, 0), observeMineflayerBlock(block));
    effects.push({ kind: "activate", position: feet(WALL_X, y, 0), stateId: block.stateId });
  }
  const bare = step("walk", feet(8, 64, 0), feet(9, 64, 0));
  assert.equal(check(harness, [obligation(harness)], [bare]), null, "the closed door hides the body behind it");
  const open = step("walk", feet(8, 64, 0), feet(9, 64, 0), [{ kind: "activate", position: feet(WALL_X, 64, 0),
    before: { description: "closed", matches: () => true }, after: { description: "open", matches: () => true } }], { effects });
  assert.match(check(harness, [obligation(harness)], [open]) ?? "", REFUSAL, "the route opens both halves: the shooter sees through");
});

test("an alternate arrival exposed: refused", () => {
  const harness = scene();
  const covered = step("walk", feet(8, 64, 0), feet(7, 64, 0));
  assert.equal(check(harness, [obligation(harness)], [covered]), null);
  const alternate = step("walk", feet(8, 64, 0), feet(7, 64, 0), [], { validArrivals: [feet(7, 64, 0), feet(7, 64, 4)] });
  assert.match(check(harness, [obligation(harness)], [alternate]) ?? "", /at 7 64 4 is in sight/);
});

test("an unknown cell on the line refuses", () => {
  // A wall five wide (z -1..3), the start covered by its west part; the cells the line to z 3 crosses are unknown in one world.
  const unloaded = [2, 3, 4].flatMap((z) => [64, 65, 66].map((y) => `${WALL_X},${y},${z}`));
  const known = scene({ wallZ: [-1, 4] });
  const unknown = scene({ wallZ: [-1, 4], unloaded });
  const toward = [step("walk", feet(8, 64, 0), feet(8, 64, 3))];
  assert.equal(check(known, [obligation(known)], toward), null, "the wall covers z 3 too");
  assert.match(check(unknown, [obligation(unknown)], toward) ?? "", REFUSAL, "nothing can be said to hide the body behind the unknown");
  // An unknown cell the line crosses BEFORE a known wall: the wall beyond it does not certify cover.
  const before = scene({ wallZ: [-1, 4], unloaded: [1, 2, 3, 4, 5].flatMap((z) => [64, 65, 66].map((y) => `15,${y},${z}`)) });
  assert.match(check(before, [obligation(before)], toward) ?? "", REFUSAL, "the unknown cell at x 15 is on every ray to z 3");
});

test("a body in an unloaded cell is exposed", () => {
  const harness = scene({ unloaded: ["7,64,0"] });
  assert.match(check(harness, [obligation(harness)], [step("walk", feet(8, 64, 0), feet(7, 64, 0))]) ?? "", REFUSAL);
});

test("start exposed for A only, B still checked", () => {
  const harness = scene({ second: true });
  const a = obligation(harness);
  const b = obligation(harness, { threatId: OTHER_SHOOTER });
  // Shooter A (z 0) is hidden by the wall at the start (8,64,0); shooter B (z 12) sees the start past the wall's end.
  const toward = [step("walk", feet(8, 64, 0), feet(8, 64, 3))];
  assert.match(check(harness, [a], toward) ?? "", /skeleton#7/, "A alone refuses the route to z 3");
  assert.equal(check(harness, [b], toward), null, "B sees the start (8,64,0), so B is waived for this route");
  assert.match(check(harness, [a, b], toward) ?? "", /skeleton#7/, "with B waived, A is still checked");
});

test("start exposed for the only shooter: admitted", () => {
  const harness = scene();
  const exposedStart = [step("walk", feet(8, 64, 3), feet(8, 64, 4))];
  assert.equal(check(harness, [obligation(harness)], exposedStart), null, "that cover is lost; the reflex decides, the route is not refused");
});

test("a shooter beyond the safe range exposes nothing", () => {
  const harness = scene();
  const across = [step("walk", feet(8, 64, 0), feet(8, 64, 3))];
  assert.match(check(harness, [obligation(harness)], across) ?? "", REFUSAL);
  assert.equal(check(harness, [obligation(harness, { safeRange: 11 })], across), null, "12.x blocks away is past a range of 11");
});

test("a moved shooter is judged at its new body", () => {
  const harness = scene();
  const obligations = new CoverObligations();
  obligations.add(obligation(harness));
  const walk = [step("walk", feet(8, 64, 0), feet(7, 64, 1))];
  const covered = obligations.current("request-1", 0, harness.bot, new Set());
  assert.equal(check(harness, covered, walk), null);
  // The shooter steps north past the wall's end: the line to z 1 no longer crosses it.
  harness.bot.entities[SHOOTER]!.position.z = 7.5;
  const moved = obligations.current("request-1", 0, harness.bot, new Set());
  assert.equal(moved[0]!.body.position.z, 7.5);
  assert.match(check(harness, moved, walk) ?? "", REFUSAL);
});

test("a confirmed death drops the obligation", () => {
  const harness = scene();
  const obligations = new CoverObligations();
  obligations.add(obligation(harness));
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 1);
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set([SHOOTER])).length, 0);
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 0, "a dropped obligation stays dropped");
});

test("an unloaded shooter keeps its last body", () => {
  const harness = scene();
  const obligations = new CoverObligations();
  obligations.add(obligation(harness));
  harness.entities.remove(SHOOTER);
  const kept = obligations.current("request-1", 0, harness.bot, new Set());
  assert.equal(kept.length, 1);
  assert.equal(kept[0]!.body.position.x, 20.5);
});

test("another request id empties the store", () => {
  const harness = scene();
  const obligations = new CoverObligations();
  obligations.add(obligation(harness));
  assert.equal(obligations.current("request-2", 0, harness.bot, new Set()).length, 0);
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 0, "the old request does not get it back");
  obligations.add(obligation(harness));
  assert.equal(obligations.current(null, 0, harness.bot, new Set()).length, 0, "no request owes nothing");
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 0);
});

test("an older generation empties the store", () => {
  const harness = scene();
  const obligations = new CoverObligations();
  obligations.add(obligation(harness, { generation: 3 }));
  assert.equal(obligations.current("request-1", 3, harness.bot, new Set()).length, 1);
  assert.equal(obligations.current("request-1", 4, harness.bot, new Set()).length, 0);
  obligations.add(obligation(harness, { generation: 4 }));
  obligations.clear();
  assert.equal(obligations.current("request-1", 4, harness.bot, new Set()).length, 0, "clear empties the store");
});

test("an obligation for the same shooter replaces the older one; another request's replaces the whole store", () => {
  const harness = scene({ second: true });
  const obligations = new CoverObligations();
  obligations.add(obligation(harness));
  obligations.add(obligation(harness, { safeRange: 20 }));
  assert.deepEqual(obligations.current("request-1", 0, harness.bot, new Set()).map((entry) => entry.safeRange), [20]);
  obligations.add(obligation(harness, { threatId: OTHER_SHOOTER }));
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 2);
  obligations.add(obligation(harness, { requestId: "request-2" }));
  assert.equal(obligations.current("request-2", 0, harness.bot, new Set()).length, 1);
  assert.equal(obligations.current("request-1", 0, harness.bot, new Set()).length, 0);
});
