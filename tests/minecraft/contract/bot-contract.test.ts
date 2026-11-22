/**
 * Every contract check on the shared fake bot (the same checks run on a real server: `drivers/bot-contract.ts`).
 * A red check here is a fake that left the game: the fake changes, never the check (spec shared-fake-bot, design 4).
 * Each check runs at offset zero and in lane 3 (moved on x as well): its fixture is written in arena-local coordinates and the fake world is
 * built through the same frame as a lane's scenario, so a check that names a cell without `subject.world` finds no
 * block in the lane (plan 2026-10-23-shared-scenario-server T3).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenerCounts } from "../../../src/test-support/fake-bot/index.ts";
import { AGE_PACKET_TICKS, SERVER_CLOCK_STOPPED_MS } from "../../../src/world/world-age.ts";
import { ZERO_ARENA, arenaFrame, type ArenaFrame } from "../arena/frame.ts";
import { CONTRACT_CHECKS } from "./checks.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject, serverContractSubject } from "./subject.ts";

/** Lane 3 (`LANE_SPACING` 512 on z) with an x offset no lane has, so a check that forgets or doubles either axis is seen. */
const FRAMES: readonly { readonly label: string; readonly frame: ArenaFrame }[] = [
  { label: "offset zero", frame: arenaFrame(ZERO_ARENA) },
  { label: "lane 3, moved on x", frame: arenaFrame({ x: 1024, z: 1536 }) },
];

for (const check of CONTRACT_CHECKS) {
  for (const { label, frame } of FRAMES) {
    for (const rate of check.fakeTickRates ?? [undefined]) {
      const name = `contract ${check.name} holds on the fake bot at ${label}${rate === undefined ? "" : ` (${rate} tps)`}`;
      test(name, { skip: check.waitsForFake }, async () => {
        const harness = fakeHarnessFor(check.fixture, frame, rate === undefined ? {} : { ticksPerSecond: rate });
        using _installed = harness.clock.install();
        await check.run(fakeContractSubject(harness, frame));
      });
    }
  }
}

const FRAME = arenaFrame(ZERO_ARENA);
const DRY_FEET = new Vec3(-2.5, -60, 0.5);
const WET_FEET = new Vec3(0.5, -58.76, 0.5);

