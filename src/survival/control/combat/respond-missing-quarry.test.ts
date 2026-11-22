// A fight whose quarry vanished waits 200 world ticks (one packet late at most 39), not 10 real seconds (plan
// 2026-11-16-reflex-limits-ticks T5). Every case states the origin age, the packet age and the fake time of its boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { combatTestContext, engagingCombat } from "../../../test-support/combat.js";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../test-support/fake-bot/index.js";
import { serverPacedWallMs } from "../../../world/world-age.js";
import type { CombatOutcome } from "./contract.js";
import { CONTACT_GRACE_TICKS, executeHostileResponse } from "./respond.js";

const START_AGE = 1_000;
const WAIT_TICKS = 200;
const PACKET_TICKS = 20;
const SLICE_MS = 50;
const WALL_MS = serverPacedWallMs(WAIT_TICKS); // 33 000
/** The old wait, 10 000 ms of the clock after the removal: a fight at 10 tps must still be waiting past it. */
const OLD_WAIT_PASSED_MS = 10_500;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

const outcome = (targetId: number, kind: "cancelled" | "died"): CombatOutcome => ({
  kind, targetId, attacks: 0, stylesUsed: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
});

/** The fights of one scene against zombie #7 or magma cube #8: each combat waits for its abort and ends when told to. */
function fightScene(ticksPerSecond: number, server: { readonly timePacketYet?: boolean } = {}) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    server: { startAge: START_AGE, ticksPerSecond, ...server },
    position: new Vec3(0, 64, 0),
    entities: {
      7: { name: "zombie", kind: "Hostile mobs", position: new Vec3(3, 64, 0) },
      8: { name: "magma_cube", kind: "Hostile mobs", position: new Vec3(0, 64, 3) },
    },
  });
  const { bot, clock } = harness;
  const installed = clock.install();
  const engagements: { readonly signal: AbortSignal; finish(): void; fail(): void }[] = [];
  const controller = engagingCombat(bot, (targetId, signal) => new Promise((resolve, reject) => {
    engagements.push({ signal, finish: () => resolve(outcome(targetId, "died")), fail: () => reject(new Error("combat cleanup failed")) });
    signal.addEventListener("abort", () => resolve(outcome(targetId, "cancelled")), { once: true });
  }));
  const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
  const context = combatTestContext(bot);
  const fight = (targetId: number, signal = new AbortController().signal) =>
    executeHostileResponse(bot, navigation, controller, { kind: "fight", targetId, threats: [] }, context, bot.health, signal);
  const timersBefore = clock.pendingGlobalTimers();
  const added = listenersAddedSince(bot);
  /** The fight's settled result, once it is. */
  const watch = (pending: ReturnType<typeof fight>) => {
    let settled: Awaited<ReturnType<typeof fight>> | null = null;
    void pending.then((result) => { settled = result; }, () => undefined);
    return { result: () => settled };
  };
  /** Slices of 50 ms until the world age is `age`; `check()` after each slice that ends below it, so a boundary is seen on both sides. */
  const runToAge = async (age: number, check: () => void) => {
    for (let slice = 0; bot.time.age < age; slice++) {
      assert.ok(slice < 4_000, `world age ${bot.time.age} never reached ${age}`);
      await clock.advance(SLICE_MS);
      if (bot.time.age < age) check();
    }
  };
  /**
   * T6: a fight that has ended left no listener and no wall timer, its combat's signal does not change after the
   * old deadlines pass, and the next fight starts and finishes.
   */
  const assertLeftNothing = async (engaged: { readonly signal: AbortSignal }) => {
    for (const event of ["physicsTick", "entityGone", "time"]) assert.equal(added(event), 0, `${event} listeners left`);
    assert.equal(clock.pendingGlobalTimers(), timersBefore, "no wall timer left");
    const [aborted, reason] = [engaged.signal.aborted, engaged.signal.reason];
    await clock.advance(WALL_MS + 1_000);
    assert.equal(engaged.signal.aborted, aborted, "no abort after the old deadlines");
    assert.equal(engaged.signal.reason, reason);
    const next = fight(8);
    engagements.at(-1)!.finish();
    assert.equal((await clock.settle(next, 1_000)).result.kind, "died");
  };
  return { ...harness, bot, clock, engagements, fight, watch, runToAge, assertLeftNothing, [Symbol.dispose]: () => installed[Symbol.dispose]() };
}
type Scene = ReturnType<typeof fightScene>;

