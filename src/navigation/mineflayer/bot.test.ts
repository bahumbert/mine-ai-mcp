import { installNetherVinePhysics, MineflayerBot, mineflayerBotSurface, type MineflayerBotSurface } from "./bot.js";
import { waterStancesHeld } from "../steering/hold-water-position.js";
import { observeNavigationDigs, type NavigationDig } from "./dig-observer.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../world/memory-world.js";
import type { Position3 } from "../world/world.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeBot, createFakeClock, flush } from "../../test-support/fake-bot/index.js";
import { executeBotMovement, movementStep } from "../../test-support/navigation.js";
import { watch } from "../../test-support/pending.js";
import type { PlannedOperation } from "../movements/movement.js";

/** A Mineflayer surface that does nothing, standing on the origin, with the given parts replaced. */
function surface(overrides: Partial<MineflayerBotSurface>): MineflayerBotSurface {
  return {
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false },
    game: { dimension: "overworld" },
    entities: {},
    inventory: { items: () => [] },
    setControlState: () => undefined,
    holdWaterStance: () => () => undefined,
    waitForTicks: async () => undefined,
    lookAt: async () => undefined,
    equip: async () => undefined,
    blockAt: () => null,
    visibleDigAim: (position) => ({ x: position.x + 0.5, y: position.y + 0.5, z: position.z + 0.5 }),
    dig: async () => undefined,
    stopDigging: () => undefined,
    placementObstacle: () => null,
    placeBlock: async () => undefined,
    activateBlock: async () => undefined,
    on: () => undefined,
    off: () => undefined,
    ...overrides,
  };
}

/** A real shared-fake world and dig, with preparation ports controlled by each race test. */
function edgeDig() {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(0.85, 63, 0.5), groundY: null,
    cells: { "1,62,0": "stone" }, carried: { stone_pickaxe: 1 },
  });
  const live = mineflayerBotSurface(harness.bot);
  let digs = 0;
  let holds = 0;
  let reports = 0;
  const port = surface({
    ...live,
    // The shared fake's dig models Mineflayer's prediction, not a server block-change packet.
    watchServerChange: undefined,
    lookAt: async () => {}, look: async () => {},
    holdWaterStance: (_signal, control) => {
      holds++;
      control("left", true);
      return () => { holds--; control("left", false); };
    },
    dig: async (block, force) => { digs++; await live.dig(block, force); },
    reportDig: () => { reports++; },
  });
  const actuator = new MineflayerBot(port, { revision: 1 });
  const operation: Extract<PlannedOperation, { kind: "break" }> = {
    kind: "break", position: { x: 1, y: 62, z: 0 },
    expectedStateId: harness.bot.registry.blocksByName.stone!.defaultState!, toolType: null, brings: [],
  };
  const start = (changes: Partial<typeof operation> = {}, signal = new AbortController().signal) =>
    actuator.startEffect({ ...operation, ...changes }, { runId: "run", planId: "plan", stepId: "edge", attempt: 1 }, signal);
  const clean = () => {
    assert.equal(holds, 0);
    assert.equal(actuator.ownedControlCount, 0);
    assert.equal(harness.bot._client.listenerCount("block_change"), 0);
  };
  return { ...harness, port, actuator, operation, start, clean, counts: () => ({ digs, reports }) };
}

for (const floor of ["air", "void", "stone"] as const) {
  test(`physical edge admission reads ${floor} alternative support before swinging`, async () => {
    for (const { y, cellY, block } of [
      { y: 64.0, cellY: 63, block: "stone" },
      ...(floor === "stone" ? [] : [{ y: 64.5, cellY: 64, block: "oak_slab" }]),
    ]) {
      const run = edgeDig();
      using _clock = run.clock.install();
      run.bot.entity.position.y = y;
      run.world.setCell(new Vec3(1, cellY, 0), block);
      run.world.setCell(new Vec3(0, cellY, 0), floor);
      const effect = run.start({ position: { x: 1, y: cellY, z: 0 }, expectedStateId: run.bot.registry.blocksByName[block]!.defaultState! });
      const result = await run.clock.settle(effect.completion, 10_000);
      assert.equal(result.kind, floor === "stone" ? "accepted" : "failed", JSON.stringify({ y, result }));
      if (result.kind === "failed") assert.equal(result.cause, "support");
      assert.equal(effect.issued, floor === "stone");
      assert.deepEqual(run.counts(), floor === "stone" ? { digs: 1, reports: 1 } : { digs: 0, reports: 0 });
      run.clean();
    }
  });
}

