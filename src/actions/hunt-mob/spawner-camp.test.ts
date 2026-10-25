import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { parseHuntMobRequest } from "./contract.js";
import { SpawnerCamp } from "./spawner-camp.js";

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
