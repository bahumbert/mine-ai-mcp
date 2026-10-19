import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
import { isInLava } from "../perception/body.js";
import { escapeFire, type FireEscapeOutcome } from "./fire.js";

test("lava contact includes the shallow body overlap missed by the swimming flag", () => {
  let level: number | string = 0;
  const bot = {
    entity: { position: new Vec3(0.761841334797, 63.875, 0.5), width: 0.6, height: 1.8, isInLava: false },
    blockAt: (at: Vec3) =>
      at.floored().equals(new Vec3(1, 63, 0)) ? { name: "lava", getProperties: () => ({ level }) } : { name: "air" },
  } as unknown as Bot;
  assert.equal(isInLava(bot), true);
  bot.entity.position.x = 0.69;
  assert.equal(isInLava(bot), false, "beside lava without body overlap is safe");
  bot.entity.position.x = 0.76;
  bot.entity.position.y = 63.95;
  assert.equal(isInLava(bot), false, "above the source surface is safe");
  bot.entity.position.y = 63.875;
  level = 7;
  assert.equal(isInLava(bot), false, "a low flowing layer does not fill the whole cell");
  level = "7";
  assert.equal(isInLava(bot), false, "Prismarine string levels retain the same shallow surface");
  level = "8";
  assert.equal(isInLava(bot), true, "a falling stream fills back up to source height");
});

/** The lava-escape-to-water scene: a one-cell lava pit at (0,64,0), water at (2,64,0), the body burning on the west bank. */
function burningOnTheBank(position = new Vec3(-0.5, 65, 0.5)) {
  const cells: Record<string, string> = { "0,64,0": "lava", "2,64,0": "water" };
  const controls: Record<string, boolean> = {};
  const cleared = { count: 0 };
  const bot = botFixture(
    { blocks: cells, groundY: 64, position },
    {
      stopDigging() {},
      deactivateItem() {},
      setControlState: (control: string, state: boolean) => {
        controls[control] = state;
      },
      clearControlStates: () => {
        cleared.count++;
        for (const control of Object.keys(controls)) controls[control] = false;
      },
    },
  );
  setBurning(bot, true);
  const world = new MemoryWorld();
  const load = (x: number, y: number, z: number) => {
    const at = new Vec3(x, y, z);
    world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
  };
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (let y = 62; y <= 68; y++) load(x, y, z);
  return { bot, world, cells, controls, cleared, load };
}

/** Emit physics ticks one at a time, letting the escape's waits settle between them. */
async function physicsTicks(bot: Bot, count: number): Promise<void> {
  for (let tick = 0; tick < count; tick++) {
    bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** The shared_flags metadata bit 0 the fire checks read as burning. */
function setBurning(bot: Bot, burning: boolean): void {
  Object.assign(bot.entity, { metadata: [burning ? 1 : 0] });
}

function watch(promise: Promise<FireEscapeOutcome>) {
  const seen: { outcome: FireEscapeOutcome | null } = { outcome: null };
  void promise.then((outcome) => (seen.outcome = outcome));
  return seen;
}

const anyMoveControl = (controls: Record<string, boolean>) =>
  ["forward", "back", "left", "right"].some((control) => controls[control]);

test("a burning bot on the bank keeps going while water is reachable", async () => {
  const { bot, world, controls } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(bot, 5);
  assert.equal(seen.outcome, null, "burning with water in reach is not settled");
  assert.equal(anyMoveControl(controls), true, "a move control is set toward the first cell of the way round");
  Object.assign(bot.entity, { isInWater: true });
  bot.entity.position.set(2.5, 64, 0.5);
  setBurning(bot, false);
  await physicsTicks(bot, 1);
  assert.equal(seen.outcome, "escaped");
});

test("fire out before arriving ends the escape", async () => {
  const { bot, world, controls, cleared } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(bot, 3);
  assert.equal(seen.outcome, null, "still burning with water in reach: the walk is on");
  assert.equal(anyMoveControl(controls), true, "a move control is set toward the way round");
  const clearedWhileWalking = cleared.count;
  setBurning(bot, false);
  await physicsTicks(bot, 2);
  assert.equal(seen.outcome, "escaped", "the flag cleared: ended within 2 ticks");
  assert.equal(anyMoveControl(controls), false);
  assert.ok(cleared.count > clearedWhileWalking, "the controls were cleared at the end");
});

test("water drained mid-route ends the walk", async () => {
  const { bot, world, cells, load } = burningOnTheBank();
  const escape = new AbortController();
  const seen = watch(escapeFire(bot, world, escape.signal));
  await physicsTicks(bot, 3);
  assert.equal(seen.outcome, null, "still walking to the water");
  cells["2,64,0"] = "stone";
  load(2, 64, 0);
  await physicsTicks(bot, 3);
  assert.equal(seen.outcome, "escaped", "dry ground and no water left: the same end as with no water");
});

test("a cancel mid-route stops at once", async () => {
  const { bot, world, cleared } = burningOnTheBank();
  const escape = new AbortController();
  const result = escapeFire(bot, world, escape.signal).then(
    () => "returned",
    (error: unknown) => error,
  );
  await physicsTicks(bot, 3);
  const before = cleared.count;
  escape.abort(new Error("cancelled by the test"));
  assert.match(String(await result), /cancelled by the test/);
  assert.ok(cleared.count > before, "the controls are released");
  assert.equal(bot.listenerCount("physicsTick"), 0, "no physics listener is left");
});

test("no physics ticks: the wall clock ends the escape", async () => {
  const { bot, world } = burningOnTheBank();
  const started = performance.now();
  const outcome = await escapeFire(bot, world, new AbortController().signal, "contact", { maximumMs: 50 });
  assert.equal(outcome, "timed_out", "the clock ended it: not the same as a walk with nowhere to go");
  assert.ok(performance.now() - started < 500, "returned within 500 ms without one physics tick");
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a death mid-route ends the escape as died", async () => {
  const { bot, world } = burningOnTheBank();
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  await physicsTicks(bot, 2);
  bot.health = 0;
  bot.emit("death");
  await physicsTicks(bot, 1);
  assert.equal(seen.outcome, "died");
  assert.equal(bot.listenerCount("death"), 0, "the death listener is removed");
  assert.equal(bot.listenerCount("respawn"), 0, "the respawn listener is removed");
});

test("no water in reach: escaped on dry ground as today", async () => {
  const { bot, world } = burningOnTheBank(new Vec3(-4.5, 65, 5.5));
  const outcome = await escapeFire(bot, world, new AbortController().signal);
  assert.equal(outcome, "escaped");
});

test("a burning bot goes on from cell to cell of the way round the lava", async () => {
  const { bot, world, controls } = burningOnTheBank();
  const seen = watch(escapeFire(bot, world, new AbortController().signal));
  for (const [x, z] of [[-0.5, 1.5], [0.5, 1.5], [1.5, 1.5], [1.5, 0.5]] as const) {
    await physicsTicks(bot, 2);
    assert.equal(seen.outcome, null, `still walking before (${x}, ${z})`);
    bot.entity.position.set(x, 65, z);
  }
  await physicsTicks(bot, 2);
  assert.equal(seen.outcome, null, "on the bank beside the water, still burning");
  assert.equal(anyMoveControl(controls), true);
  Object.assign(bot.entity, { isInWater: true });
  bot.entity.position.set(2.5, 64, 0.5);
  setBurning(bot, false);
  await physicsTicks(bot, 1);
  assert.equal(seen.outcome, "escaped");
});
