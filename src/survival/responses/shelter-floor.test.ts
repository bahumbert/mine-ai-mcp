// A grounded body straddling a floor edge builds its shelter over the floor that holds its centre (plan
// 2026-11-18-scenario-reds-part3-a2 T18f, D31). The recorded geometry is the an-ender-slope probe: the bot at z 40.165
// rests on the z 39 floor, so its feet cell (z 40) is over air.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { exactBlockGoal } from "../../navigation/goals/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { createNavigationRuntime } from "../../navigation/runtime.js";
import { liveBlockReader, MineflayerWorldView } from "../../navigation/mineflayer/world.js";
import { navigationFeet, safeSupportingCell } from "../../navigation/world/block-geometry.js";
import { combatTestContext } from "../../test-support/combat.js";
import { type FakeBotOptions, type FakeCell, createFakeBot, createFakeClock, type FakeClock } from "../../test-support/fake-bot/index.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { hideInPlace } from "./hide.js";
import type { ShelterBuild } from "./shelter-build.js";
import { shelterFeet } from "./shelter-cells.js";
import { constructShelterPass } from "./shelter-construction.js";

const EDGE = new Vec3(104.3, 68, 40.16503339705205);
const CENTRE = new Vec3(104.5, 68, 39.5);
const RECORDED_CELLS: Readonly<Record<string, FakeCell>> = { "104,66,39": 6018, "104,67,39": 19604, "104,66,40": 19604 };
const TICK_RATES = [20, 10] as const;

/** The recorded scene: a grounded body under physics, its cells merged over the recorded ones. */
function recordedScene(clock: FakeClock, ticksPerSecond: number, position: Vec3, extra: Partial<FakeBotOptions> = {}, cells: Readonly<Record<string, FakeCell>> = {}) {
  return createFakeBot({
    clock, position, groundY: null, simulatePhysics: true, server: { ticksPerSecond }, health: 20,
    carried: { cobblestone: 32 }, cells: { ...RECORDED_CELLS, ...cells }, ...extra,
  });
}

function hideOptions(bot: Parameters<typeof combatTestContext>[0], recoverTo = 18) {
  return { signal: new AbortController().signal, threatContext: combatTestContext(bot), maximumMs: 5_000, recoverTo };
}

for (const ticksPerSecond of TICK_RATES) for (const overEdge of [true, false]) {
  test(`shelter cell ${overEdge ? "over the recorded edge" : "over the same floor's centre"} at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = recordedScene(clock, ticksPerSecond, overEdge ? EDGE : CENTRE);
    using _installed = clock.install();
    assert.ok(bot.entity.onGround);
    const world = new MineflayerWorldView(bot);
    const position = bot.entity.position;
    assert.deepEqual(navigationFeet(position, true), { x: 104, y: 68, z: overEdge ? 40 : 39 });
    assert.deepEqual(safeSupportingCell(world, position), { x: 104, y: 68, z: 39 });
    assert.deepEqual(shelterFeet(bot), new Vec3(104, 68, 39));
    const result = await clock.settle(hideInPlace(bot, hideOptions(bot)), 6_000);
    assert.equal(result.kind, "recovered", JSON.stringify(result));
    assert.ok(result.walled > 0);
    assert.ok(result.capped);
    assert.equal(bot.entity.position.floored().toString(), "(104, 68, 39)");
  });
}

// Controls: a neighbour of the footprint that is another height, damaging or unloaded keeps today's answer (D31).
const NEIGHBOUR_CONTROLS = ["stone_slab", "magma_block", "lava"] as const;
for (const ticksPerSecond of TICK_RATES) for (const neighbour of NEIGHBOUR_CONTROLS) {
  test(`shelter cell keeps today's answer over a ${neighbour} beside the edge at ${ticksPerSecond} tps`, () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = recordedScene(clock, ticksPerSecond, EDGE, {}, { "104,67,40": neighbour });
    using _installed = clock.install();
    const today = navigationFeet(bot.entity.position, bot.entity.onGround);
    assert.deepEqual(shelterFeet(bot), new Vec3(today.x, today.y, today.z));
  });
}

for (const ticksPerSecond of TICK_RATES) test(`shelter cell keeps today's answer over an unloaded neighbour at ${ticksPerSecond} tps`, () => {
  const clock = createFakeClock({ mode: "mocked" });
  // The body stands in chunk (6, 2); the cell at z 48 is in chunk (6, 3), which is not loaded.
  const { bot } = createFakeBot({
    clock, position: new Vec3(104.3, 68, 47.9), groundY: null, simulatePhysics: true, server: { ticksPerSecond },
    health: 20, carried: { cobblestone: 32 }, cells: { "104,66,47": 6018, "104,67,47": 19604 },
    loadedColumns: [[6, 2]],
  });
  using _installed = clock.install();
  assert.equal(liveBlockReader(bot)(104, 67, 48).kind, "unloaded");
  const today = navigationFeet(bot.entity.position, bot.entity.onGround);
  assert.deepEqual(shelterFeet(bot), new Vec3(today.x, today.y, today.z));
});