for (const ticksPerSecond of [20, 10]) {
  const oneTick = 1_000 / ticksPerSecond;

  test(`fixed body and source reads wait for observed server age at ${ticksPerSecond} tps`, async () => {
    const lagMs = 32 * oneTick;
    const harness = createFakeBot({ position: DRY_FEET, lagMs, server: { ticksPerSecond }, cells: { "0,-58,0": "water" } });
    const { bot, clock, server } = harness;
    const subject = fakeContractSubject(harness, FRAME);
    const baseline = listenerCounts(bot);
    const source = new Vec3(0, -58, 0);
    // Send at an age packet so the full observed budget is available to the delayed answer.
    const atAgePacket = () => clock.advance((AGE_PACKET_TICKS - server.gameTime % AGE_PACKET_TICKS) * oneTick);
    {
      using _hold = subject.holdBodyStill();
      await subject.teleportFeet(DRY_FEET);
      await atAgePacket();
      const started = clock.now();
      assert.deepEqual(await subject.readBodyOnServer(), { feet: DRY_FEET, air: 300 });
      assert.ok(clock.now() - started >= lagMs);
      await atAgePacket();
      assert.equal(await subject.blockIs(source, "water", { level: 0 }), true);
      await atAgePacket();
      assert.equal(await subject.blockIs(source, "water", { level: 1 }), false);
      server.stop();
      const stopped = bot.time.age;
      const stoppedAt = clock.now();
      await assert.rejects(subject.readBodyOnServer(), /server stalled/);
      assert.equal(clock.now() - stoppedAt, SERVER_CLOCK_STOPPED_MS);
      await assert.rejects(subject.blockIs(source, "water", { level: 0 }), /server stalled/);
      assert.equal(bot.time.age, stopped);
    }
    assert.deepEqual(listenerCounts(bot), baseline);
  });

  test(`a missing fixed move expires before a late server answer at ${ticksPerSecond} tps`, async () => {
    const harness = createFakeBot({ position: DRY_FEET, lagMs: 450, server: { ticksPerSecond } });
    const { bot, clock, server } = harness;
    const subject = fakeContractSubject(harness, FRAME);
    const baseline = listenerCounts(bot);
    const physics = bot.physicsEnabled;
    server.stop();
    {
      using _hold = subject.holdBodyStill();
      await assert.rejects(subject.teleportFeet(WET_FEET), /server stalled/);
      assert.equal(clock.now(), SERVER_CLOCK_STOPPED_MS);
      assert.equal(server.gameTime, 24_000);
      assert.equal(bot.physicsEnabled, physics, "expiry retires the controlled body");
      assert.deepEqual(listenerCounts(bot), baseline);
    }
    server.resume();
    await clock.advance(450 + oneTick);
    assert.equal(server.serverPositionOf(bot.entity.id), null);
    assert.deepEqual(bot.entity.position, DRY_FEET);
    assert.equal(bot.physicsEnabled, physics);
    assert.deepEqual(listenerCounts(bot), baseline);
  });

  test(`respawn retires a pending fixed move and its prior server feet at ${ticksPerSecond} tps`, async () => {
    const harness = createFakeBot({ position: DRY_FEET, lagMs: 450, server: { ticksPerSecond } });
    const { bot, clock, server } = harness;
    const subject = fakeContractSubject(harness, FRAME);
    const baseline = listenerCounts(bot);
    const physics = bot.physicsEnabled;
    {
      using _hold = subject.holdBodyStill();
      await subject.teleportFeet(WET_FEET);
      clock.after(oneTick, () => {
        bot.emit("respawn");
        server.sendPosition(DRY_FEET);
      });
      await assert.rejects(subject.teleportFeet(WET_FEET.offset(1, 0, 0)), /fixed body changed/);
      await clock.advance(450 + oneTick);
      assert.deepEqual(bot.entity.position, DRY_FEET);
      assert.deepEqual(server.serverPositionOf(bot.entity.id), WET_FEET, "the old store entry cannot answer for the new body");
      await assert.rejects(subject.readBodyOnServer(), /no controlled server feet/);
      assert.equal(bot.physicsEnabled, physics, "respawn ends the hold before disposal");
      assert.deepEqual(listenerCounts(bot), baseline);
    }
    assert.deepEqual(listenerCounts(bot), baseline);
  });

  test(`real subject source queries accept slow correlated replies at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, server } = createFakeBot({ clock, lagMs: 32 * oneTick, server: { ticksPerSecond } });
    using _timers = clock.install();
    bot.chat = (command) => {
      if (!command.startsWith("/tellraw @s ")) return;
      const { text } = JSON.parse(command.slice("/tellraw @s ".length));
      server.answer(() => bot.emit("messagestr", `${text}1`, "system", {} as never));
    };
    const subject = serverContractSubject(bot, FRAME);
    const baseline = listenerCounts(bot);
    const cell = new Vec3(0, -58, 0);
    assert.equal(await clock.settle(subject.blockIs(cell, "water", { level: 0 }), 40 * oneTick), true);
    server.stop();
    const stalled = assert.rejects(subject.blockIs(cell, "water", { level: 0 }), /server stalled/);
    await clock.settle(stalled, SERVER_CLOCK_STOPPED_MS + oneTick);
    assert.deepEqual(listenerCounts(bot), baseline);
  });
}

test("real subject rejects incomplete or invalid body replies and drops the listener", async () => {
  const { bot } = createFakeBot();
  const subject = serverContractSubject(bot, FRAME);
  const baseline = listenerCounts(bot);
  for (const [response, expected] of [
    ["1 300 1 500", /malformed reply/],
    ["1 300 1 500 0 0 1 500", /missing or invalid Air or Pos/],
    ["1 300 1 500 1 -58760.5 1 500", /missing or invalid Air or Pos/],
  ] as const) {
    bot.chat = (command) => {
      if (!command.startsWith("/tellraw @s ")) return;
      const { text } = JSON.parse(command.slice("/tellraw @s ".length));
      bot.emit("messagestr", `${text}${response}`, "system", {} as never);
    };
    await assert.rejects(subject.readBodyOnServer(), expected);
    assert.deepEqual(listenerCounts(bot), baseline);
  }
});
