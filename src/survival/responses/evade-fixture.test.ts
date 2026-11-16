// Shared fixtures of the evade tests (`evade.test.ts`: reach, cover and budget behaviour; `evade-phases.test.ts`: the clock
// of server ticks in every phase and exit). A helper file, not a test file: it registers no test.
import assert from "node:assert/strict";
import { after } from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, itemOf, listenersAddedSince, type FakeBotOptions } from "../../test-support/fake-bot/index.js";
import { observation } from "../../test-support/navigation.js";
import type { Goal } from "../../navigation/index.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { evade } from "./evade.js";
import { EvadeObservation } from "./evade-observation.js";

export const EVADE_BUDGET_MS = 3_000;
export const ROUTE_MS = 1_000;
export const ZOMBIE = 7;
/** The evade's wall backstop (3x the game time of its budget at 20 tps): the fixture's settle bound is this plus 1 s. */
export const evadeWallMs = (budgetMs: number) => budgetMs * 3;
/** A time packet comes every 20 server ticks: an end counted in ticks shows at the first packet at or past its count. */
export const PACKET_TICKS = 20;
export const NAVIGATION_TIMEOUT = "Emergency evade stopped without settled safe separation: navigation timeout";

/** A route double that only ends on its stop signal, also when that signal was aborted before the route began. */
export function abortedOrStopped(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Shared game clock and body, with navigation stopping only at its signal or timeout. */
export function reachFixture({ shooter = false, distance = 17, budget = 15_000, cover = false, ticksPerSecond = 20,
  timePacketYet = true, slots }: { shooter?: boolean; distance?: number; budget?: number; cover?: boolean; ticksPerSecond?: number;
  timePacketYet?: boolean; slots?: FakeBotOptions["slots"] } = {}) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), slots,
    server: { ticksPerSecond, timePacketYet },
    position: new Vec3(0.5, 64, 0.5), groundY: 63,
    entities: { 7: { name: shooter ? "skeleton" : "zombie", position: new Vec3(distance + 0.5, 64, 0.5) } } });
  if (shooter) harness.bot.entities[7]!.equipment[0] = itemOf(harness.bot.registry, "bow", 1);
  const world = new MemoryWorld();
  for (let x = -40; x <= 80; x++) for (let z = -2; z <= 2; z++)
    for (let y = 63; y <= 66; y++) world.load({ x, y, z }, { stateId: y === 63 ? 1 : 0 });
  const wall = (present: boolean) => {
    for (let y = 64; y <= 67; y++) for (let z = -2; z <= 2; z++)
      harness.world.setCell(new Vec3(4, y, z), present ? "stone" : "air");
  };
  wall(cover);
  const stops: string[] = [];
  let routes = 0;
  let goal: Goal | undefined;
  const navigation: { world: MemoryWorld; navigate: NavigationRuntime["navigate"] } = { world, navigate: async ({ goal: received, signal, stopSignal, timeoutMs }) => {
    goal = received;
    routes++;
    return await new Promise<{ status: "stopped"; reason: string; elapsedMs: number }>((resolve) => {
      const started = harness.clock.now();
      const finish = () => {
        cancel();
        stopSignal?.removeEventListener("abort", finish);
        signal?.removeEventListener("abort", finish);
        const reason = stopSignal?.aborted ? String(stopSignal.reason) : signal?.aborted ? String(signal.reason) : "navigation timeout";
        stops.push(reason);
        resolve({ status: "stopped", reason, elapsedMs: harness.clock.now() - started });
      };
      const cancel = harness.clock.after(timeoutMs ?? budget, finish);
      stopSignal?.addEventListener("abort", finish, { once: true });
      signal?.addEventListener("abort", finish, { once: true });
      if (stopSignal?.aborted || signal?.aborted) finish();
    });
  } };
  const perception = new CombatPerception(harness.bot);
  after(() => perception[Symbol.dispose]());
  const context = { ...combatTestContext(harness.bot), perception, policy: { ...DEFAULT_COMBAT_POLICY, evade_timeout_ms: budget } };
  const request = { kind: "evade" as const, threats: [{ id: 7, name: shooter ? "skeleton" : "zombie",
    position: { x: distance + 0.5, y: 64, z: 0.5 }, distance }], safeRange: 36, reason: "hurt" as const };
  const begin = (signal = new AbortController().signal) =>
    evade(harness.bot, navigation as unknown as NavigationRuntime, request, context, harness.bot.health, signal);
  const run = (signal = new AbortController().signal) => harness.clock.settle(begin(signal), evadeWallMs(budget) + 1_000);
  const revision = () => {
    assert.ok(goal);
    const resolved = goal.resolve({ ...observation(), position: harness.bot.entity.position });
    assert.equal(resolved.kind, "active");
    return resolved.kind === "active" ? resolved.revision : "";
  };
  return { ...harness, navigation, context, request, stops, routes: () => routes, wall, begin, run, revision };
}

