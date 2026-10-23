import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { type FakeClock, createFakeBot } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { FootingRecovery } from "./footing.js";

/** Physics ticks `clock` runs until `pending` settles (at most `max`), as Mineflayer's ticks would drive it. */
async function ticksUntilSettled(clock: FakeClock, pending: Promise<unknown>, max = 20): Promise<number> {
  const settled = watch(pending);
  let ticks = 0;
  while (!settled.over && ticks < max) {
    await clock.advance(50);
    ticks++;
  }
  return ticks;
}

function fixture(wide = false) {
  const world = new MemoryWorld();
  for (let x = -3; x <= 5; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 46; y <= 49; y++) world.load({ x, y, z }, { stateId: y === 46 && (wide || x === 0) ? 1 : 0 });
  // The recovery reads its geometry from `world`; the fake bot's own cells are open air, so its ticks always run.
  const harness = createFakeBot({
    position: new Vec3(0.8, 47, 0.5),
    groundY: null,
    // Not on the shared fake until M1 merges: the release of item use (a packet, no answer).
    overrides: { deactivateItem: () => undefined },
  });
  const { bot } = harness;
  const entity = bot.entity;
  const controls = new Map<string, boolean>();
  bot.setControlState = (name, value) => void controls.set(name, value);
  bot.clearControlStates = () => controls.clear();
  /** What the server and the body do on each physics tick, before the recovery hears it; nothing until a test says. */
  let onTick = () => {};
  bot.on("physicsTick", () => onTick());
  const impulse = (entityId = 1) =>
    bot._client.emit("entity_velocity", { entityId, velocity: { x: 2125, y: 2201, z: 0 } });
  return {
    ...harness,
    world,
    entity,
    controls,
    impulse,
    onEachTick: (script: () => void) => {
      onTick = script;
    },
  };
}

test("an edge alone, another entity's impulse, and an impulse over wide safe ground all leave movement alone", async () => {
  for (const row of [
    { name: "standing on an edge, with someone else's impulse", wide: false, entityId: 2 },
    { name: "a native impulse over wide safe ground", wide: true, entityId: 1 },
  ]) {
    const fixtureBot = fixture(row.wide);
    using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
    await fixtureBot.clock.advance(50);
    fixtureBot.impulse(row.entityId);
    assert.equal(recovery.needed, false, row.name);
    assert.equal(fixtureBot.controls.size, 0, row.name);
  }
});

test("an idle edge hit retains the departure support after the bot becomes airborne", async () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  fixtureBot.entity.onGround = false;
  fixtureBot.entity.position.x = 1.2;
  await fixtureBot.clock.advance(50);
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
  assert.equal(fixtureBot.controls.size, 0, "observation never drives before a body owner calls recover");
});

test("missing catching geometry reports failure and releases movement instead of claiming a landing", async () => {
  const fixtureBot = fixture();
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.impulse();
  fixtureBot.onEachTick(() => {
    fixtureBot.entity.position.y = 46.9;
    fixtureBot.entity.onGround = false;
  });
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(fixtureBot.clock, recovered);
  assert.equal(await recovered, "failed");
  assert.equal(recovery.snapshot()?.phase, "failed");
  assert.equal(recovery.active, false);
  assert.equal(fixtureBot.controls.size, 0);
});

test("an observed lower terrace preserves protection and resumes only after actual landing", async () => {
  const f = fixture();
  f.world.load({ x: 1, y: 45, z: 0 }, { stateId: 1 });
  f.world.load({ x: 1, y: 44, z: 0 }, { stateId: 1 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.entity.position.x = 1.5;
  f.entity.position.y = 51;
  await f.clock.advance(50);
  let ticks = 0;
  let protection = 0;
  f.bot.deactivateItem = () => assert.fail("landing must not reset its continuing combat owner's shield readiness");
  f.onEachTick(() => {
    ticks++;
    f.entity.position.y = ticks === 1 ? 46.9 : 46;
    f.entity.onGround = ticks > 1;
  });
  const recovered = recovery.recover(new AbortController().signal, async () => { protection++; });
  await ticksUntilSettled(f.clock, recovered);
  assert.equal(await recovered, "landed");
  assert.ok(protection >= 2);
  assert.equal(ticks, 2, "a predicted landing alone must not resume the request");
  assert.equal(f.controls.size, 0);
});

test("a blast-broken floor can steer onto the adjacent lower cell before releasing the request", async () => {
  const f = fixture();
  for (let y = 44; y <= 46; y++) f.world.load({ x: 1, y, z: 0 }, { stateId: y === 45 ? 1 : 0 });
  using recovery = new FootingRecovery(f.bot, f.world);
  f.impulse();
  f.world.load({ x: 0, y: 46, z: 0 }, { stateId: 0 });
  f.entity.position = new Vec3(0.85, 46.9, 0.5);
  f.entity.velocity = new Vec3(0.04, -0.23, 0);
  f.entity.onGround = false;
  let ticks = 0;
  f.onEachTick(() => {
    ticks++;
    if (ticks === 2) {
      assert.equal(recovery.snapshot()?.phase, "steering", "the projected edge is not a terminal failure");
      f.entity.position = new Vec3(1.5, 46, 0.5);
      f.entity.velocity = new Vec3(0, 0, 0);
      f.entity.onGround = true;
    }
  });
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(f.clock, recovered);
  assert.equal(await recovered, "landed");
  assert.equal(ticks, 2);
});

test("a grounded body overlapping lava retains its last safe scaffold for the next impulse", async () => {
  const fixtureBot = fixture();
  fixtureBot.entity.position.x = 0.5;
  fixtureBot.world.load({ x: 1, y: 46, z: 0 }, { stateId: 0, traits: { liquid: "lava", damaging: true } });
  using recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.entity.position.x = 0.95;
  await fixtureBot.clock.advance(50);
  fixtureBot.impulse();
  assert.equal(recovery.needed, true);
  assert.deepEqual(recovery.snapshot()?.support, { x: 0, y: 47, z: 0 });
});

test("death interrupts recovery and disposal removes its observation listeners", async () => {
  const fixtureBot = fixture();
  const tickListeners = fixtureBot.bot.listenerCount("physicsTick");
  const recovery = new FootingRecovery(fixtureBot.bot, fixtureBot.world);
  fixtureBot.onEachTick(() => {
    fixtureBot.bot.emit("death");
  });
  fixtureBot.impulse();
  const recovered = recovery.recover(new AbortController().signal);
  await ticksUntilSettled(fixtureBot.clock, recovered);
  await assert.rejects(recovered);
  assert.equal(recovery.snapshot()?.phase, "cancelled");
  assert.equal(recovery.active, false);
  assert.equal(fixtureBot.controls.size, 0);
  recovery[Symbol.dispose]();
  assert.equal(fixtureBot.bot.listenerCount("physicsTick"), tickListeners);
  assert.equal(fixtureBot.bot._client.listenerCount("entity_velocity"), 0);
});
