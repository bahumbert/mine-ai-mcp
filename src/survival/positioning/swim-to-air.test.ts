import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { swimToBreathableCell } from "./swim-to-air.js";

type Cell = "water" | "air" | "stone";
const SPEED = 0.1;
/** The box of cells the swims below can reach or look at; stone outside it. */
const BOX = { x: [-25, 25], y: [-3, 4], z: [-3, 3] } as const;

/** `read` written into the fake world's cells over {@link BOX}. */
function cellsOf(read: (x: number, y: number, z: number) => Cell): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let x = BOX.x[0]; x <= BOX.x[1]; x++)
    for (let y = BOX.y[0]; y <= BOX.y[1]; y++) for (let z = BOX.z[0]; z <= BOX.z[1]; z++) cells[`${x},${y},${z}`] = read(x, y, z);
  return cells;
}

/**
 * A swimmer on the shared fake bot in `read`'s world. The body moves by a simple swim of 0.1 a tick in the held
 * directions, stopped by stone (not Mineflayer's water physics: the test is about the route and the controls).
 */
function swimmer(read: (x: number, y: number, z: number) => Cell, start: Vec3, options: { mockedClock?: boolean } = {}) {
  const clock = createFakeClock({ mode: options.mockedClock ? "mocked" : "manual" });
  const { bot } = createFakeBot({ position: start, cells: cellsOf(read), groundY: BOX.y[1] + 60, clock });
  const entity = Object.assign(bot.entity, { isInWater: true, onGround: false });
  const at = (p: Vec3) => read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  const held = () => Object.entries(bot.controlState).filter(([, state]) => state).map(([control]) => control);
  const free = (p: Vec3) => at(p) !== "stone" && at(p.offset(0, 1.79, 0)) !== "stone";
  // The body's move on each client tick, before the swim hears the tick.
  bot.on("physicsTick", () => {
    const controls = bot.controlState;
    const dy = controls.jump ? SPEED : controls.sneak ? -SPEED : 0;
    const sideways = entity.position.offset(((controls.right ? 1 : 0) - (controls.left ? 1 : 0)) * SPEED, 0,
      ((controls.back ? 1 : 0) - (controls.forward ? 1 : 0)) * SPEED);
    if (free(sideways)) entity.position = sideways;
    if (free(entity.position.offset(0, dy, 0))) entity.position = entity.position.offset(0, dy, 0);
    entity.isInWater = at(entity.position) === "water";
  });
  const headInAir = () => at(entity.position.offset(0, 1.62, 0)) === "air";
  /** Runs the swim, a client tick at a time. */
  const swim = async (signal = new AbortController().signal, wallMs?: number) => {
    const done = swimToBreathableCell(bot, signal, wallMs);
    const finished = watch(done);
    for (let n = 0; n < 1_000 && !finished.over; n++) await clock.advance(50);
    await done;
  };
  return { swim, held, entity, headInAir, bot, clock };
}

/** A roofed stream along x (y 0-1), stone around it. */
const tunnel = (x: number, y: number, z: number): Cell => (z === 0 && y >= 0 && y <= 1 && x >= -20 && x <= 20 ? "water" : "stone");

test("a pinned swimmer under a roof swims to the air pocket five cells away and stops with its head in air", async () => {
  const pocket = (x: number, y: number, z: number): Cell => (x <= -5 && x >= -6 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimmer(pocket, new Vec3(0.5, 0.2, 0.5));
  await world.swim();
  assert.equal(world.headInAir(), true);
  assert.ok(world.entity.position.x < -4, `ended at x ${world.entity.position.x}`);
  assert.deepEqual(world.held(), [], "controls released");
});

test("a swimmer whose head is already in air does nothing", async () => {
  const open = (x: number, y: number, z: number): Cell => (y >= 1 ? "air" : "water");
  const world = swimmer(open, new Vec3(0.5, 0.2, 0.5));
  await world.swim();
  assert.deepEqual(world.held(), []);
  assert.ok(Math.abs(world.entity.position.x - 0.5) < 0.01);
});

test("with no physics tick the swim still ends on the wall clock, controls released", async () => {
  const world = swimmer(tunnel, new Vec3(0.5, 0.2, 0.5), { mockedClock: true });
  using _installed = world.clock.install();
  world.bot.physicsEnabled = false; // the client runs no tick: physics stopped
  const started = performance.now();
  await world.swim(undefined, 100);
  assert.ok(performance.now() - started < 2_000);
  assert.deepEqual(world.held(), []);
});

test("a swim cancelled mid-way releases the controls and rethrows the cancel", async () => {
  const pocket = (x: number, y: number, z: number): Cell => (x <= -5 && x >= -6 && y === 1 && z === 0 ? "air" : tunnel(x, y, z));
  const world = swimmer(pocket, new Vec3(0.5, 0.2, 0.5));
  const stop = new AbortController();
  let ticks = 0;
  world.bot.on("physicsTick", () => { if (++ticks === 5) stop.abort(new Error("cancelled")); });
  await assert.rejects(world.swim(stop.signal), /cancelled/u);
  assert.deepEqual(world.held(), []);
});