/**
 * What a finished evade must leave (T6): no listener of its own, no timer of the shared clock or global one, nothing
 * firing past its old wall. Take it with the clock installed and before the evade; call the result after it ended.
 */
export function leavesNothing(fixture: ReturnType<typeof reachFixture>) {
  const botAdded = listenersAddedSince(fixture.bot);
  const clientAdded = listenersAddedSince(fixture.bot._client);
  const globalTimers = fixture.clock.pendingGlobalTimers();
  const check = (when: string) => {
    for (const event of ["time", "physicsTick", "entityDead"]) assert.equal(botAdded(event), 0, `${event} ${when}`);
    assert.equal(clientAdded("explosion"), 0, `explosion ${when}`);
    assert.equal(fixture.clock.pendingTimers(), 0, `a clock timer ${when}`);
    assert.equal(fixture.clock.pendingGlobalTimers(), globalTimers, `a global timer (the evade clock's wall) ${when}`);
  };
  return async () => {
    check("right after the evade");
    await fixture.clock.advance(evadeWallMs(fixture.context.policy.evade_timeout_ms) + 1_000);
    check("after the old wall");
  };
}

/** An equal-speed pursuer behind the bot, which runs away along +x: both bodies move 0.1 blocks per SERVER tick, so its gap stays 9. */
export function pursueEqualSpeed(fixture: ReturnType<typeof reachFixture>) {
  fixture.bot.entities[7]!.position.x = fixture.bot.entity.position.x - 9;
  fixture.server.onTick(() => {
    fixture.bot.entity.position.x += 0.1;
    fixture.bot.entities[7]!.position.x += 0.1;
  });
}

/** What `EvadeObservation.ends()` said about the first threat at each look, with the clock's reading, during `run`. */
export async function judgements<T>(fixture: ReturnType<typeof reachFixture>, run: () => Promise<T>) {
  const judged: { at: number; age: number; basis: string | null; advancing: boolean | null }[] = [];
  const original = EvadeObservation.prototype.ends;
  EvadeObservation.prototype.ends = function () {
    const ends = original.call(this);
    judged.push({ at: fixture.clock.now(), age: fixture.bot.time.age!, basis: ends[0]!.basis, advancing: ends[0]!.advancing });
    return ends;
  };
  try { return { value: await run(), judged }; }
  finally { EvadeObservation.prototype.ends = original; }
}

/** An evade of a 3 s budget (60 ticks) at 10 tps: it ends at 60-80 ticks (6-8 s), whatever phase it is in. */
export function slowFixture(options: Parameters<typeof reachFixture>[0] = {}) {
  const fixture = reachFixture({ distance: 9, budget: EVADE_BUDGET_MS, ticksPerSecond: 10, ...options });
  const origin = fixture.bot.time.age!;
  const ticksSpent = () => fixture.bot.time.age! - origin;
  return { ...fixture, ticksSpent };
}

export function assertEndedOnTicks(result: Awaited<ReturnType<ReturnType<typeof slowFixture>["run"]>>, spent: number) {
  assert.equal(result.result.kind, "exhausted", "the clock's abort is the budget ending, not a failure");
  assert.ok(spent >= 60 && spent < 60 + PACKET_TICKS, `age moved ${spent}`);
  assert.ok(result.elapsedTicks! >= 60 && result.elapsedTicks! < 60 + PACKET_TICKS, `elapsed ${result.elapsedTicks} ticks`);
}
