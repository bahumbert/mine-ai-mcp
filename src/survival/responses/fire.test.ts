import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { type FakeCell, type FakeClock, type FakeEntitySpec, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { isInLava } from "../perception/body.js";
import { escapeFire, lavaStepCells, type FireEscapeOutcome } from "./fire.js";

test("lava contact includes the shallow body overlap missed by the swimming flag", () => {
  const lavaCell = new Vec3(1, 63, 0);
  const { bot, world } = createFakeBot({ position: new Vec3(0.761841334797, 63.875, 0.5), cells: { "1,63,0": "lava" }, groundY: null });
  const setLevel = (level: number | string) => world.setCell(lavaCell, { name: "lava", properties: { level } });
  assert.equal(isInLava(bot), true);
  bot.entity.position.x = 0.69;
  assert.equal(isInLava(bot), false, "beside lava without body overlap is safe");
  bot.entity.position.x = 0.76;
  bot.entity.position.y = 63.95;
  assert.equal(isInLava(bot), false, "above the source surface is safe");
  bot.entity.position.y = 63.875;
  setLevel(7);
  assert.equal(isInLava(bot), false, "a low flowing layer does not fill the whole cell");
  setLevel("7");
  assert.equal(isInLava(bot), false, "Prismarine string levels retain the same shallow surface");
  setLevel("8");
  assert.equal(isInLava(bot), true, "a falling stream fills back up to source height");
});

/** Lava at `level` (a flowed layer below 8). */
const lavaAt = (level: number): FakeCell => ({ name: "lava", properties: { level } });

/**
 * A burning body at `position` on a stone floor to y 64, with `cells` on it, and a navigation world observed from the
 * same cells. The default is the lava-escape-to-water scene: a one-cell lava pit at (0,64,0), water at (2,64,0), the
 * body on the west bank.
 */
function burningScene(
  options: { cells?: Record<string, FakeCell>; position?: Vec3; entities?: Record<number, FakeEntitySpec>; clock?: FakeClock } = {},
) {
  const harness = createFakeBot({
    position: options.position ?? new Vec3(-0.5, 65, 0.5),
    cells: options.cells ?? { "0,64,0": "lava", "2,64,0": "water" },
    groundY: 64,
    entities: options.entities,
    clock: options.clock,
  });
  const { bot } = harness;
  const controls = bot.controlState;
  const cleared = { count: 0 };
  const clear = bot.clearControlStates.bind(bot);
  bot.clearControlStates = () => {
    cleared.count++;
    clear();
  };
  setBurning(bot, true);
  const world = new MemoryWorld();
  const load = (x: number, y: number, z: number) => {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  };
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 62; y <= 68; y++) load(x, y, z);
  /** Change a cell for the bot and for the navigation world that observed it. */
  const setCell = (x: number, y: number, z: number, cell: FakeCell) => {
    harness.world.setCell(new Vec3(x, y, z), cell);
    load(x, y, z);
  };
  /** Client ticks one at a time, letting the escape's waits settle between them. */
  const physicsTicks = (count: number) => harness.clock.advance(50 * count);
  return { bot, clock: harness.clock, world, controls, cleared, setCell, physicsTicks };
}

const burningOnTheBank = (position?: Vec3) => burningScene({ position });

