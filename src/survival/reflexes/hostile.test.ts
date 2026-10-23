import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { defineAction, actionResultSchema } from "../../actions/action.js";
import { readNotificationSummary, SqlBotData } from "../../bot-data/index.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner, type ActionRunnerOptions } from "../../session/action-runner.js";
import { attackedIds, engagingCombat } from "../../test-support/combat.js";
import { type FakeBot, type FakeBotOptions, type FakeCell, type FakeEntitySpec, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import type { CombatController, CombatOutcome } from "../control/combat/contract.js";
import { ReflexDriver } from "../control/driver.js";
import { attachSurvivalReceipts } from "../evidence/receipts.js";
import { SurvivalObserver } from "../evidence/status.js";
import type { HostileResponse } from "../policy/combat/response.js";

import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { observeHostileResponse } from "../control/combat/observation.js";
import { executeHostileResponse } from "../control/combat/respond.js";
import { completeResponse, encounterReceipt } from "../control/combat/settlement.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { attachHostileReflex } from "./hostile.js";

for (const escapes of [true, false]) {
  test(`withdrawal ${escapes ? "resumes its request after safe separation" : "returns when escape has no path"}`, async () => {
    const fixture = reflexFixture(
      async () => {
        throw new Error("Withdrawal must not engage");
      },
      async () => {
        if (!escapes) return { status: "stopped", reason: "no path", elapsedMs: 1 };
        fixture.bot.entity.position.x = 60;
        return { status: "completed", elapsedMs: 1 };
      },
      { entities: { 7: hostile("blaze", 5) } },
    );
    let attempts = 0;
    const input = z.object({ destination: z.number() });
    const action = defineAction({
      name: "withdraw_test",
      description: "withdraw",
      inputSchema: input,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (value: unknown) => input.parse(value),
      execution: { kind: "resumable_task" },
      begin: (request) => async (context) => {
        attempts++;
        if (attempts === 1) {
          const stopped = new Promise<void>((resolve) =>
            context.signal!.addEventListener("abort", () => resolve(), { once: true }),
          );
          fixture.tick();
          await stopped;
          return { status: "failed", error: "interrupted" };
        }
        assert.equal(request.destination, 70);
        return { status: "succeeded" };
      },
    });
    try {
      await fixture.controller.policy.edit({
        operation: "set",
        expected_revision: fixture.controller.policy.snapshot().revision,
        changes: { combat: { engagement: "defend_only" } },
        lifetime: { kind: "session" },
        reason: "test",
      });
      const output = await fixture.runner.run(action, { destination: 70 });
      assert.equal(output.result.status, escapes ? "succeeded" : "failed");
      assert.equal(attempts, escapes ? 2 : 1);
      assert.ok(await until(() => fixture.recorded().length > 0));
      assert.deepEqual(fixture.recorded(), [escapes ? "evade -> safe_separation" : "evade -> capability_limit"]);
    } finally {
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

/** A hostile the bot sees at the start, `x` blocks along the row the bot stands on (its size is the game's). */
function hostile(name: string, x: number): FakeEntitySpec {
  return { name, kind: "Hostile mobs", position: new Vec3(x, 64, 0) };
}

/** The ten cells of a closed shelter around the bot at (0, 64, 0): four sides at two levels, the cap and the floor. */
function sealedCells(): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = { "0,66,0": "stone", "0,63,0": "stone" };
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [64, 65]) cells[`${x},${y},${z}`] = "stone";
  return cells;
}

/**
 * The hostile stays in sight of a bot sealed in stone. The game would hide it behind the walls (the fake's raycast
 * stops at them), but these tests are about the reflex's answer to a hostile in sight under the hide bar, so the
 * ray is scripted clear: what the old fixture's world did for every ray.
 */
function seeThroughShelter(bot: FakeBot): void {
  bot.world.raycast = () => null;
}

test("an automatic target disappearing resumes the original request without claiming a kill", async () => {
  const fixture = reflexFixture(
    async (targetId) => {
      fixture.bot.entities[targetId]!.isValid = false;
      return { ...died(targetId), kind: "target_lost", attacks: 0 };
    },
    undefined,
    { entities: { 7: hostile("blaze", 5) } },
  );
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "interrupted_collection",
    description: "preserve the requested collection",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      if (++attempts === 1) {
        const stopped = new Promise<void>((resolve) =>
          context.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        fixture.tick();
        await stopped;
        return { status: "failed", error: "interrupted" };
      }
      assert.equal(request.count, 12);
      return { status: "succeeded" };
    },
  });
  try {
    const result = await fixture.runner.run(action, { count: 12 });
    assert.equal(result.result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["fight -> target_lost"]);
    assert.equal(fixture.observer.threats.resolvedIds.has(7), false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/** What a test sets on the fake bot at the start, and how its runner is configured (its clock is the fake bot's). */
interface FixtureOptions extends Pick<FakeBotOptions, "entities" | "carried" | "slots" | "cells" | "overrides" | "health" | "food"> {
  readonly runner?: Omit<ActionRunnerOptions, "clock">;
}

/** The recorded encounters, oldest first, as `response -> outcome`. */
function recordedEncounters(data: SqlBotData): string[] {
  return data
    .read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    )
    .map((row) => {
      const payload = JSON.parse(String(row.payload_json)) as { response: string; outcome: string };
      return `${payload.response} -> ${payload.outcome}`;
    });
}

function reflexFixture(engage: CombatController["engage"], navigate: NavigationRuntime["navigate"] = async () => ({ status: "completed", elapsedMs: 0 }), options: FixtureOptions = {}) {
  const { bot, clock, world, inventory, entities, server } = createFakeBot({
    username: "ReflexBot",
    position: new Vec3(0, 64, 0),
    // Open air with nothing carried: a hide here can dig nothing and place
    // nothing, which is the state the standing-down rule exists for.
    groundY: null,
    entities: options.entities,
    carried: options.carried,
    health: options.health,
    food: options.food,
    slots: options.slots,
    cells: options.cells,
    overrides: options.overrides,
  });
  // The fake's own `death` listener (its physics stop at a death): the count of the code under test is on top of it.
  const harnessDeathListeners = bot.listenerCount("death");
  const data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: { worldId: "reflex-test", scope: { kind: "bot", botId: "reflex-bot" } },
  });
  const runner = new ActionRunner({ clock, ...options.runner });
  const navigation = {
    onEvent: () => () => {},
    active: false,
    cancel: () => undefined,
    navigate,
  } as unknown as NavigationRuntime;
  const controller = engagingCombat(bot, engage);
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const perception = new CombatPerception(bot);
  const attached = attachHostileReflex(bot, driver, navigation, controller, perception);
  const status = new SurvivalObserver(bot, runner, driver, controller);
  const receipts = attachSurvivalReceipts(bot, data, runner, driver, controller, status, navigation);
  const observer = {
    ...attached,
    async close() {
      await attached[Symbol.asyncDispose]();
      await driver[Symbol.asyncDispose]();
      receipts[Symbol.dispose]();
      status[Symbol.dispose]();
      perception[Symbol.dispose]();
    },
  };
  return {
    bot,
    clock,
    world,
    inventory,
    /** The packets the client wrote, in order. */
    server,
    /** The server's entities after the start: `spawn` a mob the bot meets later, `remove` one. */
    entities,
    driver,
    runner,
    navigation,
    controller,
    observer,
    perception,
    data,
    summary: () => readNotificationSummary(data, bot.username),
    recorded: () => recordedEncounters(data),
    /** One client tick at once, with no time passing: a test reads the state the tick left before the promise queue runs. */
    tick: () => bot.emit("physicsTick"),
    /** The `death` listeners an idle bot has: the fake's own and the code under test's. */
    deathListenersAtRest: harnessDeathListeners + DEATH_LISTENERS_AT_REST,
  };
}

type ReflexFixture = ReturnType<typeof reflexFixture>;

/** The response a bot at 11 health runs for `directive`, settled and read as its encounter receipt. */
async function evadeReceipt(fixture: ReflexFixture, directive: HostileResponse, signal = new AbortController().signal) {
  const response = await executeHostileResponse(fixture.bot, fixture.navigation, fixture.controller, directive, fixture.observer.threats, 11, signal);
  return encounterReceipt(completeResponse(response, signal));
}

function died(targetId: number): CombatOutcome {
  return {
    kind: "died",
    targetId,
    attacks: 1,
    stylesUsed: ["melee"],
    weaponsUsed: ["hand"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
  };
}

test("a food-policy revocation cancels a protected automatic recovery bite", async () => {
  const fixture = reflexFixture(async () => { throw new Error("A hide must not engage"); }, undefined, {
    cells: sealedCells(),
    entities: { 7: hostile("zombie", 12) },
    carried: { beef: 2 },
    health: 2,
    food: 10,
  });
  seeThroughShelter(fixture.bot);
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.bot.usingHeldItem));
    await fixture.controller.policy.edit({ operation: "set", expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "keep raw meat" });
    assert.equal(fixture.bot.usingHeldItem, false);
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.controller.policy.settling, false);
    assert.equal(fixture.bot.inventory.items()[0]?.count, 2);
  } finally {
    await fixture.observer.close();
    fixture.data.close();
  }
});

