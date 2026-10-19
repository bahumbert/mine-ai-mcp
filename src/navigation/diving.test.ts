import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { movementStep } from "../test-support/navigation.js";
import { Diving } from "./diving.js";
import { MemoryWorld } from "./world/memory-world.js";
import { createMovementPolicy } from "./movements/policy.js";
import { exactBlockGoal } from "./goals/index.js";
import { DIVE_BACKSTOP_TICKS } from "./world/swimming.js";

/** Water levels (`level` property) by y for the column's cells; an unlisted cell is a source. */
function fixture(levels: Record<number, number> = {}) {
  const world = new MemoryWorld();
  for (let y = 59; y <= 65; y++) world.load({ x: 0, y, z: 0 }, y === 59 ? { stateId: 1 } : y <= 63
    ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } } : { stateId: 0 });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 61.2, 0.5), metadata: [300], onGround: false },
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    blockAt: (p: Vec3) => {
      const cell = world.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return cell.kind === "loaded" ? { name: cell.traits.liquid ?? (cell.stateId === 0 ? "air" : "stone"),
        getProperties: () => ({ level: String(levels[Math.floor(p.y)] ?? 0) }) } : null;
    },
    setControlState: () => {},
  }) as unknown as Bot;
  return { world, bot };
}

test("a dive declaration and its watcher end on success, cancellation, and exceptions", async () => {
  const { world, bot } = fixture();
  const diving = new Diving(bot, world);
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }) };
  await assert.rejects(diving.run(options, async () => {
    assert.equal(diving.owned, true);
    assert.ok(diving.backstop()! > 25);
    throw new Error("failed physical route");
  }), /failed physical route/);
  assert.equal(diving.owned, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  const result = await diving.run(options, async (request) => {
    diving.cancel("takeover");
    assert.equal(request.stopSignal?.aborted, true);
    return { status: "stopped", reason: "takeover", elapsedMs: 0 };
  });
  assert.equal(result.status, "stopped");
  assert.equal(diving.active, false);
  assert.equal(diving.backstop(), null);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("planned breathing returns to the original goal after observing full air", async () => {
  const { world, bot } = fixture();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const goal = exactBlockGoal({ x: 0, y: 60, z: 0 });
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal }, async (request) => {
    calls++;
    if (calls === 1) {
      Reflect.set(bot.entity.metadata, 0, 60);
      bot.emit("physicsTick");
      assert.equal(request.stopSignal?.aborted, true);
      return { status: "stopped", reason: String(request.stopSignal?.reason), elapsedMs: 0 };
    }
    if (calls === 2) {
      assert.notEqual(request.goal, goal);
      bot.entity.position.y = 63.5;
      Reflect.set(bot.entity.metadata, 0, 300);
    } else assert.equal(request.goal, goal);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 3);
  assert.deepEqual(states, ["breathing", "resumed", "released"]);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("floating work with dry eyes keeps the existing surface-mining contract", () => {
  const { world, bot } = fixture();
  bot.entity.position.y = 62.5; // The floored head cell is water, but the actual eyes are above it.
  Reflect.set(bot.entity, "metadata", []);
  assert.equal(new Diving(bot, world).beforeWork(400), null);
});

test("quantity completion still returns a mining process to air, while takeover cancels refill without another tick", async () => {
  const { world, bot } = fixture();
  const diving = new Diving(bot, world);
  const quantity = new AbortController();
  let breathing!: () => void;
  const startedBreathing = new Promise<void>((resolve) => { breathing = resolve; });
  bot.setControlState = (control, active) => { if (control === "jump" && active) breathing(); };
  let calls = 0;
  const options = { movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 61, z: 0 }),
    onArrival: () => ({ kind: "completed" as const }), stopSignal: quantity.signal };
  const pending = diving.run(options, async (request) => {
    calls++;
    if (calls === 1) {
      quantity.abort("quantity collected");
      return { status: "stopped", reason: "quantity collected", elapsedMs: 0 };
    }
    assert.equal(request.stopSignal?.aborted, false, "the process still owes its surface handoff");
    bot.entity.position.y = 63.5;
    Reflect.set(bot.entity.metadata, 0, 200);
    return { status: "completed", elapsedMs: 0 };
  });
  await startedBreathing;
  diving.cancel("connection ended during refill");
  const result = await pending;
  assert.equal(result.status, "stopped");
  assert.ok(result.status === "stopped" && result.reason === "connection ended during refill");
  assert.equal(calls, 2);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("roofed and with no air metadata, a submerged start takes its air as unchanged and plans a dive", async () => {
  const world = new MemoryWorld();
  for (let x = -3; x <= 3; x++)
    for (let y = 59; y <= 66; y++)
      world.load({ x, y, z: 0 }, y === 59 || (y === 62 && x >= -1 && x <= 1) ? { stateId: 1 } : y <= 63
        ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } } : { stateId: 0 });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 60.2, 0.5), metadata: [], onGround: true },
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    blockAt: (p: Vec3) => {
      const cell = world.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return cell.kind === "loaded" ? { name: cell.traits.liquid ?? (cell.stateId === 0 ? "air" : "stone") } : null;
    },
    setControlState: () => {},
  }) as unknown as Bot;
  const ticking = setInterval(() => bot.emit("physicsTick"), 1);
  try {
    const diving = new Diving(bot, world);
    let dive: unknown;
    await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 3, y: 60, z: 0 }) }, async (request) => {
      dive = request.movements.dive;
      return { status: "completed", elapsedMs: 0 };
    });
    assert.deepEqual(Object.keys(dive as object), ["origin", "airTicks"]);
    assert.equal((dive as { airTicks: number }).airTicks, 300);
  } finally {
    clearInterval(ticking);
  }
});