for (const preparation of ["equip", "hold", "landing", "look", "centring", "corner"] as const) {
  test(`support lost during ${preparation} is refused and the next safe-bank dig succeeds`, async () => {
    const run = edgeDig();
    using _clock = run.clock.install();
    run.world.setCell(new Vec3(0, 62, 0), "stone");
    const loseSupport = () => run.world.setCell(new Vec3(0, 62, 0), "air");
    if (preparation === "equip") run.port.equip = async () => { loseSupport(); };
    if (preparation === "hold") {
      const hold = run.port.holdWaterStance;
      run.port.holdWaterStance = (...args) => { loseSupport(); return hold(...args); };
    }
    if (preparation === "landing") run.port.landOnStanceFloor = async () => { loseSupport(); return true; };
    if (preparation === "look") run.port.lookAt = async () => { loseSupport(); };
    if (preparation === "centring") {
      let aims = 0;
      run.port.visibleDigAim = () => ++aims === 1 ? null : { x: 1.5, y: 62.5, z: 0.5 };
      run.actuator.centerOnCell = async () => { loseSupport(); return true; };
    }
    if (preparation === "corner") {
      run.bot.entity.position.z = 0.85;
      loseSupport();
      run.world.setCell(new Vec3(1, 62, 1), "stone");
      run.port.lookAt = async () => { run.bot.entity.position.z = 0.5; };
    }
    const effect = run.start({
      toolType: preparation === "equip" ? run.inventory.items()[0]!.type : null,
      ...(preparation === "landing" ? { stance: { x: 0, y: 63, z: 0 } } : {}),
    });
    const refused = await run.clock.settle(effect.completion, 10_000);
    assert.equal(refused.kind === "failed" && refused.cause, "support");
    assert.equal(effect.issued, false);
    assert.deepEqual(run.counts(), { digs: 0, reports: 0 });
    assert.equal(run.world.blockAt(new Vec3(1, 62, 0))!.name, "stone");
    run.clean();
    run.bot.entity.position.set(1.5, 63, 0.5);
    run.world.setCell(new Vec3(2, 62, 0), "stone");
    const next = run.start({ position: { x: 2, y: 62, z: 0 } });
    assert.deepEqual(await run.clock.settle(next.completion, 10_000), { kind: "accepted" });
    run.clean();
  });
}

test("replacement support and floating work remain admitted; centred descent only refuses retained support", async () => {
  for (const mode of ["replacement", "floating", "centred", "retained"] as const) {
    const run = edgeDig();
    using _clock = run.clock.install();
    if (mode === "replacement") {
      run.world.setCell(new Vec3(0, 62, 0), "stone");
      run.port.lookAt = async () => run.world.setCell(new Vec3(0, 62, 0), "dirt");
    }
    if (mode === "floating") Object.assign(run.bot.entity, { onGround: false, isInWater: true });
    if (mode === "centred" || mode === "retained") run.bot.entity.position.x = 1.5;
    const effect = run.start({ retainSupport: mode === "retained" });
    const result = await run.clock.settle(effect.completion, 60_000);
    assert.equal(result.kind, mode === "retained" ? "failed" : "accepted", mode);
    if (result.kind === "failed") assert.equal(result.cause, "support");
    assert.equal(run.counts().digs, mode === "retained" ? 0 : 1, mode);
    run.clean();
  }
});

test("a falling refill rechecks live support and retains the first swing's issued receipt", async () => {
  const run = edgeDig();
  using _clock = run.clock.install();
  run.world.setCell(new Vec3(0, 62, 0), "stone");
  run.port.waitForTicks = async () => {
    run.world.setCell(new Vec3(0, 62, 0), "air");
    run.world.setCell(new Vec3(1, 62, 0), "sand");
  };
  const effect = run.start({ brings: [{ x: 1, y: 63, z: 0 }] });
  const result = await run.clock.settle(effect.completion, 10_000);
  assert.equal(result.kind === "failed" && result.cause, "support");
  assert.equal(effect.issued, true);
  assert.deepEqual(run.counts(), { digs: 1, reports: 1 });
  run.clean();
});

test("cancel or death during awaited aiming prevents a swing and releases watches and controls", async () => {
  for (const reason of ["cancel", "death", "handle cancel"]) {
    const run = edgeDig();
    using _clock = run.clock.install();
    if (reason !== "handle cancel") run.port.watchServerChange = mineflayerBotSurface(run.bot).watchServerChange;
    run.world.setCell(new Vec3(0, 62, 0), "stone");
    const controller = new AbortController();
    run.port.lookAt = async () => {
      if (reason === "handle cancel") effect.cancel();
      else controller.abort(new Error(reason));
    };
    const effect = run.start({}, controller.signal);
    const result = await run.clock.settle(effect.completion, 10_000);
    assert.equal(result.kind, "failed");
    assert.equal(effect.issued, false);
    assert.equal(run.counts().digs, 0);
    run.clean();
  }
});

test("the pinned physics compatibility restores Nether vine ascent and descent velocity", () => {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },
    velocity: { x: 0.3, y: -0.23, z: -0.3 },
    isCollidedHorizontally: false,
    onGround: false,
    isInWater: false,
  };
  let tick: () => void = () => undefined;
  let velocityPacket: () => void = () => undefined;
  let jump = false;
  let sneak = false;
  let block = "twisting_vines_plant";
  const bot = surface({
    entity,
    blockAt: () => ({ name: block }),
    getControlState: (control) => (control === "jump" ? jump : sneak),
    on: (_event, listener) => {
      tick = listener;
    },
    onSelfVelocity: (listener) => {
      velocityPacket = listener;
      return () => {
        velocityPacket = () => undefined;
      };
    },
  });
  const release = installNetherVinePhysics(bot);

  tick();
  assert.equal(entity.velocity.y, -0.15);
  assert.ok(Math.abs(entity.velocity.x - 0.1365) < 1e-12);
  assert.ok(Math.abs(entity.velocity.z + 0.1365) < 1e-12);
  entity.velocity.x = -0.32;
  velocityPacket();
  assert.ok(Math.abs(entity.velocity.x + 0.1365) < 1e-12, "a between-tick knockback is capped before it moves");
  jump = true;
  tick();
  assert.ok(Math.abs(entity.velocity.y - 0.1176) < 1e-12);
  jump = false;
  sneak = true;
  entity.velocity.y = -0.1;
  tick();
  assert.equal(entity.velocity.y, 0);
  sneak = false;
  entity.isCollidedHorizontally = true;
  entity.velocity.y = -0.15;
  tick();
  assert.ok(Math.abs(entity.velocity.y - 0.1176) < 1e-12, "horizontal collision climbs without jump");
  block = "air";
  entity.velocity = { x: 0.3, y: -0.23, z: -0.3 };
  tick();
  assert.deepEqual(entity.velocity, { x: 0.3, y: -0.23, z: -0.3 }, "non-vines retain pinned physics velocity");
  release();
});

