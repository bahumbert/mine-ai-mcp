import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { actionResultSchema, defineAction } from "../../actions/index.js";
import { holdWaterPosition, waterStancesHeld } from "../../navigation/steering/hold-water-position.js";
import type { ActionRunner } from "../../session/action-runner.js";
import { waterFixture } from "../../test-support/water.js";
import { attachIdleWaterControl } from "./idle-water.js";

// The working mode: a foreground action owns the body and stands in water; the idle mode is in idle-water.test.ts.

type Fixture = ReturnType<typeof waterFixture>;
const EYES_IN_WATER = 65;
const EYES_OUT_OF_WATER = 64;
const noRoute = { active: false, steering: false };

/** Water fills every cell up to `topCell`; the fixture bot's feet are in cell 64 and its eyes in cell 65. */
function waterUpTo(fixture: Fixture, topCell: number) {
  Object.assign(fixture.bot, {
    blockAt: (cell: Vec3) => ({ name: cell.y <= topCell ? "water" : "air", getProperties: () => ({}) }),
  });
}

const turns = (count = 50) => Array.from({ length: count }, () => new Promise((resolve) => setImmediate(resolve)));
async function untilOwner(runner: ActionRunner, owner: string) {
  for (let turn = 0; turn < 50 && runner.status().owner !== owner; turn += 1) await Promise.all(turns(1));
  assert.equal(runner.status().owner, owner);
}

/** A foreground action that works until `end()`; a reflex's `resume` verdict runs it again. */
async function foregroundAction(runner: ActionRunner) {
  let finish!: () => void;
  const ended = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const action = defineAction({
    name: "standing_task",
    description: "Stands in the water while it works",
    inputSchema: z.object({}),
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: () => ({}),
    execution: { kind: "resumable_task" },
    begin: () => async ({ signal }) => {
      await new Promise<void>((resolve) => {
        void ended.then(resolve);
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return signal?.aborted ? { status: "partial" as const, error: "preempted" } : { status: "succeeded" as const };
    },
  });
  const pending = runner.run(action, {});
  await untilOwner(runner, "foreground");
  return {
    end: async () => {
      finish();
      await pending;
    },
  };
}

const writesOf = (fixture: Fixture, name: string) => fixture.controls.filter(([control]) => control === name);

/** Navigation as the working mode asks it: `active` (a route) and the broader `steering` (a route or a held stance). */
function navigationWith(stance: () => boolean = () => false) {
  const state = { route: false };
  return {
    state,
    navigation: {
      get active() {
        return state.route;
      },
      get steering() {
        return state.route || stance();
      },
    },
  };
}

test("working in water with the eyes under it presses jump, and lets go once the eyes are out", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);

  assert.deepEqual(fixture.controls, [], "no physics tick yet (a stalled clock): nothing is written");
  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true]]);
  waterUpTo(fixture, EYES_OUT_OF_WATER);
  fixture.bot.emit("physicsTick");
  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true], ["jump", false]], "released once, not every tick");

  await action.end();
  await control[Symbol.dispose]();
});

test("a worker standing in shallow water with its eyes out is left alone", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_OUT_OF_WATER);
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);

  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");

  assert.deepEqual(fixture.controls, []);
  await action.end();
  await control[Symbol.dispose]();
});

test("the working mode holds its place against the current while it floats", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);

  fixture.bot.emit("physicsTick");
  fixture.entity.position.x += 0.3;
  fixture.bot.emit("physicsTick");

  assert.ok(fixture.controls.some(([key, active]) => key === "left" && active), "pushed back toward the anchor");
  await action.end();
  await control[Symbol.dispose]();
});

test("the working mode relinquishes without writing false when navigation starts, and holds again after it", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const { state, navigation } = navigationWith();
  const control = attachIdleWaterControl(fixture.bot, navigation, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);

  fixture.bot.emit("physicsTick");
  state.route = true;
  const before = fixture.controls.length;
  for (let tick = 0; tick < 3; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, before, "the route's controls are not overwritten");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true]]);

  state.route = false;
  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true], ["jump", true]], "holds again once the route ended");
  await action.end();
  await control[Symbol.dispose]();
});

test("a held water stance keeps the working mode from writing, a released one lets it hold again", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const { navigation } = navigationWith(() => waterStancesHeld(fixture.bot) > 0);
  const control = attachIdleWaterControl(fixture.bot, navigation, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);

  const releaseStance = holdWaterPosition(fixture.bot, undefined, () => {});
  for (let tick = 0; tick < 3; tick++) fixture.bot.emit("physicsTick");
  assert.deepEqual(fixture.controls, [], "underwater mining keeps its own depth");
  releaseStance();
  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true]]);
  await action.end();
  await control[Symbol.dispose]();
});