for (const kind of ["mob", "end"] as const) {
  test(`hostile takeover ${kind === "end" ? "awaits End cleanup" : "leaves an ordinary fight in charge"}`, async () => {
    let active: { kind: "mob" | "end"; targetId: number } | null = { kind, targetId: 42 };
    let defenses = 0,
      cleaning = false,
      started = false;
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const fixture = reflexFixture(async (id) => {
      assert.equal(active, null, "the old combat owner must release before a new fight starts");
      defenses++;
      return died(id);
    }, undefined, { entities: { 7: hostile("zombie", 2) } });
    fixture.controller.activeEngagement = () => active;
    const request = z.strictObject({});
    const action = defineAction({
      name: "occupied_combat_test",
      description: "Exercise physical handoff",
      inputSchema: request,
      resultSchema: actionResultSchema({}),
      formatResult: (result) => result.status,
      parse: (input) => request.parse(input),
      execution: { kind: "task" },
      execute: async (_, { signal }) => {
        started = true;
        await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
        cleaning = true;
        await cleanup;
        active = null;
        signal!.throwIfAborted();
        return { status: "succeeded" };
      },
    });
    const pending = fixture.runner.run(action, {});
    try {
      assert.ok(await until(() => started));
      fixture.tick();
      if (kind === "end") {
        assert.ok(await until(() => cleaning));
        assert.equal(fixture.runner.status().owner, "yielding");
        assert.equal(defenses, 0);
        fixture.tick();
      } else {
        assert.equal(fixture.runner.status().owner, "foreground");
        assert.equal(cleaning, false);
        fixture.runner.cancelActive("Test completed ordinary fight observation");
      }
      releaseCleanup();
      const output = await pending;
      assert.equal(output.result.status, "cancelled");
      if (kind === "end") assert.ok(await until(() => fixture.recorded().length === 1));
      assert.equal(defenses, kind === "end" ? 1 : 0);
      assert.equal(fixture.runner.status().owner, "idle");
    } finally {
      releaseCleanup();
      fixture.runner.cancelActive("Test cleanup");
      await pending;
      await fixture.observer[Symbol.asyncDispose]();
      fixture.data.close();
    }
  });
}

