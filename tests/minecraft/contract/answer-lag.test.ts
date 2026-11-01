/**
 * Checks that read what the server answers run on a fake server that answers late (plan 2026-10-23-shared-scenario-server T7d2 item 1):
 * a check that waits a fixed wall time and then reads is red on a server behind its schedule (another lane's clone stalls the server thread
 * 0.16-0.9 s), and green here only if it waits for the answer. Each was red on its old code at this lag through its 400 ms read (consume-food, shield-raised, projectile-hit-bot), or because the subject's summon returned before the server's answer (item-pickup-after-delay, plan 2026-10-30-contract-batch-timing T7d); the same table could join T7d4's `answer-waits.test.ts` (lag by check name).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { contractCheckNamed } from "./checks.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

/**
 * The checks run at a 450 ms lag: those whose answer comes after the call they wait on, `item-pickup-after-delay`, and the four that T7d's review found red at it (plan 2026-10-30-contract-batch-timing T7e; each cause is in its file):
 * `deflect-fireball` (the subject's launch, the ball's start 2 blocks inside the reach the lag crosses, a heard tick a round trip late), `air-supply-under-water` (the same round trip, twice) and `attack-cooldown-damage` (the fake restarted the swing at the client's item change, not when the server read it).
 * `boat-broken-by-attack` has its block at the end of the file (T7g).
 * Not every other check is listed: some may not hold at this lag.
 */
const LAGS_MS: Readonly<Record<string, number>> = {
  "air-supply-under-water": 450,
  "attack-cooldown-damage": 450,
  "consume-food": 450,
  "deflect-fireball": 450,
  "item-pickup-after-delay": 450,
  "projectile-hit-bot": 450,
  "rain-and-thunder-state": 450,
  "shield-raised": 450,
};

for (const [name, lagMs] of Object.entries(LAGS_MS)) {
  test(`contract ${name} holds on a fake server that answers ${lagMs} ms late`, async () => {
    const check = contractCheckNamed(name);
    const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, lagMs);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
  });
}

/**
 * `boat-broken-by-attack` (plan 2026-10-30-contract-batch-timing T7g): the hits are paced by wall time (a hit is an act, not a reading), so a lag of 2 lags
 * per tick read no longer spreads them past the boat's decay (before T7g each hit waited for a read of 2 lags, so the hits came 2 x lag + 250 ms apart and the
 * decay of 1 a tick ate a hit of 10 once they were 10 ticks apart: held to 100 ms, red from 125); the judgement stays on tick reads and adds the round trip.
 */
for (const lagMs of [100, 125, 450]) {
  test(`contract boat-broken-by-attack holds on a fake server that answers ${lagMs} ms late (hits paced by wall time)`, async () => {
    const check = contractCheckNamed("boat-broken-by-attack");
    const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, lagMs);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
  });
}

/**
 * Plan 2026-10-30-contract-batch-timing T7f: a stall on the launch of a fireball on a server that also answers late (the catch-up flies the ball into reach before the swing: the check launches another), and air packets the fake no longer delays.
 * T7i: the same lag with a stall in the flight is judged from the read before the launch and the ball's own tick (`assertUpdatesToldOnTime`), and a ball whose update was read after the stall's catch-up is thrown away for a new one.
 * Swept by 50 ms from 0 to 5000 ms: 33 starts, 1950 to 3550 ms, were red before ("out of reach, update 2: the speed 0.272 at 23 server ticks is not the flight's", and the same at 1 to 5 ticks).
 * The same pattern on the ball in reach (the sweep at 150 ms found 40 red starts, 3050 to 5000 ms): its new velocity and updates are judged from the read at the hit and the ball's tick since it. The starts: the T7f ones (100, 700), the first, a middle and the last of each red range.
 */
const STALLS_AT_LAG: readonly { readonly lagMs: number; readonly atMs: number }[] = [
  ...[100, 700, 1_950, 2_600, 3_550].map((atMs) => ({ lagMs: 450, atMs })),
  ...[3_050, 4_000, 5_000].map((atMs) => ({ lagMs: 150, atMs })),
];

for (const { lagMs, atMs } of STALLS_AT_LAG) {
  test(`contract deflect-fireball holds on a fake that answers ${lagMs} ms late and stalls 700 ms at ${atMs} ms`, async () => {
    const check = contractCheckNamed("deflect-fireball");
    const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, lagMs);
    using _installed = harness.clock.install();
    harness.clock.after(atMs, () => harness.server.stop());
    harness.clock.after(atMs + 700, () => harness.server.resume());
    await check.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
  });
}

test("contract air-supply-under-water holds on a fake that answers 1500 ms late: the air comes in its tick, so its window holds one round trip, not two", async () => {
  const check = contractCheckNamed("air-supply-under-water");
  const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, 1_500);
  using _installed = harness.clock.install();
  await check.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
});

/** The starting distances of both balls grow with the measured round trip (`blocksFlown`), so a lag past 450 ms needs no relaunch: 550 and 600 ms were red with the in-reach ball 4 blocks off (T7f review). */
for (const lagMs of [600, 900, 1_500]) {
  test(`contract deflect-fireball holds on a fake that answers ${lagMs} ms late, with no ball thrown away`, async () => {
    const check = contractCheckNamed("deflect-fireball");
    const harness = fakeHarnessFor(check.fixture, arenaFrame(ZERO_ARENA), {}, lagMs);
    using _installed = harness.clock.install();
    const subject = fakeContractSubject(harness, arenaFrame(ZERO_ARENA));
    let launches = 0;
    await check.run({ ...subject, launchFireball: (position, motion) => (launches += 1, subject.launchFireball(position, motion)) });
    assert.equal(launches, 2, "one ball out of reach, one in reach");
  });
}