test("a reflex that holds the body gets no writes from the working mode, which holds again afterwards", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);
  fixture.bot.emit("physicsTick");

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const claim = fixture.reflex.runner.claim("test_reflex", "holds the body", async () => {
    await held;
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  await untilOwner(fixture.reflex.runner, "takeover");
  const before = fixture.controls.length;
  for (let tick = 0; tick < 3; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, before);

  release();
  if (claim.kind === "claimed") await claim.outcome;
  await untilOwner(fixture.reflex.runner, "foreground");
  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true], ["jump", true]]);
  await action.end();
  await control[Symbol.dispose]();
});

test("a body that yields its action's cleanup to a reflex is not written to", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const yielding = {
    status: () => ({ owner: "yielding" }),
    holdBaseline: () => false,
    releaseBaseline: () => {},
  } as unknown as ActionRunner;
  const control = attachIdleWaterControl(fixture.bot, noRoute, yielding);

  for (let tick = 0; tick < 3; tick++) fixture.bot.emit("physicsTick");

  assert.deepEqual(fixture.controls, []);
  await control[Symbol.dispose]();
});

test("the idle mode takes over from the working mode without a tick where jump drops", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);
  fixture.bot.emit("physicsTick");

  await action.end();
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  fixture.bot.emit("physicsTick");
  fixture.bot.emit("physicsTick");

  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true], ["jump", true], ["jump", true]]);
  await control[Symbol.dispose]();
  assert.deepEqual(writesOf(fixture, "jump").at(-1), ["jump", false], "released with the attachment");
});

test("a bot afloat when its action ends is held by the idle mode, and the next admission releases that hold", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_OUT_OF_WATER);
  fixture.entity.isInWater = true;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const first = await foregroundAction(fixture.reflex.runner);
  await first.end();

  fixture.bot.emit("physicsTick");
  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true]], "afloat at the surface: held");
  assert.equal(fixture.reflex.runner.status().owner, "idle");

  const before = fixture.controls.length;
  const second = await foregroundAction(fixture.reflex.runner);
  assert.ok(
    fixture.controls.slice(before).some(([, active]) => !active),
    "admission released the idle hold before the next owner",
  );
  await second.end();
  await control[Symbol.dispose]();
});

test("when the action ends dry, the working mode clears the controls it set", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_IN_WATER);
  fixture.entity.isInWater = true;
  fixture.entity.onGround = false;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);
  fixture.bot.emit("physicsTick");

  await action.end();
  fixture.entity.isInWater = false;
  fixture.entity.onGround = true;
  fixture.bot.emit("physicsTick");
  fixture.bot.emit("physicsTick");

  assert.deepEqual(writesOf(fixture, "jump"), [["jump", true], ["jump", false]]);
  const cleared = new Set(fixture.controls.filter(([, active]) => !active).map(([key]) => key));
  assert.deepEqual([...cleared].sort(), ["back", "forward", "jump", "left", "right"]);
  await control[Symbol.dispose]();
});

test("a worker that never wrote a control does not clear anyone else's when its action ends", async (t) => {
  const fixture = waterFixture(t);
  waterUpTo(fixture, EYES_OUT_OF_WATER);
  fixture.entity.isInWater = false;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);
  fixture.bot.emit("physicsTick");
  await action.end();
  fixture.bot.emit("physicsTick");

  assert.deepEqual(fixture.controls, []);
  await control[Symbol.dispose]();
});

test("each bot's working mode follows its own water", async (t) => {
  const wet = waterFixture(t);
  const dry = waterFixture(t);
  waterUpTo(wet, EYES_IN_WATER);
  waterUpTo(dry, EYES_OUT_OF_WATER);
  wet.entity.isInWater = true;
  const controls = [wet, dry].map((fixture) => attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner));
  const actions = await Promise.all([wet, dry].map((fixture) => foregroundAction(fixture.reflex.runner)));

  wet.bot.emit("physicsTick");
  dry.bot.emit("physicsTick");

  assert.deepEqual(writesOf(wet, "jump"), [["jump", true]]);
  assert.deepEqual(dry.controls, []);
  await Promise.all(actions.map((action) => action.end()));
  for (const control of controls) await control[Symbol.dispose]();
});

test("on dry land the working mode reads no cell on the ticks of a foreground action (backlog: idle-water eye cell)", async (t) => {
  const fixture = waterFixture(t);
  let reads = 0;
  Object.assign(fixture.bot, { blockAt: () => { reads += 1; return { name: "air", getProperties: () => ({}) }; } });
  fixture.entity.isInWater = false;
  const control = attachIdleWaterControl(fixture.bot, noRoute, fixture.reflex.runner);
  const action = await foregroundAction(fixture.reflex.runner);
  reads = 0;
  for (let tick = 0; tick < 20; tick++) fixture.bot.emit("physicsTick");
  assert.equal(reads, 0);
  await action.end();
  await control[Symbol.dispose]();
});