// Controls: the floor under the body's centre cell is another height or damaging, so the answer is today's.
for (const ticksPerSecond of TICK_RATES) for (const floor of NEIGHBOUR_CONTROLS) {
  test(`shelter cell keeps today's answer over a ${floor} floor under the centre at ${ticksPerSecond} tps`, () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = recordedScene(clock, ticksPerSecond, CENTRE, {}, { "104,67,39": floor });
    using _installed = clock.install();
    const today = navigationFeet(bot.entity.position, bot.entity.onGround);
    assert.deepEqual(shelterFeet(bot), new Vec3(today.x, today.y, today.z));
  });
}

test("shelter cell keeps today's answer for an airborne body", () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, position: new Vec3(104.5, 71, 39.5), groundY: null, simulatePhysics: false, health: 20,
  });
  using _installed = clock.install();
  Object.assign(bot.entity, { onGround: false });
  const today = navigationFeet(bot.entity.position, false);
  assert.deepEqual(shelterFeet(bot), new Vec3(today.x, today.y, today.z));
});

/** A construction attempt for one pass, as the shelter's own tests build it. */
function passBuild(bot: ReturnType<typeof createFakeBot>["bot"], clock: FakeClock): ShelterBuild {
  return {
    bot, options: { signal: new AbortController().signal, threatContext: combatTestContext(bot), maximumMs: 5_000, recoverTo: 18 },
    itemUse: new CombatItemUse(bot, (ticks) => clock.sleep(ticks * 50)),
    constructionDeadline: clock.now() + 5_000, enclosed: false,
    dug: 0, walled: 0, capped: false, ate: null, swings: 0, recovery: null, refusal: null,
    pass: 0, blockedCells: new Map(),
  };
}

// The supporting block goes while the body centres (its first steering press). The pass gives way ("again") and no
// block is placed on the old feet cell, which the body no longer stands over.
for (const ticksPerSecond of TICK_RATES) test(`a floor removed while the pass centres gives way and places nothing on the old feet cell at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  let removed = false;
  const { bot, world } = recordedScene(clock, ticksPerSecond, EDGE, {
    overrides: {
      setControlState: (_control, state) => {
        if (!state || removed) return;
        removed = true;
        world.setCell(new Vec3(104, 67, 39), "air");
      },
    },
  });
  using _installed = clock.install();
  const result = await clock.settle(constructShelterPass(passBuild(bot, clock)), 6_000);
  assert.ok(removed, "the floor was never removed: the centring did not steer");
  assert.equal(result, "again", JSON.stringify(result));
  assert.equal(world.blockAt(new Vec3(104, 68, 39))?.name ?? "air", "air");
});

// The next action from each end state: a recovered shelter, or one cancelled while its second placement is in flight
// (one block down, the partly built shell). The real navigation runtime walks the bot one block through the wall (its
// dig answered by the server as the shelter's own fence test does) and must end within its bound.
// Measured on the fake at 20 tps: the navigate completes in 20.45 s of clock after a recovered shelter.
for (const ticksPerSecond of TICK_RATES) for (const ending of ["recovered", "cancelled"] as const) {
  test(`a one-block navigate ends within its bound after a ${ending} shelter over the recorded edge at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, world, server } = recordedScene(clock, ticksPerSecond, EDGE, {}, { "105,67,39": 19604 });
    using _installed = clock.install();
    const abort = new AbortController();
    if (ending === "cancelled") {
      // The second placement's equip is in flight when the hide is cancelled: the first block is down, the pass stops.
      const equip = bot.equip;
      let placements = 0;
      bot.equip = async (...args) => {
        placements += 1;
        if (placements === 2) abort.abort(new Error("hide cancelled"));
        return equip.apply(bot, args);
      };
    }
    const shelter = clock.settle(hideInPlace(bot, { ...hideOptions(bot), signal: abort.signal }), 6_000);
    if (ending === "recovered") assert.equal((await shelter).kind, "recovered");
    else await assert.rejects(shelter, /hide cancelled/);
    // The server answers a dig with the removal, as in the fence test (the fork's dig predicts air).
    const stop = server.onPacket("block_dig", (data) => {
      const packet = data as { status: number; location: Vec3 };
      if (packet.status === 2) clock.after(50, () => {
        world.setCell(packet.location, "air");
        bot._client.emit("block_change", { location: packet.location, type: 0 });
      });
    });
    try {
      await using navigation = createNavigationRuntime(bot);
      const next = await clock.settle(navigation.navigate({
        movements: createMovementPolicy(), goal: exactBlockGoal({ x: 105, y: 68, z: 39 }),
      }), 60_000);
      assert.equal(next.status, "completed", JSON.stringify(next));
      assert.ok(bot.entity.position.x > 105, bot.entity.position.toString());
    } finally { stop(); }
  });
}

// The server is frozen while the clock goes on: the hide ends in its bounded failure (a deadline refusal, measured
// at 25.35 s of clock at 20 tps), with the world age still. The bound is the server's wait, not the 5 s hide budget.
for (const ticksPerSecond of TICK_RATES) test(`hide with the server stopped ends in its bounded failure at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = recordedScene(clock, ticksPerSecond, EDGE);
  using _installed = clock.install();
  server.stop();
  const age = server.gameTime;
  const result = await clock.settle(hideInPlace(bot, hideOptions(bot)), 60_000);
  assert.equal(server.gameTime, age);
  assert.equal(result.kind, "failed", JSON.stringify(result));
  assert.equal(result.refusal?.cause, "deadline", JSON.stringify(result));
});