/** The shared_flags metadata bit 0 the fire checks read as burning, at the version's index. */
function setBurning(bot: ReturnType<typeof createFakeBot>["bot"], burning: boolean): void {
  Reflect.set(bot.entity.metadata, bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags"), burning ? 1 : 0);
}

function watch(promise: Promise<FireEscapeOutcome>) {
  const seen: { outcome: FireEscapeOutcome | null } = { outcome: null };
  void promise.then((outcome) => (seen.outcome = outcome));
  return seen;
}

const anyMoveControl = (controls: Readonly<Record<"forward" | "back" | "left" | "right", boolean>>) =>
  (["forward", "back", "left", "right"] as const).some((control) => controls[control]);

test("a burning bot on the bank keeps going while water is reachable", async () => {
  const { bot, world, controls, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(5);
  assert.equal(seen.outcome, null, "burning with water in reach is not settled");
  assert.equal(anyMoveControl(controls), true, "a move control is set toward the first cell of the way round");
  Object.assign(bot.entity, { isInWater: true });
  bot.entity.position.set(2.5, 64, 0.5);
  setBurning(bot, false);
  await physicsTicks(1);
  assert.equal(seen.outcome, "escaped");
});

test("fire out before arriving ends the escape", async () => {
  const { bot, world, controls, cleared, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(3);
  assert.equal(seen.outcome, null, "still burning with water in reach: the walk is on");
  assert.equal(anyMoveControl(controls), true, "a move control is set toward the way round");
  const clearedWhileWalking = cleared.count;
  setBurning(bot, false);
  await physicsTicks(2);
  assert.equal(seen.outcome, "escaped", "the flag cleared: ended within 2 ticks");
  assert.equal(anyMoveControl(controls), false);
  assert.ok(cleared.count > clearedWhileWalking, "the controls were cleared at the end");
});

test("water drained mid-route ends the walk", async () => {
  const { world, setCell, bot, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(3);
  assert.equal(seen.outcome, null, "still walking to the water");
  setCell(2, 64, 0, "stone");
  await physicsTicks(3);
  assert.equal(seen.outcome, "escaped", "dry ground and no water left: the same end as with no water");
});

test("a cancel mid-route stops at once", async () => {
  const { bot, world, cleared, physicsTicks } = burningOnTheBank();
  const escape = new AbortController();
  const result = escapeFire(bot, world, escape.signal).then(
    () => "returned",
    (error: unknown) => error,
  );
  await physicsTicks(3);
  const before = cleared.count;
  escape.abort(new Error("cancelled by the test"));
  assert.match(String(await result), /cancelled by the test/);
  assert.ok(cleared.count > before, "the controls are released");
  assert.equal(bot.listenerCount("physicsTick"), 0, "no physics listener is left");
});

test("no physics ticks: the wall clock ends the escape", async () => {
  const { bot, world, clock } = burningScene({ clock: createFakeClock({ mode: "mocked" }) });
  using _installed = clock.install();
  bot.physicsEnabled = false; // the client runs no tick: physics stopped
  const started = performance.now();
  const escaping = escapeFire(bot, world, new AbortController().signal, "contact", { maximumMs: 50 });
  await clock.advance(50);
  const outcome = await escaping;
  assert.equal(outcome, "timed_out", "the clock ended it: not the same as a walk with nowhere to go");
  assert.ok(performance.now() - started < 500, "returned within 500 ms without one physics tick");
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a death mid-route ends the escape as died", async () => {
  const { bot, world, physicsTicks } = burningOnTheBank();
  // The client's own listeners (Mineflayer's physics stops on a death and restarts on a respawn).
  const atRest = { death: bot.listenerCount("death"), respawn: bot.listenerCount("respawn") };
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(2);
  bot.health = 0;
  bot.emit("death");
  await physicsTicks(1);
  assert.equal(seen.outcome, "died");
  assert.equal(bot.listenerCount("death"), atRest.death, "the death listener is removed");
  assert.equal(bot.listenerCount("respawn"), atRest.respawn, "the respawn listener is removed");
});

test("no water in reach: escaped on dry ground as today", async () => {
  const { bot, world } = burningOnTheBank(new Vec3(-4.5, 65, 5.5));
  const outcome = await escapeFire(bot, world, new AbortController().signal);
  assert.equal(outcome, "escaped");
});

test("a burning bot goes on from cell to cell of the way round the lava", async () => {
  const { bot, world, controls, physicsTicks } = burningOnTheBank();
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  for (const [x, z] of [[-0.5, 1.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]] as const) {
    await physicsTicks(2);
    assert.equal(seen.outcome, null, `still walking before (${x}, ${z})`);
    bot.entity.position.set(x, 65, z);
  }
  await physicsTicks(2);
  assert.equal(seen.outcome, null, "on the bank beside the water, still burning");
  assert.equal(anyMoveControl(controls), true);
  Object.assign(bot.entity, { isInWater: true });
  bot.entity.position.set(2.5, 64, 0.5);
  setBurning(bot, false);
  await physicsTicks(1);
  assert.equal(seen.outcome, "escaped");
});

test("a burning bot beside lava that can spread into its cell is not escaped there, whatever woke the reflex", async () => {
  for (const reason of ["contact", "advancing_lava"] as const) {
    const { bot, world, controls, physicsTicks } = burningScene({ cells: { "1,65,0": lavaAt(2) }, position: new Vec3(0.5, 65, 0.5) });
    const seen = watch(escapeFire(bot, world, new AbortController().signal, reason));
    await physicsTicks(3);
    assert.equal(seen.outcome, null, `${reason}: beside level 2 lava the escape goes on`);
    assert.equal(anyMoveControl(controls), true, `${reason}: it walks to a cell lava cannot spread into`);
    bot.entity.position.set(0.5, 65, 1.5);
    await physicsTicks(2);
    assert.equal(seen.outcome, "escaped", `${reason}: one cell away from the lava's reach`);
  }
});

test("burning on safe dry ground with no water in reach is escaped at once, whatever woke the reflex", async () => {
  for (const reason of ["contact", "advancing_lava"] as const) {
    const { bot, world, physicsTicks } = burningScene({ cells: {}, position: new Vec3(-4.5, 65, 5.5) });
    const seen = watch(escapeFire(bot, world, new AbortController().signal, reason, { maximumMs: 2_000 }));
    await physicsTicks(5);
    assert.equal(seen.outcome, "escaped", `${reason}: not held until the wall clock ends it`);
  }
});

test("a burning bot on an unsafe dry cell with no safe cell in reach is told blocked, not held", async () => {
  const { bot, world, physicsTicks } = burningScene({
    cells: { "1,65,0": lavaAt(2), "-1,65,0": lavaAt(2), "0,65,1": lavaAt(2), "0,65,-1": lavaAt(2) },
    position: new Vec3(0.5, 65, 0.5),
  });
  const seen = watch(escapeFire(bot, world, new AbortController().signal, "advancing_lava", { maximumMs: 2_000 }));
  await physicsTicks(3);
  assert.equal(seen.outcome, "blocked", "the four neighbours are lava and the cell is its own: no way on");
});

test("a lava cell beside the body with room above it can take a step, whatever the room is made of", () => {
  const { bot, world } = burningScene({
    cells: { "1,65,0": "lava", "1,66,0": "torch", "-1,65,0": "lava", "-1,66,0": "stone", "0,65,1": "lava", "0,66,1": "lava", "0,65,-1": "stone" },
    position: new Vec3(0.5, 65, 0.5),
  });
  assert.deepEqual(
    lavaStepCells(bot, world).map((cell) => cell.toString()),
    [new Vec3(1, 65, 0).toString()],
    "a torch above is a passable cell, a stone or lava above is not; a stone is no lava cell",
  );
});

test("a lava cell holding a creature takes no step", () => {
  const { bot, world } = burningScene({
    cells: { "1,65,0": "lava" },
    position: new Vec3(0.5, 65, 0.5),
    entities: { 7: { type: "mob", name: "zombie", position: new Vec3(1.5, 65, 0.5), width: 0.6, height: 1.95 } },
  });
  assert.deepEqual(lavaStepCells(bot, world), []);
});