test("water touching the body is a swimming stance even when its feet and head cells are air", () => {
  const entity = { position: { x: 0.3, y: 63.06, z: 0.7545 }, onGround: false, isInWater: true };
  const bot = surface({ entity, blockAt: () => ({ name: "air" }), visibleDigAim: () => null });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  assert.equal(actuator.observe().stance, "swimming");
  entity.onGround = true;
  assert.equal(actuator.observe().stance, "supported");
  entity.onGround = false;
  entity.isInWater = false;
  assert.equal(actuator.observe().stance, "airborne");
});

test("the Mineflayer actuator passes Vec3 positions to the runtime", async () => {
  const position = { x: 0.5, y: 63, z: 0.5 };
  let lookedAt: Vec3 | undefined;
  const bot = surface({
    entity: { position, onGround: true, isInWater: false },
    waitForTicks: async () => {
      position.x = 1.5;
    },
    lookAt: async (target) => {
      assert.equal(target instanceof Vec3, true);
      lookedAt = target as Vec3;
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 });
  const result = await executeBotMovement(actuator, step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.deepEqual(lookedAt, new Vec3(1.5, 64, 0.5));
});

test("a step whose centre the body has already passed keeps the current heading", async () => {
  // Handed over 0.1 past the target centre, the old aim looked back at it and
  // the bot turned around; the heading now stays where the last step left it.
  const position = { x: 1.6, y: 63, z: 0.5 };
  let lookedAt = 0;
  const bot = surface({
    entity: { position, onGround: true, isInWater: false, yaw: 0 },
    lookAt: async () => {
      lookedAt += 1;
    },
    visibleDigAim: () => null,
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }, { id: "overshot-walk" });
  const result = await executeBotMovement(actuator, step, { end: "continuous" });
  assert.equal(result.kind, "completed");
  assert.equal(lookedAt, 0);
});

test("the Mineflayer actuator accepts a settled landing on partial-height support", async () => {
  const position = { x: 0.01, y: 62.875, z: 0.99 };
  const bot = surface({ entity: { position, onGround: true, isInWater: false } });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const step = movementStep("step_up", { x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }, { id: "settled-corner" });
  const result = await executeBotMovement(actuator, step, { end: "settled" });
  assert.equal(result.kind, "completed");
});

test("digging straight down keeps the current yaw and owns its own aim", async () => {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },

    onGround: true,
    isInWater: false,
    climbing: false,
    yaw: 1.23,
    pitch: 0,
  };
  const looks: { yaw: number; pitch: number }[] = [];
  let digForceLook: unknown = "unset";
  let lookedAtCalls = 0;
  const bot = surface({
    entity,
    lookAt: async () => {
      lookedAtCalls += 1;
    },
    look: async (yaw, pitch) => {
      looks.push({ yaw, pitch });
    },
    blockAt: () => ({ name: "stone" }),
    dig: async (_block, forceLook) => {
      digForceLook = forceLook;
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "downward", attempt: 1 },
    new AbortController().signal,
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  // Yaw is meaningless for a block directly below, so it must be carried
  // through rather than recomputed; recomputing it spins the bot every dig.
  assert.deepEqual(looks, [{ yaw: 1.23, pitch: -Math.PI / 2 }]);
  assert.equal(entity.yaw, 1.23);
  // And Mineflayer must not re-aim afterwards, or the fix is undone.
  assert.equal(digForceLook, "ignore");
  assert.equal(lookedAtCalls, 0);
});

test("a break planned from a water stance holds that floor and lands on it before the swing; one with none swings at once", async () => {
  // lava-interrupts-mining under load: the body at -59.62 over its floor at -60 dug obsidian x5 slower off the ground.
  for (const stance of [{ x: 2, y: -60, z: 0 }, undefined]) {
    const events: string[] = [];
    const stances: unknown[] = [];
    const bot = surface({
      entity: { position: { x: 2.7, y: -59.62, z: 0.5 }, onGround: false, isInWater: true, yaw: 0 },
      holdWaterStance: (_signal, _setControl, held) => {
        stances.push(held);
        return () => undefined;
      },
      // A landing that ran out: the dig still goes ahead.
      landOnStanceFloor: async (at) => (events.push(`land ${at.x},${at.y},${at.z}`), false),
      blockAt: () => ({ name: "obsidian" }),
      dig: async () => void events.push("dig"),
    });
    const effect = new MineflayerBot(bot, { revision: 1 }).startEffect(
      { kind: "break", position: { x: 2, y: -59, z: 1 }, expectedStateId: 1, toolType: null, brings: [], ...(stance && { stance }) },
      { runId: "run", planId: "plan", stepId: "excavate", attempt: 1 },
      new AbortController().signal,
    );
    assert.deepEqual(await effect.completion, { kind: "accepted" });
    assert.deepEqual(stances, [stance], "the hold is given the planned stance");
    assert.deepEqual(events, stance ? ["land 2,-60,0", "dig"] : ["dig"]);
  }
});

test("a dig at the edge of reach centres on the stance search judged it from before giving up", async () => {
  // Search prices reach and sight from the centre of the stance cell; the body
  // can stop at its corner, which puts the same face out of reach.
  const entity = { position: { x: 0.1, y: 63, z: 0.9 }, onGround: true, isInWater: false, yaw: 0 };
  const centred = () => Math.hypot(entity.position.x - 0.5, entity.position.z - 0.5) <= 0.17;
  let dug = 0;
  const bot = surface({
    entity,
    blockAt: () => ({ name: "sand" }),
    waitForTicks: async () => {
      entity.position = { x: 0.5, y: 63, z: 0.5 };
    },
    visibleDigAim: (position) => (centred() ? { x: position.x + 0.5, y: position.y, z: position.z + 0.5 } : null),
    dig: async () => {
      dug += 1;
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    { kind: "break", position: { x: 4, y: 65, z: 3 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "edge-of-reach", attempt: 1 },
    new AbortController().signal,
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(dug, 1);
});

test("stationary water controls release after a failed dig and when the search releases its hold", async () => {
  const entity = { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: true, yaw: 0 };
  const controls = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  const bot = surface({
    entity,
    setControlState: (control, state) => {
      controls.set(control, state);
    },
    lookAt: async () => {
      throw new Error("stance correction must preserve the dig aim");
    },
    blockAt: () => ({ name: "obsidian" }),
    dig: async () => {
      entity.position.x = 0.9;
      for (const listener of listeners) listener();
      assert.equal(controls.get("left"), true);
      assert.equal(controls.get("right"), false);
      throw new Error("dig interrupted");
    },
    on: (_event, listener) => {
      listeners.add(listener);
    },
    off: (_event, listener) => {
      listeners.delete(listener);
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    { kind: "break", position: { x: 1, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "obsidian", attempt: 1 },
    new AbortController().signal,
  );
  assert.equal((await effect.completion).kind, "failed");
  assert.equal(actuator.ownedControlCount, 0);
  assert.equal(listeners.size, 0);
  const release = actuator.holdPosition(new MemoryWorld());
  for (const listener of listeners) listener();
  assert.equal(controls.get("jump"), true);
  release();
  assert.equal(controls.get("jump"), false);
  assert.equal(actuator.ownedControlCount, 0);
  assert.equal(listeners.size, 0);
});

test("a break that brings sand down waits for it to land and breaks it again before completing", async () => {
  // The cell holds sand; the first dig clears it; two ticks later the sand
  // from above lands in it; the second dig clears it for good.
  let cell = "sand";
  let ticksSinceDig = 0;
  let digs = 0;
  const bot = surface({
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false, yaw: 0 },
    waitForTicks: async () => {
      ticksSinceDig += 1;
      if (digs === 1 && ticksSinceDig === 2) cell = "sand";
    },
    blockAt: () => ({ name: cell }),
    dig: async () => {
      digs += 1;
      ticksSinceDig = 0;
      cell = "air";
    },
  });
  const actuator = new MineflayerBot(bot, { revision: 1 });
  const effect = actuator.startEffect(
    {
      kind: "break",
      position: { x: 1, y: 64, z: 0 },
      expectedStateId: 1,
      toolType: null,
      brings: [{ x: 1, y: 65, z: 0 }],
    },
    { runId: "run", planId: "plan", stepId: "plug", attempt: 1 },
    new AbortController().signal,
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(digs, 2);
  assert.equal(cell, "air");
});

/**
 * A tick wait of a bot whose physics stopped after `ticksBeforeStop` ticks (a death turns physics off, `physics.js:480`):
 * it ends only on the signal the effect gave it. Without that signal it waits for ever, as Mineflayer's own wait does
 * until its `ticks * 50 + 5000` ms timeout (`physics.js:462`).
 */
function physicsStoppingAfter(ticksBeforeStop: number) {
  let ticks = 0;
  return async (_ticks: number, signal?: AbortSignal): Promise<void> => {
    if (ticks++ < ticksBeforeStop) return;
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

test("the surface's tick wait on a connected bot ends at the signal's abort when physics has stopped, and on the tick otherwise", async () => {
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 64, 0.5) });
  const surfaceOfBot = mineflayerBotSurface(bot);
  await clock.settle(surfaceOfBot.waitForTicks(2, new AbortController().signal), 1_000);

  bot.physicsEnabled = false; // a death turns physics off (`physics.js:480`)
  const cancel = new AbortController();
  clock.after(100, () => cancel.abort(new Error("bot died")));
  await assert.rejects(clock.settle(surfaceOfBot.waitForTicks(1, cancel.signal), 1_000), /bot died/);
  assert.equal(bot.listenerCount("physicsTick"), 0, "the aborted wait left no tick listener");
});

test("a cancel ends the wait for a sand column to land at once when physics has stopped", async () => {
  const cancel = new AbortController();
  const bot = surface({
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false, yaw: 0 },
    waitForTicks: physicsStoppingAfter(0),
    blockAt: () => ({ name: "air" }),
  });
  const effect = new MineflayerBot(bot, { revision: 1 }).startEffect(
    { kind: "break", position: { x: 1, y: 64, z: 0 }, expectedStateId: 1, toolType: null, brings: [{ x: 1, y: 65, z: 0 }] },
    { runId: "run", planId: "plan", stepId: "plug", attempt: 1 },
    cancel.signal,
  );
  const ended = watch(effect.completion);
  await flush();
  assert.equal(ended.over, false, "the break waits for the sand to land");
  cancel.abort(new Error("bot died"));
  assert.deepEqual(await effect.completion, { kind: "failed", observation: "bot died" });
});

test("a cancel ends a pillar placement's waits at once when physics has stopped before and during the jump", async () => {
  for (const ticksBeforeStop of [0, 1]) {
    const cancel = new AbortController();
    const bot = surface({
      entity: { position: { x: 0.5, y: 63, z: 0.5 }, onGround: true, isInWater: false, yaw: 2.1 },
      inventory: { items: () => [{ type: 1, count: 1 }] },
      waitForTicks: physicsStoppingAfter(ticksBeforeStop),
      look: async () => undefined,
      blockAt: () => ({ name: "stone" }),
    });
    const effect = placeAt(new MineflayerBot(bot, { revision: 1 }), { x: 0, y: 63, z: 0 }, { x: 0, y: 62, z: 0 }, "pillar", cancel.signal);
    await flush();
    cancel.abort(new Error("bot died"));
    assert.deepEqual(await effect.completion, { kind: "failed", observation: "bot died" }, `physics stopped after ${ticksBeforeStop} ticks`);
  }
});
// ── Drops ────────────────────────────────────────────────────────────────────

/**
 * A ledge one block east: pressing forward carries the body 0.2 blocks a tick
 * while it is not sneaking, one tick of coast follows a release, and once the
 * feet pass x 1.2 the body falls a block and lands.
 */
function ledge() {
  const entity = {
    position: { x: 0.5, y: 63, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    isInWater: false,
    climbing: false,
    yaw: 0,
  };
  const held = { forward: false, sneak: true, sprint: false };
  let usedSprint = false;
  let coastTicks = 0;
  let releasedBeforeDescent = false;
  let lookedAt: Position3 | undefined;
  const bot = surface({
    entity,
    setControlState: (control, state) => {
      if (control === "forward") {
        if (!state && entity.position.y === 63) releasedBeforeDescent = true;
        if (!state && held.forward) coastTicks = 1;
      }
      if (control === "sprint") usedSprint ||= state;
      if (control in held) held[control as keyof typeof held] = state;
    },
    waitForTicks: async () => {
      if ((held.forward || coastTicks > 0) && !held.sneak) {
        entity.position.x += 0.2;
        if (!held.forward) coastTicks -= 1;
      }
      if (entity.position.y === 62.85) {
        entity.position.y = 62;
        entity.onGround = true;
      } else if (entity.position.x >= 1.2 && entity.position.y === 63) {
        entity.position.y = 62.85;
        entity.onGround = false;
      }
    },
    lookAt: async (target) => {
      lookedAt = target;
    },
  });
  return {
    actuator: new MineflayerBot(bot, { revision: 1 }),
    entity,
    held,
    landed: () => ({ y: entity.position.y, releasedBeforeDescent, sneaking: held.sneak, usedSprint, lookedAt }),
  };
}

const drop = (validArrivals: Position3[]) =>
  movementStep("drop", { x: 0, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }, { validArrivals, expectedTicks: 6 });

test("a drop keeps moving until the bot is over its lower landing, whether or not an overshoot cell would also do", async () => {
  for (const arrivals of [
    [
      { x: 1, y: 62, z: 0 },
      { x: 2, y: 62, z: 0 },
    ],
    [{ x: 1, y: 62, z: 0 }],
  ]) {
    const { actuator, landed } = ledge();
    const result = await executeBotMovement(actuator, drop(arrivals), { end: "settled" });
    assert.equal(result.kind, "completed");
    const after = landed();
    assert.equal(after.y, 62);
    assert.equal(after.releasedBeforeDescent, true, "forward is released before the descent");
    assert.equal(after.sneaking, false);
    assert.equal(after.usedSprint, false, "a drop never sprints");
    assert.ok(after.lookedAt);
    assert.ok(Math.abs(after.lookedAt.x - 1.33) < 1e-9);
    assert.equal(after.lookedAt.y, 63);
    assert.equal(after.lookedAt.z, 0.5);
  }

  // Already standing on the overshoot cell: that is a valid arrival, and it is reported as the one reached.
  const overshot = surface({ entity: { position: { x: 2.5, y: 62, z: 0.5 }, onGround: true, isInWater: false } });
  const result = await executeBotMovement(
    new MineflayerBot(overshot, { revision: 1 }),
    drop([
      { x: 1, y: 62, z: 0 },
      { x: 2, y: 62, z: 0 },
    ]),
    {
      end: "settled",
    },
  );
  assert.deepEqual(result, { kind: "completed", arrival: { x: 2, y: 62, z: 0 } });
});

test("a descent remains in flight beyond its optimistic route cost", async () => {
  const entity = {
    position: { x: 1.5, y: 63, z: 0.5 },
    velocity: { x: 0, y: -0.1, z: 0 },
    onGround: false,
    isInWater: false,
    climbing: false,
    yaw: 0,
  };
  let ticks = 0;
  const bot = surface({
    entity,
    waitForTicks: async () => {
      ticks += 1;
      entity.position.y -= 0.1;
      if (ticks === 25) {
        entity.position.y = 60;
        entity.onGround = true;
      }
    },
  });
  const step = movementStep("drop", { x: 1, y: 63, z: 0 }, { x: 1, y: 60, z: 0 }, { expectedTicks: 6 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.equal(ticks, 25);
});

// ── Digging straight down ────────────────────────────────────────────────────

/**
 * Move a fake bot the way prismarine-physics would: `forward` accelerates
 * along `(-sin(yaw), -cos(yaw))` and `right` along `(cos(yaw), -sin(yaw))`.
 *
 * Centring has to work through those four controls without rotating, so a
 * double that only understands `forward` cannot tell a working approach from
 * a stalled one.
 */
function applyHeading(position: { x: number; z: number }, held: ReadonlySet<string>, yaw: number): void {
  const ahead = (held.has("forward") ? 1 : 0) - (held.has("back") ? 1 : 0);
  const strafe = (held.has("right") ? 1 : 0) - (held.has("left") ? 1 : 0);
  position.x += (-ahead * Math.sin(yaw) + strafe * Math.cos(yaw)) * 0.1;
  position.z += (-ahead * Math.cos(yaw) - strafe * Math.sin(yaw)) * 0.1;
}

/** Controls as a set of the ones currently held, kept up to date by `setControlState`. */
function heldControls() {
  const held = new Set<string>();
  const setControlState = (control: string, state: boolean) => {
    if (state) held.add(control);
    else held.delete(control);
  };
  return { held, setControlState };
}

const breakBelow = (actuator: MineflayerBot, stepId: string) =>
  actuator.startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId, attempt: 1 },
    new AbortController().signal,
  );

test("a settled direct-down dig completes without a second movement", async () => {
  let pressedControl = false;
  const bot = surface({
    entity: { position: { x: 0.5, y: 62, z: 0.5 }, onGround: true, isInWater: false },
    setControlState: (_control, state) => {
      pressedControl ||= state;
    },
  });
  const step = movementStep("downward", { x: 0, y: 63, z: 0 }, { x: 0, y: 62, z: 0 }, { expectedTicks: 6 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.deepEqual(result, { kind: "completed", arrival: { x: 0, y: 62, z: 0 } });
  assert.equal(pressedControl, false);
});

test("digging directly beneath the bot centres by strafing, without turning", async () => {
  // Facing -x, so the offset toward the cell centre resolves onto the bot's
  // own back-to-front axis rather than lining up with the world axes.
  const yaw = Math.PI / 2;
  const position = { x: 0.25, y: 63, z: 0.5 };
  const { held, setControlState } = heldControls();
  let looks = 0;
  let dug = false;
  const bot = surface({
    entity: { position, yaw, onGround: true, isInWater: false },
    setControlState,
    waitForTicks: async () => applyHeading(position, held, yaw),
    lookAt: async () => {
      looks += 1;
    },
    look: async () => undefined,
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      assert.ok(Math.abs(position.x - 0.5) <= 0.17);
      assert.ok(Math.abs(position.z - 0.5) <= 0.17);
      dug = true;
    },
  });
  const effect = breakBelow(new MineflayerBot(bot, { revision: 1 }), "downward");

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(dug, true);
  // The whole point: a sub-block approach never derives a heading. Turning to
  // face a point a fifth of a block away picks an arbitrary yaw, and a shaft
  // does it once per block.
  assert.equal(looks, 0);
  assert.equal(held.size, 0);
});

test("direct-down digging proceeds after the centring window and leaves arrival to movement settlement", async () => {
  let centringTicks = 0;
  let dug = false;
  const bot = surface({
    entity: { position: { x: 0.25, y: 63, z: 0.5 }, onGround: true, isInWater: false },
    waitForTicks: async () => {
      centringTicks += 1;
    },
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      dug = true;
    },
  });
  const effect = breakBelow(new MineflayerBot(bot, { revision: 1 }), "downward");

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(centringTicks, 21);
  assert.equal(dug, true);
});

// ── Placing ──────────────────────────────────────────────────────────────────

const placeAt = (actuator: MineflayerBot, position: Position3, support: Position3, stepId: string, signal = new AbortController().signal) =>
  actuator.startEffect(
    { kind: "place", placement: { position, stateId: 1, itemType: 1, support, face: { x: 0, y: 1, z: 0 } } },
    { runId: "run", planId: "plan", stepId, attempt: 1 },
    signal,
  );

test("placing at the bot's feet jumps before issuing the pillar placement", async () => {
  const position = { x: 0.5, y: 63, z: 0.5 };
  let jumping = false;
  let sneaking = false;
  let placed = false;
  const looks: { yaw: number; pitch: number }[] = [];
  const bot = surface({
    entity: { position, onGround: true, isInWater: false, yaw: 2.1 },
    inventory: { items: () => [{ type: 1, count: 1 }] },
    setControlState: (control, state) => {
      if (control === "jump") jumping = state;
      if (control === "sneak") sneaking = state;
    },
    waitForTicks: async () => {
      if (jumping) position.y += 0.2;
    },
    lookAt: async () => {
      throw new Error("a pillar block is directly beneath the feet; its yaw is meaningless and must not be recomputed");
    },
    look: async (yaw, pitch) => {
      looks.push({ yaw, pitch });
    },
    blockAt: () => ({ name: "stone" }),
    placeBlock: async () => {
      assert.equal(position.y > 64.1, true);
      assert.equal(sneaking, true);
      placed = true;
    },
  });
  const effect = placeAt(
    new MineflayerBot(bot, { revision: 1 }),
    { x: 0, y: 63, z: 0 },
    { x: 0, y: 62, z: 0 },
    "pillar",
  );
  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(placed, true);
  assert.equal(jumping, false);
  assert.equal(sneaking, false);
  // The head keeps its heading and pitches straight down, as a straight-down dig does.
  assert.deepEqual(looks, [{ yaw: 2.1, pitch: -Math.PI / 2 }]);
});

test("a placement jump that already landed does not start a second pillar jump", async () => {
  let jumped = false;
  const bot = surface({
    entity: { position: { x: 0.5, y: 64, z: 0.5 }, onGround: true, isInWater: false },
    setControlState: (control, state) => {
      if (control === "jump" && state) jumped = true;
    },
    blockAt: () => ({ name: "stone" }),
  });
  const step = movementStep("pillar", { x: 0, y: 63, z: 0 }, { x: 0, y: 64, z: 0 }, { expectedTicks: 12 });
  const result = await executeBotMovement(new MineflayerBot(bot, { revision: 1 }), step, { end: "settled" });
  assert.equal(result.kind, "completed");
  assert.equal(jumped, false);
});

test("placing an adjacent stair tread first moves the bot clear of its cell", async () => {
  const yaw = Math.PI / 2;
  const position = { x: 0.5, y: 63, z: 0.75 };
  const { held, setControlState } = heldControls();
  let placed = false;
  const bot = surface({
    entity: { position, yaw, onGround: true, isInWater: false },
    inventory: { items: () => [{ type: 1, count: 1 }] },
    setControlState,
    waitForTicks: async () => applyHeading(position, held, yaw),
    blockAt: () => ({ name: "stone" }),
    placeBlock: async () => {
      assert.equal(position.z <= 0.67, true);
      placed = true;
    },
  });
  const effect = placeAt(
    new MineflayerBot(bot, { revision: 1 }),
    { x: 0, y: 63, z: 1 },
    { x: 0, y: 62, z: 1 },
    "repair",
  );

  assert.deepEqual(await effect.completion, { kind: "accepted" });
  assert.equal(placed, true);
  assert.equal(held.size, 0);
});

// ── Handing off ──────────────────────────────────────────────────────────────

test("movement steering turns toward the landing and preserves pitch", () => {
  const rotations: { yaw: number; pitch: number; force: boolean | undefined }[] = [];
  const bot = surface({
    entity: { position: { x: 0.5, y: 63, z: 0.5 }, yaw: 0, pitch: 0.4, onGround: false, isInWater: false },
    look: async (yaw, pitch, force) => {
      rotations.push({ yaw, pitch, force });
    },
  });

  new MineflayerBot(bot, { revision: 1 }).applyMovementSteering({ x: 3.5, y: 64, z: 0.5 });

  assert.deepEqual(rotations, [{ yaw: -Math.PI / 2, pitch: 0.4, force: true }]);
});

test("a vertical step-up applies no horizontal input, and a continuous walk hands off on entering the next cell", async () => {
  const vertical = { x: 0.25, y: 63, z: 0.5 };
  let pressedForward = false;
  const climbing = surface({
    entity: { position: vertical, onGround: true, isInWater: false },
    setControlState: (control, state) => {
      if (control === "forward" && state) pressedForward = true;
    },
  });
  const stepUp = movementStep("step_up", { x: 0, y: 62, z: 0 }, { x: 0, y: 63, z: 0 }, { target: vertical });
  assert.equal(
    (await executeBotMovement(new MineflayerBot(climbing, { revision: 1 }), stepUp, { end: "settled" })).kind,
    "completed",
  );
  assert.equal(pressedForward, false);

  const walking = { x: 0.5, y: 63, z: 0.5 };
  const walker = surface({
    entity: { position: walking, onGround: true, isInWater: false },
    waitForTicks: async () => {
      walking.x = 1.01;
    },
  });
  const walk = movementStep("walk", { x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }, { expectedTicks: 5 });
  assert.equal(
    (await executeBotMovement(new MineflayerBot(walker, { revision: 1 }), walk, { end: "continuous" })).kind,
    "completed",
  );
});


test("a mob entering the scaffold cell while aiming prevents the placement packet", async () => {
  let occupied = false;
  let packets = 0;
  const bot = surface({
    inventory: { items: () => [{ type: 1, count: 1 }] },
    blockAt: () => ({ name: "stone" }),
    lookAt: async () => { occupied = true; },
    placementObstacle: () => occupied ? "Placement cell overlaps enderman #77" : null,
    placeBlock: async () => { packets++; },
  });
  const effect = placeAt(new MineflayerBot(bot, { revision: 1 }),
    { x: 1, y: 63, z: 0 }, { x: 1, y: 62, z: 0 }, "repair");
  assert.deepEqual(await effect.completion, { kind: "failed", observation: "Placement cell overlaps enderman #77" });
  assert.equal(effect.issued, false);
  assert.equal(packets, 0);
});

/**
 * Mineflayer's `dig` resolves when its own timer ends and it has written air into the client world itself, whether or not
 * the server broke the block (ghost air, run 16). The surface's `watchServerChange` stands for the server's packets.
 */
function serverWatchedDig(answer: () => Promise<boolean>) {
  const order: string[] = [];
  const asked: Position3[] = [];
  let disposed = 0;
  const bot = surface({
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      order.push("dig");
    },
    watchServerChange: () => {
      order.push("watch");
      return {
        answer: async () => {
          order.push("answer");
          return answer();
        },
        next: async () => {
          order.push("answer");
          return await answer() ? { index: 0, state: { age: 0, stateId: 0, solid: false } } : "none";
        },
        dispose: () => {
          disposed += 1;
        },
      };
    },
    requestCellResync: async (cell) => {
      asked.push(cell);
      return "resent";
    },
  });
  const effect = new MineflayerBot(bot, { revision: 1 }).startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "downward", attempt: 1 },
    new AbortController().signal,
  );
  return { effect, order, asked, disposed: () => disposed };
}

test("a break is accepted only once the server has answered for its cell, and the watch began before the dig", async () => {
  let answered!: (value: boolean) => void;
  const run = serverWatchedDig(() => new Promise<boolean>((resolve) => (answered = resolve)));
  const settled = watch(run.effect.completion);
  await flush();
  assert.equal(settled.over, false, "mineflayer's own air write is not the server's answer");
  answered(true);
  assert.deepEqual(await run.effect.completion, { kind: "accepted" });
  assert.deepEqual(run.order, ["watch", "dig", "answer"]);
  assert.deepEqual(run.asked, []);
  assert.equal(run.disposed(), 1);
});

test("a dig that throws still removes the server watch", async () => {
  const bot = surface({
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      throw new Error("dig interrupted");
    },
    watchServerChange: () => ({ answer: async () => true, next: async () => "none", dispose: () => void (disposed += 1) }),
  });
  let disposed = 0;
  const effect = new MineflayerBot(bot, { revision: 1 }).startEffect(
    { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "downward", attempt: 1 },
    new AbortController().signal,
  );
  assert.equal((await effect.completion).kind, "failed");
  assert.equal(disposed, 1);
});

test("a break effect reports the block it dug and the tool, once, also when the dig throws", async () => {
  const reported: NavigationDig[] = [];
  const dug = surface({
    blockAt: () => ({ name: "deepslate" }),
    reportDig: (dig) => reported.push(dig),
    watchServerChange: () => ({ answer: async () => true,
      next: async () => ({ index: 0, state: { stateId: 0, solid: false, age: 0 } }), dispose: () => undefined }),
  });
  const operation = { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] } as const;
  const provenance = { runId: "run", planId: "plan", stepId: "downward", attempt: 1 };
  await new MineflayerBot(dug, { revision: 1 }).startEffect(operation, provenance, new AbortController().signal).completion;
  assert.equal(reported.length, 1);
  assert.equal(reported[0]!.block, "deepslate");
  assert.equal(reported[0]!.toolType, null);
  assert.ok(reported[0]!.ms >= 0);
  const failing = surface({
    blockAt: () => ({ name: "stone" }),
    dig: async () => {
      throw new Error("dig interrupted");
    },
    reportDig: (dig) => reported.push(dig),
  });
  await new MineflayerBot(failing, { revision: 1 }).startEffect(operation, provenance, new AbortController().signal).completion;
  assert.deepEqual(reported.map((dig) => dig.block), ["deepslate", "stone"]);
});

test("a break effect that never started a dig (no face in view) reports no dig", async () => {
  const reported: NavigationDig[] = [];
  let dug = 0;
  const hidden = surface({
    blockAt: () => ({ name: "stone" }),
    visibleDigAim: () => null,
    dig: async () => void (dug += 1),
    reportDig: (dig) => reported.push(dig),
  });
  const effect = new MineflayerBot(hidden, { revision: 1 }).startEffect(
    { kind: "break", position: { x: 4, y: 65, z: 3 }, expectedStateId: 1, toolType: null, brings: [] },
    { runId: "run", planId: "plan", stepId: "hidden", attempt: 1 },
    new AbortController().signal,
  );
  assert.equal((await effect.completion).kind, "failed");
  assert.equal(dug, 0);
  assert.deepEqual(reported, [], "a block that was never dug is not counted as dug");
});

test("the bot surface reports a dig to the observers of the raw bot the navigate call watches", () => {
  const { bot: raw } = createFakeBot();
  const seen: NavigationDig[] = [];
  const close = observeNavigationDigs(raw, (dig) => seen.push(dig));
  mineflayerBotSurface(raw).reportDig?.({ block: "stone", toolType: null, ms: 10 });
  assert.deepEqual(seen, [{ block: "stone", toolType: null, ms: 10 }]);
  close();
});

test("a water stance held through the bot surface is counted on the raw bot the runtime asks (review 2026-10-19 #2)", () => {
  const { bot: raw } = createFakeBot();
  Object.assign(raw.entity, { isInWater: true });
  const release = mineflayerBotSurface(raw).holdWaterStance(undefined, () => {});
  assert.equal(waterStancesHeld(raw), 1, "runtime.steering asks with the raw bot");
  release();
  assert.equal(waterStancesHeld(raw), 0);
});

// Plan 2026-10-27-p1-monotonic-clock T4: the dig trace's elapsedMs is a duration.
test("the dig trace of a 300 ms dig, with the wall clock stepped back 0.8 s meanwhile, says 300 ms and never a negative one", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const directory = mkdtempSync(join(tmpdir(), "dig-trace-"));
  const file = join(directory, "trace.jsonl");
  const previous = process.env.MINE_AI_DIG_TRACE;
  process.env.MINE_AI_DIG_TRACE = file;
  using _timers = clock.install();
  try {
    const bot = surface({
      blockAt: () => ({ name: "stone" }),
      dig: async () => {
        await clock.advance(300);
        clock.stepWallClock(-800);
      },
    });
    const effect = new MineflayerBot(bot, { revision: 1 }).startEffect(
      { kind: "break", position: { x: 0, y: 62, z: 0 }, expectedStateId: 1, toolType: null, brings: [] },
      { runId: "run", planId: "plan", stepId: "trace", attempt: 1 },
      new AbortController().signal,
    );
    assert.deepEqual(await effect.completion, { kind: "accepted" });
    const [record] = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { elapsedMs: number });
    assert.equal(record!.elapsedMs, 300);
  } finally {
    if (previous === undefined) delete process.env.MINE_AI_DIG_TRACE;
    else process.env.MINE_AI_DIG_TRACE = previous;
    rmSync(directory, { recursive: true });
  }
});
