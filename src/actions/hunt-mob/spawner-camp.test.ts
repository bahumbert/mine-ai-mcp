import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { parseHuntMobRequest } from "./contract.js";
import { type CampFailure, SpawnerCamp } from "./spawner-camp.js";

const SPAWNER = new Vec3(0, 64, 0);

/** The camp reads `Date.now` and waits on timers: the clock is a mocked one a test installs when it waits. */
function fixture(waitMs = 15) {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, world } = createFakeBot({ position: new Vec3(20.5, 64, 0.5), cells: { "0,64,0": "spawner" }, clock });
  let routes = 0;
  const camp = new SpawnerCamp(bot, SPAWNER, waitMs, async (position) => {
    routes++;
    bot.entity.position = position.offset(1.5, 0, 0.5);
    return { status: "completed", elapsedMs: 1 };
  });
  return {
    bot,
    clock,
    camp,
    routes: () => routes,
    destroy: () => world.setCell(SPAWNER, "air"),
  };
}

test("normal hunting defaults to no wait; camping requires explicit finite patience", () => {
  const input = { mob_name: "blaze", drop_name: "blaze_rod" };
  assert.equal(parseHuntMobRequest(input).observeForMs, 0);
  assert.equal(parseHuntMobRequest(input).campSpawner, false);
  assert.throws(() => parseHuntMobRequest({ ...input, camp_spawner: true }), /positive observe_for_ms/);
  assert.equal(parseHuntMobRequest({ ...input, camp_spawner: true, observe_for_ms: 100 }).campSpawner, true);
});

test("an empty camp returns observation_exhausted after one return and a finite wait", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const waiting = f.camp.waitForQuarry(() => false, new AbortController().signal);
  // The away wait (15 ms), the return, then the wait at the spawner (15 ms).
  await f.clock.advance(1_000);
  const result = await waiting;
  assert.equal(result?.termination, "observation_exhausted");
  assert.equal(f.routes(), 1);
  assert.ok(f.camp.snapshot.observationUntil);
});

test("new quarry resumes hunting without resetting an interrupted camp deadline", async () => {
  const f = fixture(30);
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const stop = new AbortController();
  const pending = f.camp.waitForQuarry(() => false, stop.signal);
  const deadline = f.camp.snapshot.observationUntil;
  stop.abort(new Error("reflex takeover"));
  await assert.rejects(pending, /reflex takeover/);
  const again = new AbortController();
  const resumed = f.camp.waitForQuarry(() => false, again.signal);
  assert.equal(f.camp.snapshot.observationUntil, deadline);
  again.abort(new Error("second takeover"));
  await assert.rejects(resumed, /second takeover/);
  assert.equal(await f.camp.waitForQuarry(() => true, new AbortController().signal), null);
  assert.equal(f.camp.snapshot.phase, "hunting");
  assert.equal(f.camp.snapshot.observationUntil, null);
  assert.equal(f.routes(), 0);
});

test("a destroyed camp wakes its wait and reports source loss", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.bot.entity.position = new Vec3(1.5, 64, 0.5);
  const pending = f.camp.waitForQuarry(() => false, new AbortController().signal);
  f.destroy();
  assert.equal((await pending)?.termination, "spawner_unavailable");
});

test("failed navigation returns its observation instead of waiting again", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const camp = new SpawnerCamp(f.bot, SPAWNER, 1, async () => ({
    status: "stopped",
    elapsedMs: 1,
    reason: "No safe route",
  }));
  const waiting = camp.waitForQuarry(() => false, new AbortController().signal);
  await f.clock.advance(1_000);
  const result = await waiting;
  assert.equal(result?.termination, "spawner_unreachable");
  assert.match(result?.reason ?? "", /No safe route/);
});

test("missing spawner refuses camping without a route or wait", async () => {
  const f = fixture();
  const camp = new SpawnerCamp(f.bot, null, 10, async () => {
    throw new Error("Unexpected route");
  });
  assert.equal(
    (await camp.waitForQuarry(() => false, new AbortController().signal))?.termination,
    "spawner_unavailable",
  );
});

// Plan 2026-10-27-p1-monotonic-clock T5: the camp's wait is a deadline (monotonic) kept across a reflex takeover; its
// snapshot keeps epoch times. One wait cannot tell the clocks apart (its timer is set once): the takeover re-enters it.
for (const row of [
  { name: "a wall step forward of 1.2 s does not cut it short", wallStepMs: 1_200 },
  { name: "a wall step back of 0.8 s does not stretch it", wallStepMs: -800 },
]) {
  test(`a 3 s wait at the spawner resumed after a takeover ends after 3 s of monotonic time: ${row.name}`, async () => {
    const f = fixture(3_000);
    using _timers = f.clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
    f.clock.stepWallClock(5_000);
    f.bot.entity.position = new Vec3(1.5, 64, 0.5);
    const takeover = new AbortController();
    const interrupted = f.camp.waitForQuarry(() => false, takeover.signal);
    assert.equal(f.camp.snapshot.observationUntil, Date.now() + 3_000, "the snapshot's deadline stays an epoch time of day");
    await f.clock.advance(1_000);
    takeover.abort(new Error("reflex takeover"));
    await assert.rejects(interrupted, /reflex takeover/);
    f.clock.stepWallClock(row.wallStepMs);
    let result: CampFailure | null | undefined;
    const settled = () => result !== undefined;
    const resumed = f.camp.waitForQuarry(() => false, new AbortController().signal).then((failure) => { result = failure; });
    await f.clock.advance(1_900);
    assert.equal(settled(), false, "2.9 s in: still waiting");
    await f.clock.advance(300);
    assert.equal(result?.termination, "observation_exhausted", "3.2 s in: over");
    await resumed;
  });
}

// The away wait (before the return route) is a deadline of the same kind: its snapshot field `returnAfter` stays epoch.
for (const row of [
  { name: "a wall step forward of 1.2 s does not send the bot back early", wallStepMs: 1_200 },
  { name: "a wall step back of 0.8 s does not keep the bot away longer", wallStepMs: -800 },
]) {
  test(`a 3 s wait away from the spawner resumed after a takeover returns after 3 s of monotonic time: ${row.name}`, async () => {
    const f = fixture(3_000);
    using _timers = f.clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
    f.clock.stepWallClock(5_000);
    const takeover = new AbortController();
    const interrupted = f.camp.waitForQuarry(() => false, takeover.signal);
    assert.equal(f.camp.snapshot.returnAfter, Date.now() + 3_000, "the snapshot's deadline stays an epoch time of day");
    await f.clock.advance(1_000);
    takeover.abort(new Error("reflex takeover"));
    await assert.rejects(interrupted, /reflex takeover/);
    f.clock.stepWallClock(row.wallStepMs);
    const again = new AbortController();
    const resumed = f.camp.waitForQuarry(() => false, again.signal).catch(() => undefined);
    await f.clock.advance(1_900);
    assert.equal(f.routes(), 0, "2.9 s in: still waiting away");
    await f.clock.advance(300);
    assert.equal(f.routes(), 1, "3.2 s in: the bot started back");
    again.abort(new Error("test over"));
    await resumed;
  });
}