test("an incoming blaze projectile starts combat before damage beyond observation range", async () => {
  const fixture = reflexFixture(async (id) => died(id), undefined, {
    entities: {
      7: hostile("blaze", 26),
      8: { name: "small_fireball", kind: "Projectiles", position: new Vec3(20, 65, 0), velocity: new Vec3(0, 0, 0) },
    },
  });
  try {
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: -4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().owner, "takeover");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
    assert.equal(fixture.bot.health, 20);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a blaze shot travelling away does not attribute another victim's combat to us", async () => {
  const fixture = reflexFixture(async (id) => died(id), undefined, {
    entities: {
      7: hostile("blaze", 26),
      8: { name: "small_fireball", kind: "Projectiles", position: new Vec3(20, 65, 0), velocity: new Vec3(0.5, 0, 0) },
    },
  });
  try {
    fixture.bot._client.emit("spawn_entity", {
      entityId: 8,
      type: fixture.bot.registry.entitiesByName.small_fireball!.id,
      objectData: 7,
      velocity: { x: 4000, y: 0, z: 0 },
    });
    fixture.tick();
    assert.equal(fixture.runner.status().busy, false);
    assert.equal(fixture.observer.threats.attackerIds.size, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/** "death" listeners the code under test keeps on an idle bot: the hostile reflex's own and the body-tick pacer's (the driver ticks through it). */
const DEATH_LISTENERS_AT_REST = 3;

/** Let the claimed response run to its recorded event, or give up after a bounded number of turns. */
async function until(condition: () => boolean, turns = 50): Promise<boolean> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return condition();
}

test("the automatic enderman response holds its stance across a teleport", async () => {
  const fixture = reflexFixture(
    async (targetId, signal, movement) => {
      assert.equal(movement, "hold");
      fixture.bot.entities[targetId]!.position.x = 8;
      fixture.tick();
      assert.equal(signal.aborted, false, "a teleport beyond melee reach does not cancel the guard");
      return died(targetId);
    },
    undefined,
    { entities: { 7: hostile("enderman", 3) } },
  );
  const enderman = fixture.bot.entities[7]!;
  Reflect.set(enderman.metadata, fixture.bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy"), true);
  try {
    fixture.bot.emit("entityHurt", fixture.bot.entity, enderman);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("claims an idle body for a hostile in contact and records what happened", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });

  fixture.tick();
  assert.equal(fixture.runner.status().owner, "takeover");
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  assert.equal(fixture.runner.status().busy, false);
  assert.ok(await until(() => fixture.bot.listenerCount("death") === fixture.deathListenersAtRest));
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a denied reflex claim removes its death listener", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  Object.defineProperty(fixture.runner, "claim", {
    value: () => ({ kind: "busy", activeAction: { action: "other", startedAt: new Date().toISOString() } }),
  });
  fixture.tick();
  assert.equal(fixture.bot.listenerCount("death"), fixture.deathListenersAtRest);
  assert.deepEqual(fixture.recorded(), []);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an emergency retreat excludes momentum-dependent parkour while preserving supported movement", async () => {
  let called = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ movements }) => {
      called = true;
      assert.equal(movements.allowParkour, false);
      assert.equal(movements.allowSprinting, true);
      assert.equal(movements.allowPlacing, true);
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(called, true);
    assert.equal(result.outcome, "safe_separation");
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("an admitted low-health escape is not stopped for a stationary guard it cannot sustain", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ stopSignal }) => {
      assert.equal(stopSignal?.aborted, false);
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("blaze", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  fixture.bot.health = 7;
  fixture.inventory.updateSlot(45, itemOf(fixture.bot.registry, "shield", 1));
  fixture.entities.spawn({
    id: 8,
    ...hostile("small_fireball", 8),
    position: new Vec3(8, 65, 0),
    velocity: new Vec3(-0.5, 0, 0),
  });
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, "safe_separation");
    assert.equal(result.projectileGuards, 0);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("direct encounter cancellation cannot report safe separation after route cleanup", async () => {
  const cancellation = new AbortController();
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      cancellation.abort("operator cancellation");
      fixture.bot.entity.position.x = -40;
      return { status: "completed", elapsedMs: 0 };
    },
    { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  const result = await evadeReceipt(fixture, directive, cancellation.signal);
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.error, "operator cancellation");
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

for (const floor of ["safe", "damaging", "airborne"] as const) {
  test(`an evade timeout beyond required separation checks ${floor} footing before its verdict`, async () => {
    const fixture = reflexFixture(
      async (id) => died(id),
      async () => {
        fixture.bot.entity.position.x = -40;
        fixture.bot.entity.onGround = floor !== "airborne";
        return { status: "stopped", reason: "navigation timeout", elapsedMs: 15_000 };
      },
      { entities: { 7: hostile("zombie", 3) } },
    );
    const world = new MemoryWorld();
    world.load({ x: -40, y: 63, z: 0 }, { stateId: 1, traits: { damaging: floor === "damaging" } });
    world.load({ x: -40, y: 64, z: 0 }, { stateId: 0 });
    world.load({ x: -40, y: 65, z: 0 }, { stateId: 0 });
    Object.defineProperty(fixture.navigation, "world", { value: world });
    fixture.bot.health = 11;
    const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
    assert.equal(directive.kind, "evade");
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, floor === "safe" ? "safe_separation" : "capability_limit");
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("a controller cancellation after a policy edit preserves the cancellation receipt", async () => {
  const fixture = reflexFixture(async (targetId) => {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { hide: "never" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    return { ...died(targetId), kind: "cancelled" };
  }, undefined, { entities: { 7: hostile("blaze", 3) } });
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("unchanged failed fight stays suppressed when no alternate response is permitted", async () => {
  const fixture = reflexFixture(
    async () => {
      throw new Error("equipment unavailable");
    },
    undefined,
    { entities: { 7: hostile("zombie", 3) } },
  );
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  fixture.tick();

  assert.equal(fixture.runner.status().busy, false);
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("the reflex awaits combat recovery and records its capability limit", async () => {
  let engaging = false;
  let recoveryBlocked = () => {};
  const fixture = reflexFixture(
    (targetId) =>
      new Promise((resolve) => {
        engaging = true;
        recoveryBlocked = () =>
          resolve({
            ...died(targetId),
            kind: "capability_blocked",
            reason: "recovery",
            observation: "No food remains.",
            attacks: 2,
          });
      }), undefined, { entities: { 7: hostile("skeleton", 5) } },
  );
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  assert.equal(fixture.runner.status().busy, true, "health alone does not settle the encounter");
  recoveryBlocked();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["fight -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("melee contact ending releases the reflex without marking the target unreachable", async () => {
  let engaging = false;
  const fixture = reflexFixture(
    (targetId, signal, movement) =>
      new Promise((resolve) => {
        assert.equal(movement, "hold");
        engaging = true;
        signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
      }), undefined, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.tick();
  assert.ok(await until(() => engaging));
  fixture.bot.entities[7]!.position.y = 58;
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  assert.equal(fixture.observer.threats.unreachableIds.has(7), false);
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("ending the original melee contact cannot drop the owner while another fuse needs clearance", async () => {
  let engaging = false;
  const fixture = reflexFixture((targetId, signal) => new Promise(resolve => {
    engaging = true;
    signal.addEventListener("abort", () => resolve({ ...died(targetId), kind: "cancelled" }), { once: true });
  }), undefined, { entities: { 7: hostile("magma_cube", 3) } });
  fixture.tick();
  assert.ok(await until(() => engaging));
  const creeper = fixture.entities.spawn({ id: 8, ...hostile("creeper", 2) });
  const swell = fixture.bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  Reflect.set(creeper.metadata, swell, 1);
  fixture.perception.creeperClearance.require(fixture.perception.creeperClearance.observe(fixture.perception.tick, new Set()));
  fixture.bot.entities[7]!.position.y = 58;
  fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false);
  delete fixture.bot.entities[8];
  fixture.tick();
  assert.equal(await until(() => !fixture.runner.status().busy, 5), false, "missing is not discharged");
  fixture.perception.creeperClearance.resolve(8);
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["fight -> contact_ended"]);
  await fixture.observer.close();
  fixture.data.close();
});

test("damage below the hide threshold does not stop an already admitted escape", async () => {
  let escaping = false;
  let finish: () => void = () => assert.fail("escape has not started");
  const navigate: NavigationRuntime["navigate"] = async ({ signal, stopSignal, timeoutMs }) => {
    assert.equal(stopSignal?.aborted, false, "only an incoming projectile can pause this route");
    assert.ok(
      typeof timeoutMs === "number" && timeoutMs > 0 && timeoutMs <= 15_000,
      "the route shares the existing emergency limit with guards",
    );
    escaping = true;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    assert.equal(signal?.aborted, false);
    assert.equal(stopSignal?.aborted, false, "health loss must not interrupt the admitted route");
    return { status: "completed", elapsedMs: 1000 };
  };
  const fixture = reflexFixture(async (targetId) => died(targetId), navigate, { entities: { 7: hostile("zombie", 3) } });
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  fixture.tick();
  assert.equal(fixture.runner.status().busy, true);
  assert.deepEqual(fixture.recorded(), []);
  fixture.bot.entity.position.x = -40;
  finish();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  assert.equal(fixture.bot.listenerCount("health"), 0);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});
test("one evade retains its first threat and records a new contact encountered along its route", async () => {
  let attempts = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ goal }) => {
      const snapshot = () =>
        ({ entities: new Map(Object.values(fixture.bot.entities).map((entity) => [entity.id, entity])) }) as never;
      const initial = goal.resolve(snapshot());
      assert.equal(initial.kind, "active");
      if (initial.kind === "active" && attempts++ === 0) assert.doesNotMatch(initial.revision, /entity:8:/);
      fixture.bot.entity.position = new Vec3(-12, 64, 0);
      fixture.tick();
      const revised = goal.resolve(snapshot());
      assert.equal(revised.kind, "active");
      if (revised.kind === "active") {
        assert.match(revised.revision, /entity:7:/);
        assert.match(revised.revision, /entity:8:/);
      }
      // Away from the first threat alone is not enough to report safe separation.
      fixture.bot.entity.position = new Vec3(-40, 64, 0);
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping.
    { entities: { 7: hostile("blaze", 4), 8: hostile("blaze", -26) }, slots: { 45: { name: "shield" } } },
  );
  fixture.bot.health = 11;
  const listeners = fixture.bot.listenerCount("physicsTick");
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  const payload = JSON.parse(
    String(
      fixture.data.read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )[0]?.payload_json,
    ),
  );
  assert.deepEqual(
    payload.finalDistances.map((entry: { id: number }) => entry.id),
    [7, 8],
  );
  assert.equal(fixture.bot.listenerCount("physicsTick"), listeners);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a hostile that has hurt the bot is in contact from beyond the contact range", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("skeleton", 12) } });
  const skeleton = fixture.bot.entities[7]!;

  fixture.tick();
  assert.equal(fixture.runner.status().busy, false);
  fixture.bot.emit("entityHurt", fixture.bot.entity, skeleton);
  fixture.tick();

  assert.equal(fixture.runner.status().owner, "takeover");
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> target_died"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

/**
 * The livelock of 2026-09-04, at the observer: a hide that could do nothing was
 * chosen again every second, and each choice claimed the body and cancelled
 * whatever the model had started. Eighty-four notifications in half a minute,
 * and a bot that did not move a block in a hundred and sixty ticks.
 */
test("a hide that could not be built is recorded once and then the reflex stands down", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  await fixture.controller.policy.edit({
    operation: "set",
    expected_revision: fixture.controller.policy.snapshot().revision,
    changes: { combat: { retreat: false, melee: false, shield: false } },
    lifetime: { kind: "session" },
    reason: "test",
  });
  fixture.bot.health = 7;

  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));

  assert.deepEqual(fixture.recorded(), ["hide -> capability_limit"]);
  // The memory is what stops the next decision, and it is keyed on the state
  // the hide failed in rather than on a cooldown that expires.
  fixture.tick();
  assert.equal(fixture.runner.status().busy, false, "the body stays with the model");
  assert.ok(fixture.observer.threats.blockedResponses?.has("hide"));
  assert.equal(await until(() => fixture.recorded().length > 1, 5), false);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("a changed shelter permission retries a failed hide while an unrelated bow edit does not", async () => {
  const fixture = reflexFixture(async (targetId) => died(targetId), undefined, { entities: { 7: hostile("zombie", 3) } });
  const edit = (bow: boolean, place: boolean) =>
    fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { retreat: false, melee: false, shield: false, bow, terrain: { dig: false, place } } },
      lifetime: { kind: "session" },
      reason: "test",
    });
  try {
    await edit(false, false);
    fixture.bot.health = 7;
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1 && !fixture.runner.status().busy));

    await edit(true, false);
    fixture.tick();
    assert.equal(await until(() => fixture.recorded().length > 1, 5), false);

    await edit(true, true);
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 2));
    assert.deepEqual(fixture.recorded(), ["hide -> capability_limit", "hide -> capability_limit"]);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("records a session teardown during a response as cancelled, not failed", async () => {
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), undefined, { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.tick();
  fixture.runner.cancelActive("Minecraft runtime closed");

  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["fight -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("an admitted low-health escape still yields to session cancellation", async () => {
  let escaping = false;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async ({ signal }) =>
      new Promise((resolve) => {
        escaping = true;
        signal!.addEventListener(
          "abort",
          () => resolve({ status: "stopped", reason: "session cancelled", elapsedMs: 0 }),
          { once: true },
        );
      }), { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => escaping));
  fixture.bot.health = 7;
  fixture.bot.emit("health");
  fixture.runner.cancelActive("Minecraft runtime closed");
  assert.ok(await until(() => !fixture.runner.status().busy));
  assert.deepEqual(fixture.recorded(), ["evade -> cancelled"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("cancellation does not conceal a different failure while combat releases the body", async () => {
  let engaged = false;
  const fixture = reflexFixture(
    (_targetId, signal) =>
      new Promise((_resolve, reject) => {
        engaged = true;
        signal.addEventListener("abort", () => reject(new Error("shield release failed")), { once: true });
      }), undefined, { entities: { 7: hostile("zombie", 3) } },
  );
  try {
    fixture.tick();
    assert.ok(await until(() => engaged));
    fixture.runner.cancelActive("operator cancellation");
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> failed"]);
    const row = fixture.data.read(
      "SELECT payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id DESC LIMIT 1",
    )[0]!;
    assert.match(String(row.payload_json), /shield release failed/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cancelled escape preserves its attack and kill evidence when navigation throws", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.tick();
      fixture.bot.emit("entityDead", fixture.bot.entities[7]!);
      fixture.runner.cancelActive("footing recovery");
      throw new Error("navigation released during cancellation");
    },
    { entities: { 7: hostile("zombie", 2) } },
  );
  fixture.bot.health = 11;
  try {
    fixture.tick();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.equal(attackedIds(fixture.server).length, 1);
    const row = fixture.data.read(
      "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
    )[0]!;
    const evidence = JSON.parse(String(row.payload_json));
    assert.equal(evidence.outcome, "cancelled");
    assert.equal(evidence.attacks, 1);
    assert.deepEqual(evidence.weaponsUsed, ["hand"]);
    assert.deepEqual(evidence.killedTargetIds, [7]);
    assert.match(evidence.error, /footing recovery/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const cleanup of ["returns", "throws"] as const) {
  test(`encounter death evidence survives respawn before cleanup ${cleanup}`, async () => {
    let started = false;
    let finish: () => void = () => assert.fail("combat has not started");
    const fixture = reflexFixture(
      (targetId, signal) =>
        new Promise((resolve, reject) => {
          started = true;
          finish = () =>
            cleanup === "throws"
              ? reject(signal.reason ?? new Error("cleanup failed after death"))
              : resolve({ ...died(targetId), kind: "bot_died", attacks: 3 });
        }), undefined, { entities: { 7: hostile("zombie", 15) } },
    );
    fixture.bot.entity.position = new Vec3(12, 70, 9);
    fixture.bot.entities[7]!.position = new Vec3(15, 70, 9);
    // Real player-events cancellation happens on death, before cleanup settles.
    const cancelOnDeath = () => {
      fixture.runner.cancelActive("bot died");
    };
    fixture.bot.on("death", cancelOnDeath);
    fixture.tick();
    assert.ok(await until(() => started));
    fixture.bot.health = 0;
    fixture.bot.emit("death");
    fixture.bot.health = 20;
    fixture.bot.entity.position = new Vec3(79.5, 66, 134.5);
    fixture.bot.entities[7]!.position = new Vec3(200, 70, 9);
    fixture.bot.emit("respawn");
    finish();
    assert.ok(await until(() => fixture.recorded().length === 1));
    assert.deepEqual(fixture.recorded(), ["fight -> bot_died"]);
    const payload = JSON.parse(
      String(
        fixture.data.read(
          "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex'",
        )[0]!.payload_json,
      ),
    );
    assert.equal(payload.healthBefore, 20);
    assert.equal(payload.healthAfter, 0);
    assert.deepEqual(payload.finalPosition, { x: 12, y: 70, z: 9 });
    assert.deepEqual(payload.finalDistances, [{ id: 7, distance: 3 }]);
    assert.equal(payload.attacks, cleanup === "returns" ? 3 : 0);
    fixture.bot.off("death", cancelOnDeath);
    assert.equal(fixture.bot.listenerCount("death"), fixture.deathListenersAtRest);
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  });
}

test("safe separation answers old distant attack contact, while later damage re-arms it", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      routes += 1;
      fixture.bot.entity.position.x = -20;
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping.
    { entities: { 7: hostile("blaze", 28) }, slots: { 45: { name: "shield" } } },
  );
  fixture.bot.health = 11;
  const shooter = fixture.bot.entities[7]!;
  fixture.bot.emit("entityHurt", fixture.bot.entity, shooter);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> safe_separation"]);
  for (let tick = 0; tick < 5; tick++) {
    fixture.tick();
    await until(() => !fixture.runner.status().busy);
  }
  assert.equal(routes, 1, "already answered contact must not repeatedly claim the same satisfied escape");
  fixture.bot.emit("entityHurt", fixture.bot.entity, shooter);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.equal(routes, 2);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("safe separation cannot erase a new attack observed during the response", async () => {
  const fixture = reflexFixture(
    async (id) => died(id),
    async () => {
      fixture.bot.entity.position.x = -20;
      fixture.bot.emit("entityHurt", fixture.bot.entity, fixture.bot.entities[7]);
      return { status: "completed", elapsedMs: 0 };
    },
    // A shield in the off hand admits guarded retreat; these assertions concern its contact bookkeeping.
    { entities: { 7: hostile("blaze", 28) }, slots: { 45: { name: "shield" } } },
  );
  fixture.bot.health = 11;
  fixture.bot.emit("entityHurt", fixture.bot.entity, fixture.bot.entities[7]);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 1));
  assert.equal(fixture.observer.threats.attackerIds.has(7), true);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("failed evade immediately yields to the newly chosen hide response", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => ({ status: "stopped", reason: "timeout", elapsedMs: 15_000 }), { entities: { 7: hostile("zombie", 3) } },
  );
  fixture.bot.health = 9;
  fixture.tick();
  assert.ok(await until(() => !fixture.runner.status().busy && fixture.recorded().length === 1));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit"]);
  fixture.tick();
  assert.ok(await until(() => fixture.recorded().length === 2));
  assert.deepEqual(fixture.recorded(), ["evade -> capability_limit", "hide -> capability_limit"]);
  await fixture.observer[Symbol.asyncDispose]();
  fixture.data.close();
});

test("evade refreshes a completed route when a newly observed cube is still in contact", async () => {
  let routes = 0;
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      routes++;
      if (routes === 1) {
        fixture.bot.entity.position.x = 40;
        fixture.entities.spawn({ id: 8, ...hostile("magma_cube", 35) });
      } else fixture.bot.entity.position.x = 80;
      return { status: "completed", elapsedMs: 1 };
    }, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(routes, 2);
    assert.equal(result.outcome, "safe_separation");
    assert.ok(result.finalDistances.every((entry) => entry.distance >= 36));
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a cube killed during retreat does not fail separation against its last position", async () => {
  const fixture = reflexFixture(
    async (targetId) => died(targetId),
    async () => {
      fixture.bot.emit("entityDead", fixture.bot.entities[7]!);
      delete fixture.bot.entities[7];
      return { status: "completed", elapsedMs: 1 };
    }, { entities: { 7: hostile("magma_cube", 3) } },
  );
  fixture.bot.health = 11;
  const directive = observeHostileResponse(fixture.bot, fixture.observer.threats);
  assert.equal(directive.kind, "evade");
  try {
    const result = await evadeReceipt(fixture, directive);
    assert.equal(result.outcome, "safe_separation");
    assert.deepEqual(result.finalDistances, []);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

/**
 * The 2026-09-09 livelock, at the observer: a withdrawal interrupted by a hide
 * that left the bot under the hide bar was resumed, dug out of its own box into
 * the same sight line, and was hidden again - seven times, with the model
 * never told. The hide must hand the body back to the model instead.
 */
test("a hide that leaves the bot under the hide bar does not resume a withdrawal", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  }, undefined, { cells: sealedCells(), entities: { 7: hostile("zombie", 12) } });
  // Already sealed in (the cells around the bot), so the hide goes straight to the hold; two health with
  // hunger below the regeneration bar and nothing to eat, so the hold has
  // nothing to wait for and ends at once.
  fixture.bot.health = 2;
  fixture.bot.food = 10;
  seeThroughShelter(fixture.bot);
  // In sight and inside observation range, outside the contact range: under the
  // hide bar that is contact, and the answer is a hide.
  let attempts = 0;
  const input = z.object({});
  const action = defineAction({
    name: "withdraw_test",
    description: "withdraw",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: () => async (context) => {
      attempts++;
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const output = await fixture.runner.run(action, {});
    assert.equal(output.result.status, "failed");
    assert.equal(attempts, 1);
    assert.ok(await until(() => fixture.recorded().length > 0));
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
    const [payload] = fixture.data
      .read(
        "SELECT json_extract(payload_json, '$.evidence.outcome') AS payload_json FROM events WHERE event_type = 'survival_outcome' AND json_extract(payload_json, '$.source') = 'hostile_reflex' ORDER BY event_id",
      )
      .map((row) => JSON.parse(String(row.payload_json)) as { error: string; hide: { enclosed: boolean } });
    assert.equal(payload?.hide.enclosed, true);
    assert.match(payload?.error ?? "", /health is still 2: nothing carried can restore it/);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

test("a recovered hide resumes the same admitted request", async () => {
  const fixture = reflexFixture(async () => {
    throw new Error("A hide must not engage");
  }, undefined, { cells: sealedCells(), entities: { 7: hostile("zombie", 12) } });
  fixture.bot.health = 2;
  seeThroughShelter(fixture.bot);
  let attempts = 0;
  const input = z.object({ count: z.number() });
  const action = defineAction({
    name: "recover_request_test",
    description: "Resume a request after native health recovery",
    inputSchema: input,
    resultSchema: actionResultSchema({}),
    formatResult: (result) => result.status,
    parse: (value: unknown) => input.parse(value),
    execution: { kind: "resumable_task" },
    begin: (request) => async (context) => {
      assert.equal(request.count, 12);
      if (++attempts === 2) return { status: "succeeded" };
      const stopped = new Promise<void>((resolve) =>
        context.signal!.addEventListener("abort", () => resolve(), { once: true }),
      );
      fixture.tick();
      await stopped;
      return { status: "failed", error: "interrupted" };
    },
  });
  try {
    await fixture.controller.policy.edit({
      operation: "set",
      expected_revision: fixture.controller.policy.snapshot().revision,
      changes: { combat: { engagement: "defend_only", hide: "when_exposed" } },
      lifetime: { kind: "session" },
      reason: "test",
    });
    const pending = fixture.runner.run(action, { count: 12 });
    assert.ok(await until(() => fixture.observer.activeResponse() === "hide"));
    fixture.bot.health = 18;
    fixture.tick();
    assert.equal((await pending).result.status, "succeeded");
    assert.equal(attempts, 2);
    assert.deepEqual(fixture.recorded(), ["hide -> hidden"]);
    assert.equal(fixture.runner.status().busy, false);
  } finally {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  }
});

for (const inUse of [false, true]) {
  test(`nearby hostile shield preparation respects active item use (${inUse})`, async () => {
    const fixture = reflexFixture(async () => assert.fail("Preparation must not engage"), undefined, {
      entities: { 7: hostile("zombie", 12) },
      slots: { 10: { name: "shield" } },
    });
    fixture.bot.usingHeldItem = inUse;
    let equips = 0;
    // A spy on the fake's own `equip`, which moves the shield to the off hand.
    const equip = fixture.bot.equip;
    fixture.bot.equip = async (item, destination) => {
      assert.equal(destination, "off-hand");
      equips++;
      await equip(item, destination);
    };
    try {
      fixture.tick();
      if (!inUse) assert.ok(await until(() => equips === 1));
      else await fixture.clock.advance(50);
      fixture.tick();
      assert.equal(equips, inUse ? 0 : 1);
      assert.equal(fixture.bot.usingHeldItem, inUse);
    } finally {
      await fixture.observer.close();
      fixture.data.close();
    }
  });
}

/** A fight neither side can win: the engage waits for its abort, then reports itself cancelled. Time is the fake bot's clock. */
function standoffScene(...zombies: number[]) {
  const engaged: number[] = [];
  const fixture = reflexFixture(
    async (targetId, signal) => {
      engaged.push(targetId);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { ...died(targetId), kind: "cancelled", attacks: 0 };
    },
    undefined,
    {
      runner: { cancelGraceMs: 500 },
      entities: Object.fromEntries(zombies.map((id, index) => [id, hostile("zombie", 3 + index)])),
    },
  );
  /** Time passes in 50 ms slices of the fake clock, with a physics tick at each. */
  const pass = (ms: number) => fixture.clock.advance(ms);
  const decision = () => JSON.stringify(fixture.driver.snapshot()[0]?.decision ?? null);
  const active = () => fixture.runner.status().activeAction?.action === "hostile_reflex";
  const close = async () => {
    await fixture.observer[Symbol.asyncDispose]();
    fixture.data.close();
  };
  return { ...fixture, engaged, pass, active, decision, close };
}

test("a fight with no damage, no movement and no threat gone is released after 30 s and its target stands down 10 s", async () => {
  const scene = standoffScene(7);
  try {
    await scene.pass(29_000);
    assert.ok(scene.active(), "29 s: the window is open");
    await scene.pass(2_000);
    assert.equal(scene.active(), false, "released at 30 s");
    assert.deepEqual(scene.engaged, [7]);
    await scene.pass(8_000);
    assert.deepEqual(scene.engaged, [7], "no new fight on target 7 within the stand-down");
    await scene.pass(3_000);
    assert.deepEqual(scene.engaged, [7, 7], "after 10 s the reflex fights target 7 again");
  } finally {
    await scene.close();
  }
});

test("after the stand-down of its fight the decision picks evade, and target A is not fought again", async () => {
  const scene = standoffScene(7);
  try {
    await scene.pass(31_000);
    assert.equal(scene.active(), false);
    await scene.pass(500);
    assert.ok(scene.recorded().some((outcome) => outcome.startsWith("evade ->")), `an evade ran: ${scene.recorded().join(", ")}`);
    assert.deepEqual(scene.engaged, [7], "the standoff is not fought again while it stands down");
    assert.match(scene.decision(), /"answered"/, "the fight stays excluded as answered");
  } finally {
    await scene.close();
  }
});

/** Runs a standoff for 100 s, giving `mark` at second 20, 40, 60, 80; true when the fight is never released. */
async function keptAlive(mark: (scene: ReturnType<typeof standoffScene>) => void) {
  const scene = standoffScene(7);
  try {
    for (let second = 1; second <= 100; second++) {
      if (second % 20 === 0) mark(scene);
      await scene.pass(1_000);
      if (!scene.active()) return false;
    }
    return true;
  } finally {
    await scene.close();
  }
}

test("blocked hits keep a shielded fight alive past 30 s", async () => {
  assert.equal(await keptAlive((scene) => scene.bot._client.emit("entity_status", { entityId: 1, entityStatus: 29 })), true);
});

test("an answered swing resets the clock", async () => {
  assert.equal(await keptAlive((scene) => scene.bot.emit("entityHurt", scene.bot.entities[7]!, undefined as never)), true);
});

test("a target that moves resets the clock", async () => {
  let x = 3;
  // Back and forth inside contact range: each move is 1.5 blocks from the last mark.
  assert.equal(await keptAlive((scene) => { x = x === 3 ? 1.5 : 3; scene.bot.entities[7]!.position = new Vec3(x, 64, 0); }), true);
});

test("a threat that dies resets the clock", async () => {
  assert.equal(await keptAlive((scene) => scene.bot.emit("entityDead", scene.bot.entities[7]!)), true);
});

test("a standoff with no mark at all is released inside 100 s", async () => {
  assert.equal(await keptAlive(() => {}), false);
});

test("the probes of a limited fight are off after it: no listener is left on the bot or its connection", async () => {
  const scene = standoffScene(7);
  try {
    const before = [scene.bot._client.listenerCount("entity_status"), scene.bot.listenerCount("entityDead"), scene.bot.listenerCount("entityHurt")];
    await scene.pass(31_000);
    assert.equal(scene.active(), false);
    assert.deepEqual([scene.bot._client.listenerCount("entity_status"), scene.bot.listenerCount("entityDead"), scene.bot.listenerCount("entityHurt")], before);
  } finally {
    await scene.close();
  }
});

test("a closed-shelter hold is progress", async () => {
  const closed = (scene: ReturnType<typeof standoffScene>) => {
    for (const [key, block] of Object.entries(sealedCells())) scene.world.setCell(new Vec3(...(key.split(",").map(Number) as [number, number, number])), block);
  };
  assert.equal(await keptAlive(closed), true);
});
