// The evade's clock of server ticks (`evade-clock.ts`) in every phase and every exit; the reach, cover and goal behaviour is `evade.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { completeResponse, describeResponse } from "../control/combat/settlement.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { evade } from "./evade.js";
import {
  abortedOrStopped, assertEndedOnTicks, EVADE_BUDGET_MS, evadeWallMs, judgements, leavesNothing, NAVIGATION_TIMEOUT, PACKET_TICKS,
  pursueEqualSpeed, reachFixture, slowFixture, ZOMBIE,
} from "./evade-fixture.test.js";

/**
 * An evade whose settled body holds its shield against a fireball that never clears: the projectile guard ends at the
 * evade budget, though the wall clock steps by `wallStepMs` a second in. Returns the clock the evade ran.
 */
async function evadeGuardedUntilBudgetAcrossWallStep(wallStepMs: number, ticksPerSecond = 20) {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot, entities } = createFakeBot({
    clock,
    server: { ticksPerSecond },
    slots: { 45: { name: "shield" } },
    entities: { [ZOMBIE]: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  clock.stepWallClock(5_000);
  entities.spawn({ id: 8, name: "small_fireball", width: 0.3125, position: new Vec3(4, 64.9, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  clock.after(1_000, () => clock.stepWallClock(wallStepMs));
  const world = new MemoryWorld();
  for (let x = -6; x <= 6; x++)
    for (let z = -6; z <= 6; z++) {
      world.load({ x, y: 63, z }, { stateId: 1 });
      world.load({ x, y: 64, z }, { stateId: 0 });
      world.load({ x, y: 65, z }, { stateId: 0 });
    }
  const navigation = {
    world,
    navigate: async () => assert.fail("a settled body under fire guards before it routes"),
  } as unknown as NavigationRuntime;
  const context = { ...combatTestContext(bot), policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: EVADE_BUDGET_MS } };
  const threat = { id: ZOMBIE, name: "zombie", position: { x: 2.5, y: 64, z: 0.5 }, distance: 2 };
  const started = clock.now();
  const result = await clock.settle(
    evade(bot, navigation, { kind: "evade", threats: [threat], safeRange: 36, reason: "hurt" }, context, bot.health, new AbortController().signal),
    evadeWallMs(EVADE_BUDGET_MS) + 1_000,
  );
  return { ranMs: clock.now() - started, result };
}

// A 3 s budget is 60 world ticks: the guard ends at the first time packet at or past them (20 tps: ~3 s of clock; 10 tps: ~6 s).
for (const { wallStepMs, ticksPerSecond } of [{ wallStepMs: -800, ticksPerSecond: 20 }, { wallStepMs: 1_200, ticksPerSecond: 20 }, { wallStepMs: 0, ticksPerSecond: 10 }]) {
  test(`the retreat guard ends at the evade's 60 ticks at ${ticksPerSecond} tps${wallStepMs ? `: a ${wallStepMs} ms wall step during the guard changes nothing` : ""}`, async () => {
    const { ranMs, result } = await evadeGuardedUntilBudgetAcrossWallStep(wallStepMs, ticksPerSecond);
    const expectedMs = EVADE_BUDGET_MS * 20 / ticksPerSecond;
    assert.equal(result.result.kind, "exhausted", "the clock's abort is the budget ending, not a failure");
    assert.ok(result.elapsedTicks! >= 60 && result.elapsedTicks! < 60 + PACKET_TICKS, `elapsed ${result.elapsedTicks} ticks`);
    assert.ok(ranMs >= expectedMs - 100 && ranMs < expectedMs + 1_100 + (ticksPerSecond === 10 ? 1_000 : 0), `the evade ran ${ranMs} ms of clock`);
  });
}

// An equal-speed pursuer keeps its 9-block gap: both bodies move 0.1 blocks per SERVER tick, so no basis is ever granted,
// the budget is 300 world ticks whatever the server rate, and the pursuer stays judged advancing between every two packets
// (the freshness limit is 30 ticks of the server's own cadence, 3 000 ms at 10 tps, not 1 500).
for (const [ticksPerSecond, minMs, maxMs] of [[20, 15_000, 16_100], [10, 30_000, 32_100]] as const) {
  test(`the evade's budget is 300 world ticks at ${ticksPerSecond} tps (${minMs}-${maxMs} ms of clock), the pursuer advancing throughout`, async () => {
    const fixture = reachFixture({ distance: 9, ticksPerSecond });
    using _installed = fixture.clock.install();
    pursueEqualSpeed(fixture);
    let settled = false;
    const { value: result, judged } = await judgements(fixture, async () => {
      const raw = fixture.begin().finally(() => { settled = true; });
      fixture.clock.after(minMs - 1_000, () => assert.equal(settled, false, `still running 1 s short of ${minMs} ms`));
      return await fixture.clock.settle(raw, evadeWallMs(15_000) + 1_000);
    });
    assert.equal(result.result.kind, "exhausted");
    assert.deepEqual(judged.filter(({ basis }) => basis !== null), [], "no basis at any look");
    // The window of 40 ticks is full from the third packet on (4 s at 10 tps): from then on never unknown, between any two packets.
    const afterWindow = judged.filter(({ at }) => at > 4_100);
    assert.ok(afterWindow.length > 0);
    assert.deepEqual(afterWindow.filter(({ advancing }) => advancing !== true).map(({ at }) => at), [], "advancing at every look after the window filled");
    assert.ok(result.elapsedTicks! >= 300 && result.elapsedTicks! < 300 + PACKET_TICKS, `elapsed ${result.elapsedTicks} ticks`);
    assert.ok(result.elapsedMs >= minMs && result.elapsedMs < maxMs, `elapsed ${result.elapsedMs} ms`);
    // The numbers the model reads: the gap held at 9 blocks, nothing gained, the pursuer still following.
    assert.ok(Math.abs(result.ends[0]!.distance - 9) < 0.01 && Math.abs(result.ends[0]!.gained) < 0.01);
    assert.equal(result.result.kind === "exhausted" && result.result.reason.startsWith(NAVIGATION_TIMEOUT), true);
    assert.match(result.result.kind === "exhausted" ? result.result.reason : "", /zombie#7 is 9\.0 blocks away \(gained 0\.0\), still following\.$/);
  });
}

// The same pursuer when the server stops at 14.1 s: still advancing up to the limit (30 ticks of its cadence) after the
// last packet, unknown only past it.
for (const [ticksPerSecond, staleAfterMs] of [[20, 1_500], [10, 3_000]] as const) {
  test(`a pursuer is unknown only past ${staleAfterMs} ms of a server stopped at ${ticksPerSecond} tps`, async () => {
    const fixture = reachFixture({ distance: 9, ticksPerSecond });
    using _installed = fixture.clock.install();
    pursueEqualSpeed(fixture);
    const packets: number[] = [];
    fixture.bot.on("time", () => { packets.push(fixture.clock.now()); });
    const stopAt = 14_100;
    fixture.clock.after(stopAt, () => fixture.server.stop());
    const { judged } = await judgements(fixture, () => fixture.run());
    const lastPacket = packets.filter((at) => at <= stopAt).at(-1)!;
    const stopped = judged.filter(({ at }) => at > stopAt);
    assert.ok(stopped.some(({ at }) => at - lastPacket <= staleAfterMs - 100), "judged within the limit after the stop");
    assert.deepEqual(stopped.filter(({ at, advancing }) => at - lastPacket <= staleAfterMs && advancing !== true), [], "still advancing up to the limit");
    assert.ok(stopped.some(({ at }) => at - lastPacket >= staleAfterMs + 50), "judged past the limit");
    assert.deepEqual(stopped.filter(({ at, advancing }) => at - lastPacket >= staleAfterMs + 50 && advancing !== null), [], "unknown after it");
  });
}

// A route that ignores its own timeout stops only on the evade clock: on ticks while the server runs (physics running or
// not), on the wall timer when the server is stopped (physics needed by neither).
for (const { name, ticksPerSecond, physics, server } of [
  { name: "10 tps, physics and server running", ticksPerSecond: 10, physics: true, server: true },
  { name: "20 tps, physics stopped, server running", ticksPerSecond: 20, physics: false, server: true },
  { name: "20 tps, physics and server stopped", ticksPerSecond: 20, physics: false, server: false },
]) test(`the route stops on the evade clock, however it ignores its own timeout: ${name}`, async () => {
  const fixture = reachFixture({ distance: 9, budget: EVADE_BUDGET_MS, ticksPerSecond });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  const origin = fixture.bot.time.age!;
  let timeout: number | undefined;
  let stoppedAtTicks = -1;
  fixture.navigation.navigate = async ({ stopSignal, timeoutMs }) => {
    timeout = timeoutMs;
    await abortedOrStopped(stopSignal);
    stoppedAtTicks = fixture.bot.time.age! - origin;
    return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 0 };
  };
  fixture.bot.physicsEnabled = physics;
  if (!server) fixture.server.stop();
  const result = await fixture.run();
  assert.equal(result.result.kind, "exhausted", "the clock's abort is the budget ending, not a failure");
  assert.equal(timeout, evadeWallMs(EVADE_BUDGET_MS), "the route's own timeout is the wall left");
  if (server) {
    assert.ok(stoppedAtTicks >= 60 && stoppedAtTicks < 60 + PACKET_TICKS, `age moved ${stoppedAtTicks}`);
    assert.ok(result.elapsedTicks! >= 60 && result.elapsedTicks! < 60 + PACKET_TICKS, `elapsed ${result.elapsedTicks} ticks`);
    assert.ok(result.elapsedMs < evadeWallMs(EVADE_BUDGET_MS), "ended on ticks, before the wall");
  } else {
    assert.equal(result.elapsedMs, evadeWallMs(EVADE_BUDGET_MS), "ended on the wall timer, no physics or server needed");
    assert.equal(result.elapsedTicks, 0);
  }
  await nothingLeft();
});

for (const ticksPerSecond of [20, 10]) test(`an inward crossing below the cover range while occluded leaves the wait at ${ticksPerSecond} tps`, async () => {
  const fixture = reachFixture({ shooter: true, distance: 9, cover: true, ticksPerSecond });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  const start = fixture.server.gameTime;
  let crossing: number | undefined;
  let released: number | undefined;
  let routes = 0;
  fixture.navigation.navigate = async () => {
    if (++routes === 2) {
      released = fixture.server.gameTime - start;
      fixture.bot.entities[7]!.position.x = 80;
    }
    return { status: "completed", elapsedMs: 0 };
  };
  const stopMoving = fixture.server.onTick(() => {
    if (routes !== 1) return;
    const shooter = fixture.bot.entities[7]!;
    shooter.position.x = Math.max(8, shooter.position.x - 0.1);
    if (crossing === undefined && shooter.position.distanceTo(fixture.bot.entity.position) < 8)
      crossing = fixture.server.gameTime - start;
  });
  const result = await fixture.run();
  stopMoving();
  assert.ok(crossing !== undefined);
  assert.ok(released !== undefined, "the wait replans after the inward crossing");
  assert.ok(released - crossing <= 20, `crossed at ${crossing}, released at ${released}`);
  assert.equal(result.result.kind, "separated");
  await nothingLeft();
});

/**
 * A guard entered late: the route runs 50 server ticks, then a fireball that never clears is seen, the route stops for
 * the shield guard and the guard holds. The guard shares the attempt's 60 ticks: it ends at 60-80, not 110 or more.
 */
test("a projectile guard entered at tick 50 ends with the evade's 60 ticks at 10 tps", async () => {
  const fixture = slowFixture({ slots: { 45: { name: "shield" } } });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  fixture.navigation.navigate = async ({ stopSignal }) => {
    await abortedOrStopped(stopSignal);
    return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 0 };
  };
  const startGameTime = fixture.server.gameTime;
  let spawned = false;
  fixture.server.onTick(() => {
    if (spawned || fixture.server.gameTime - startGameTime < 50) return;
    spawned = true;
    fixture.entities.spawn({ id: 8, name: "small_fireball", width: 0.3125, position: new Vec3(4, 64.9, 0.5), velocity: new Vec3(-0.5, 0, 0) });
  });
  const result = await fixture.run();
  assertEndedOnTicks(result, fixture.ticksSpent());
  assert.equal(result.projectileGuards, 1, "the guard was entered");
  assert.ok(result.ends[0]!.basis === null);
  await nothingLeft();
});

test("a loadout whose answer never comes stops on the evade clock at 10 tps", async () => {
  const fixture = slowFixture({ slots: { 10: { name: "iron_sword" } } });
  using _installed = fixture.clock.install();
  const nothingLeft = leavesNothing(fixture);
  // Stopgap: the shared fake equips at once (`fake-inventory.ts` `equip`), with no server answer to be late. Replace this
  // with a late answer when the fake has one (the master: a contract check of the equip answer first, then the fake).
  fixture.bot.equip = () => new Promise<void>(() => undefined);
  const result = await fixture.run();
  assertEndedOnTicks(result, fixture.ticksSpent());
  assert.equal(fixture.routes(), 0, "the evade never left the loadout");
  await nothingLeft();
});

// Exit matrix at 20 tps (budget 2 s: 40 ticks, 6 s wall): every exit settles once, leaves no listener, clock timer or
// global timer, nothing fires past its old wall, and the next evade on the same bot starts and finishes (T6, T13).
// The disengaged completion is `a melee threat that stops following ends the evade separated` in `evade.test.ts`.
const EXITS = ["ticks", "wall", "caller abort", "reflex takeover", "caller abort as the clock ends", "threat death",
  "cleanup throws"] as const;
for (const exit of EXITS) {
  test(`an evade that ends by ${exit} settles once and leaves nothing behind`, async () => {
    const guarded = exit === "cleanup throws";
    const fixture = reachFixture({ distance: 9, budget: 2_000, slots: guarded ? { 45: { name: "shield" } } : undefined });
    using _installed = fixture.clock.install();
    const nothingLeft = leavesNothing(fixture);
    const cancel = new AbortController();
    if (exit === "ticks") pursueEqualSpeed(fixture);
    if (exit === "wall") fixture.server.stop();
    if (exit === "caller abort") fixture.clock.after(500, () => cancel.abort());
    if (exit === "reflex takeover") fixture.clock.after(500, () => cancel.abort(new Error("a reflex took the body")));
    if (exit === "threat death") fixture.clock.after(500, () => fixture.bot.emit("entityDead", fixture.bot.entities[7]!));
    if (exit === "caller abort as the clock ends") {
      // The caller's cancel lands in the very instant the clock's abort stops the route.
      fixture.navigation.navigate = async ({ stopSignal }) => {
        await abortedOrStopped(stopSignal);
        cancel.abort(new Error("a reflex took the body"));
        return { status: "stopped", reason: String(stopSignal?.reason), elapsedMs: 0 };
      };
    }
    const releaseShield = fixture.bot.deactivateItem;
    if (guarded) {
      // A fireball that never clears holds the guard until the clock ends it; releasing the shield then throws.
      fixture.entities.spawn({ id: 8, name: "small_fireball", width: 0.3125, position: new Vec3(4, 64.9, 0.5), velocity: new Vec3(-0.5, 0, 0) });
      fixture.bot.deactivateItem = () => { throw new Error("shield release failed"); };
    }
    let settlements = 0;
    const result = await fixture.run(cancel.signal).then((value) => { settlements++; return value; });
    // A cancel during a route is a stopped route (the settlement makes it `cancelled`); one during a wait throws `failed`;
    // a cleanup that throws is the evade's failure, never hidden as the budget ending.
    const expected = { ticks: "exhausted", wall: "exhausted", "caller abort": "exhausted", "reflex takeover": "exhausted",
      "caller abort as the clock ends": "exhausted", "threat death": "separated", "cleanup throws": "failed" }[exit];
    assert.equal(result.result.kind, expected);
    if (exit === "caller abort" || exit === "reflex takeover") {
      assert.equal(completeResponse(result, cancel.signal).kind, "cancelled");
      assert.equal(result.elapsedMs, 500);
    }
    if (exit === "reflex takeover" && result.result.kind === "exhausted") assert.ok(result.result.reason.includes("a reflex took the body"), result.result.reason);
    if (exit === "caller abort as the clock ends") assert.equal(completeResponse(result, cancel.signal).kind, "cancelled", "the caller's cancel wins the durable result");
    if (exit === "threat death") {
      assert.equal(result.ends[0]?.basis, "dead");
      assert.equal(result.elapsedTicks, 0, "no time packet came in the first 500 ms");
    }
    if (exit === "wall") {
      assert.equal(result.elapsedMs, evadeWallMs(2_000));
      assert.equal(result.elapsedTicks, 0, "no packet came after the first age: the ticks stand at the origin");
      assert.equal(result.ends[0]?.basis, null);
    }
    if (exit === "ticks") assert.ok(result.elapsedTicks! >= 40 && result.elapsedTicks! < 40 + PACKET_TICKS);
    if (result.result.kind === "failed") assert.equal(result.result.reason, "shield release failed");
    if (guarded) assert.equal(result.projectileGuards, 1, "the guard was entered");
    await nothingLeft();
    assert.equal(settlements, 1);
    // The next action from this end state: another evade starts on the same bot and finishes.
    fixture.bot.deactivateItem = releaseShield;
    fixture.server.resume();
    if (guarded) fixture.entities.remove(8);
    fixture.bot.entities[7]!.position.x = fixture.bot.entity.position.x + 40;
    assert.equal((await fixture.run()).result.kind, "separated");
  });
}

test("an on-foot evade that never heard a world age reports null ticks, in its result and its receipt, and the wall ends it", async () => {
  const fixture = reachFixture({ distance: 9, budget: 2_000, timePacketYet: false });
  using _installed = fixture.clock.install();
  fixture.server.stop();
  const result = await fixture.run();
  assert.equal(result.result.kind, "exhausted");
  assert.equal(result.elapsedMs, evadeWallMs(2_000));
  assert.equal(result.elapsedTicks, null);
  assert.equal((describeResponse(completeResponse(result, new AbortController().signal)) as Record<string, unknown>).elapsedTicks, null);
});