// ── A run that ends under a roof swims back to the last air it passed (run 15, Sana) ───────────────

/** An air pocket at x -2..0 and a water tunnel x 1..8 (y 60-61), roofed (y 62) and floored (y 59), z 0 only. */
function tunnelFixture() {
  const world = new MemoryWorld();
  for (let x = -2; x <= 8; x++)
    for (let y = 59; y <= 62; y++)
      world.load({ x, y, z: 0 }, y === 59 || y === 62 ? { stateId: 1 } : x <= 0 ? { stateId: 0 }
        : { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } });
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 60, 0.5), metadata: [300], onGround: true },
    registry: { entitiesByName: { player: { metadataKeys: ["air_supply"] } } },
    health: 20,
    blockAt: (p: Vec3) => {
      const cell = world.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return cell.kind === "loaded" ? { name: cell.traits.liquid ?? (cell.stateId === 0 ? "air" : "stone") } : null;
    },
    setControlState: () => {},
  }) as unknown as Bot;
  return { world, bot };
}

test("a dive that fails five blocks into a roofed tunnel swims back to the air pocket before it releases", async () => {
  const { world, bot } = tunnelFixture();
  const states: string[] = [];
  const diving = new Diving(bot, world, (state) => states.push(state));
  const calls: { goal: unknown; air: unknown }[] = [];
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async (request) => {
    calls.push({ goal: request.goal, air: request.movements.dive });
    if (calls.length === 1) {
      bot.emit("physicsTick");
      diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
      bot.entity.position.x = 5.5;
      bot.emit("physicsTick");
      return { status: "failed", elapsedMs: 0 } as never;
    }
    bot.entity.position.x = 0.5;
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(calls.length, 2, "one swim back");
  const back = calls[1]!.goal as { resolve(observation: unknown): { kind: string } };
  assert.ok(back !== calls[0]!.goal);
  assert.equal(bot.entity.position.x, 0.5, "she ends in the air pocket, not inside");
  assert.deepEqual(states, ["released"]);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("death"), 0);
});

test("a takeover cancel leaves the swim back to the reflex that took the body", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async () => {
    calls++;
    bot.emit("physicsTick");
    diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
    bot.entity.position.x = 5.5;
    diving.cancel("takeover");
    return { status: "stopped", reason: "takeover", elapsedMs: 0 };
  });
  assert.equal(calls, 1);
});

test("a death during the swim back ends it cleanly", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }) }, async (request) => {
    calls++;
    if (calls === 1) {
      bot.emit("physicsTick");
      diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
      bot.entity.position.x = 5.5;
      return { status: "failed", elapsedMs: 0 } as never;
    }
    bot.emit("death");
    assert.equal(request.stopSignal?.aborted, true, "the swim back is told to stop");
    return { status: "stopped", reason: "died", elapsedMs: 0 };
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 2);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("death"), 0);
  assert.equal(bot.listenerCount("respawn"), 0);
});