/** Starts the fight, lets the clock reach the packet of age `START_AGE + 20`, then 500 ms: the age cached at the removal is A = 1 020. */
async function removedAfterPacket(scene: Scene, signal?: AbortSignal) {
  const pending = scene.fight(7, signal);
  const seen = scene.watch(pending);
  await scene.runToAge(START_AGE + PACKET_TICKS, () => {});
  await scene.clock.advance(500);
  const origin = scene.bot.time.age;
  assert.equal(origin, START_AGE + PACKET_TICKS, "the removal is read at the packet's age");
  scene.entities.remove(7);
  return { pending, seen, origin };
}

for (const { ticksPerSecond, msPerTick } of RATES) {
  for (const physics of [true, false]) {
    test(`a missing quarry ends the fight at the packet of age A + 220, not before: ${ticksPerSecond} tps, physics ${physics ? "on" : "stopped"}`, async () => {
      using scene = fightScene(ticksPerSecond);
      const { bot, clock, server } = scene;
      // Origin: removed 500 ms after the packet of age A = 1 020. Old code: gone 10 000 ms later = A + 210 ticks at 20 tps, A + 100 at 10 tps.
      bot.physicsEnabled = physics;
      const { seen, origin } = await removedAfterPacket(scene);
      const removedAtMs = clock.now();
      await scene.runToAge(origin + WAIT_TICKS + PACKET_TICKS, () =>
        assert.equal(seen.result(), null, `still waiting at age ${bot.time.age}: the packet of age ${origin + WAIT_TICKS + PACKET_TICKS} ends it`));
      assert.equal(seen.result()?.result.kind, "target_lost", "ended in the slice of the packet of age A + 220");
      assert.equal(server.age, origin + WAIT_TICKS + PACKET_TICKS);
      assert.ok(clock.now() - removedAtMs >= (WAIT_TICKS + PACKET_TICKS) * msPerTick - 500, `${clock.now() - removedAtMs} ms after the removal`);
      await scene.assertLeftNothing(scene.engagements[0]!);
    });
  }

  // A quarry back and gone again between two reads: the second removal starts its own wait from its own age (no read in between).
  for (const physics of [true, false]) {
    test(`a quarry back and gone again at A + 100 gets a fresh wait, no read between: ${ticksPerSecond} tps, physics ${physics ? "on" : "stopped"}`, async () => {
      using scene = fightScene(ticksPerSecond);
      const { bot, entities } = scene;
      bot.physicsEnabled = physics;
      const { seen, origin } = await removedAfterPacket(scene);
      await scene.runToAge(origin + 100, () => assert.equal(seen.result(), null));
      entities.spawn({ id: 7, name: "zombie", kind: "Hostile mobs", position: new Vec3(3, 64, 0) });
      entities.remove(7);
      const second = bot.time.age;
      assert.equal(second, origin + 100, "the second removal is read at the packet of age A + 100");
      // The first wait would end at the packet of age A + 220: the second ends at A + 320.
      await scene.runToAge(second + WAIT_TICKS + PACKET_TICKS, () => assert.equal(seen.result(), null, `waiting at age ${bot.time.age}`));
      assert.equal(seen.result()?.result.kind, "target_lost", "ended at the packet of age A + 320");
    });
  }

  test(`a stopped server ends the wait on the wall at ${WALL_MS} ms, not a millisecond before: ${ticksPerSecond} tps`, async () => {
    using scene = fightScene(ticksPerSecond);
    const { bot, clock, server } = scene;
    bot.physicsEnabled = false; // only the wall timer can wake the fight: no physics tick, no time packet
    const { seen } = await removedAfterPacket(scene);
    const age = bot.time.age;
    server.stop();
    await clock.advance(WALL_MS - 1);
    assert.equal(seen.result(), null, "32 999 ms after the removal");
    assert.equal(bot.time.age, age, "the world age stood still");
    await clock.advance(1);
    assert.equal(seen.result()?.result.kind, "target_lost", "33 000 ms after the removal");
    assert.equal(bot.time.age, age, "the world age stood still");
    await scene.assertLeftNothing(scene.engagements[0]!);
  });

  // The time packets only read the deadline: 19 out-of-reach reads on physics ticks, 60 packets, and the 20th read ends it.
  test(`time packets do not count towards the contact grace: ${ticksPerSecond} tps`, async () => {
    using scene = fightScene(ticksPerSecond);
    const { bot, clock, server } = scene;
    const seen = scene.watch(scene.fight(8));
    for (let packet = 0; packet < 3 * CONTACT_GRACE_TICKS; packet++) server.resendTime(); // counter at zero
    bot.entities[8]!.position.y = 58;
    for (let tick = 0; tick < CONTACT_GRACE_TICKS - 1; tick++) await clock.advance(SLICE_MS); // each slice is one physics tick
    assert.equal(seen.result(), null, "19 physics ticks out of reach");
    bot.physicsEnabled = false;
    for (let packet = 0; packet < 3 * CONTACT_GRACE_TICKS; packet++) {
      server.resendTime();
      await clock.advance(SLICE_MS);
    }
    assert.equal(seen.result(), null, "60 packets with the counter at 19 neither count nor reset it");
    bot.physicsEnabled = true;
    await clock.advance(SLICE_MS);
    assert.equal(seen.result()?.result.kind, "contact_ended", "the 20th physics tick ends it");
    await scene.assertLeftNothing(scene.engagements[0]!);
  });
}

// T6/T13: each way a fight ends while its wait is armed leaves nothing behind. A reflex taking over and a death reach
// `fight` as an abort of the caller's signal: one case for them (a local cleanup, not a driver handoff).
const EXITS: readonly { readonly name: string; readonly verdict: string; run(scene: Scene, caller: AbortController): void }[] = [
  { name: "the combat settles on its own", verdict: "died", run: (scene) => scene.engagements[0]!.finish() },
  { name: "the caller aborts (cancel, a reflex taking over, a death)", verdict: "cancelled", run: (_scene, caller) => caller.abort(new Error("a reflex took the body")) },
  { name: "the combat throws", verdict: "combat cleanup failed", run: (scene) => scene.engagements[0]!.fail() },
];
for (const exit of EXITS)
  test(`the wait leaves nothing behind when the fight ends while it is armed: ${exit.name}`, async () => {
    using scene = fightScene(10);
    const caller = new AbortController();
    const { seen, pending } = await removedAfterPacket(scene, caller.signal);
    await scene.clock.advance(OLD_WAIT_PASSED_MS);
    assert.equal(seen.result(), null, "armed, and 10 000 ms of the clock (100 ticks at 10 tps) did not end it");
    exit.run(scene, caller);
    const verdict = await pending.then((response) => response.result.kind, (error: Error) => error.message);
    assert.equal(verdict, exit.verdict);
    await scene.assertLeftNothing(scene.engagements[0]!);
  });

// No age heard yet (D1): the deadline is only `ticks * 50` ms, and a wall timer of 33 s would leave a fight with no
// physics tick and no time packet in its response 23 s longer than the helper says.
test("a quarry missing before any world age was heard ends the wait at 10 000 ms of clock, not 33 000", async () => {
  using scene = fightScene(20, { timePacketYet: false });
  const { bot, clock, server, entities } = scene;
  server.stop();
  bot.physicsEnabled = false;
  assert.equal(bot.time.age ?? null, null, "no time packet yet: no world age");
  const seen = scene.watch(scene.fight(7));
  entities.remove(7);
  await clock.advance(WAIT_TICKS * SLICE_MS - 1);
  assert.equal(seen.result(), null, "9 999 ms after the removal");
  await clock.advance(1);
  assert.equal(seen.result()?.result.kind, "target_lost", "10 000 ms after the removal");
  await scene.assertLeftNothing(scene.engagements[0]!);
});