// Review 2026-10-18 (run 15 fixes), blocking 3: the swim back ran after successful arrivals and ignored the action's cancel.

/** The first navigate of a run into the tunnel: the pocket passed with the head in air, then the dive owned, five blocks in. */
function intoTheTunnel(bot: Bot, diving: Diving): void {
  bot.emit("physicsTick");
  diving.committed({ steps: [movementStep("swim", { x: 4, y: 60, z: 0 }, { x: 5, y: 60, z: 0 })] });
  bot.entity.position.x = 5.5;
}

test("a goal under water that was reached is where the run ends: no swim back undoes the arrival", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  let calls = 0;
  const result = await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 5, y: 60, z: 0 }) }, async () => {
    calls++;
    intoTheTunnel(bot, diving);
    return { status: "completed", elapsedMs: 0 };
  });
  assert.equal(result.status, "completed");
  assert.equal(calls, 1, "the arrival is not swum back from");
  assert.equal(bot.entity.position.x, 5.5);
});

test("the action cancelled during the swim back stops it at once, with no control held", async () => {
  const { world, bot } = tunnelFixture();
  const held = new Set<string>();
  bot.setControlState = (control, active) => void (active ? held.add(control) : held.delete(control));
  const diving = new Diving(bot, world);
  const cancel = new AbortController();
  let calls = 0;
  let stoppedAtOnce = false;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), signal: cancel.signal }, async (request) => {
    calls++;
    if (calls === 1) {
      intoTheTunnel(bot, diving);
      return { status: "stopped", reason: "no route", elapsedMs: 0 };
    }
    cancel.abort("cancelled by the model");
    stoppedAtOnce = request.stopSignal?.aborted === true;
    return { status: "stopped", reason: "cancelled", elapsedMs: 0 };
  });
  assert.equal(calls, 2);
  assert.equal(stoppedAtOnce, true, "the swim back is told to stop when the action is cancelled");
  assert.equal(held.size, 0);
  assert.equal(diving.active, false);
  assert.equal(bot.listenerCount("death") + bot.listenerCount("respawn") + bot.listenerCount("physicsTick"), 0);
});

test("an action already cancelled when its run ends does not start a swim back", async () => {
  const { world, bot } = tunnelFixture();
  const diving = new Diving(bot, world);
  const cancel = new AbortController();
  let calls = 0;
  await assert.rejects(diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 8, y: 60, z: 0 }), signal: cancel.signal }, async () => {
    calls++;
    intoTheTunnel(bot, diving);
    cancel.abort("cancelled by the model");
    throw cancel.signal.reason;
  }), /cancelled by the model/);
  assert.equal(calls, 1);
  assert.equal(diving.active, false);
});

/** A dive owned in open water, then roofed in the middle of the route: the admission premise (an ascent) is gone. */
async function backstopUnderRoof(eyeCell: { liquidSource: boolean; level: number }) {
  const levels: Record<number, number> = {};
  const { world, bot } = fixture(levels);
  // Feet at y 60 on the floor: the eye cell is y 61, which holds water for the whole dive.
  Object.assign(bot.entity, { position: new Vec3(0.5, 60, 0.5) });
  const diving = new Diving(bot, world);
  let backstop: number | null = null;
  await diving.run({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 0, y: 60, z: 0 }) }, async () => {
    assert.equal(diving.owned, true);
    world.load({ x: 0, y: 61, z: 0 }, { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: eyeCell.liquidSource } });
    levels[61] = eyeCell.level;
    for (let y = 62; y <= 65; y++) world.load({ x: 0, y, z: 0 }, { stateId: 1 });
    backstop = diving.backstop();
    return { status: "completed", elapsedMs: 0 };
  });
  return backstop;
}

test("the backstop of a roofed dive does not ask a rescue while the eyes are in the air above flowing water of level 4", async () => {
  assert.equal(await backstopUnderRoof({ liquidSource: false, level: 4 }), DIVE_BACKSTOP_TICKS);
});

test("the backstop of a roofed dive still asks an immediate rescue with the eyes under a source and no ascent", async () => {
  assert.equal(await backstopUnderRoof({ liquidSource: true, level: 0 }), 300);
});
