// Native-arrow attribution and ledge phase lifetimes, without simulating projectile physics.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import * as ledge from "./enderman-idle-ledge.ts";

/** Age packets use world-age-per-second; arrow identities replay srd-t32 green-20/green-10 client.log (2026-11-18). */
function fixture(rate = 20, staged = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const commands: string[] = [];
  const harness = createFakeBot({
    clock, server: { ticksPerSecond: rate, startAge: 0 },
    position: new Vec3(-128.53437787507164, 47, 197.61474899858322), groundY: null,
    cells: { "-129,46,197": "netherrack", "-128,31,197": "lava" },
    entities: staged ? { 8: { name: "skeleton", position: new Vec3(-128.5, 57, 240.5) } } : {},
    overrides: { chat: (message) => { commands.push(message); } },
  });
  const controller = new AbortController();
  const phases: { phase: string; age: number }[] = [];
  const starts: number[] = [];
  const logs: string[] = [];
  const runtime = {
    closes: 0, captures: 0,
    status: () => ({ owner: "idle", activeAction: null }),
    async close() { runtime.closes++; },
    async captureIncident() { runtime.captures++; },
    async readEncounters() { return []; },
  };
  const added = listenersAddedSince(harness.bot);
  const packetsAdded = listenersAddedSince(harness.bot._client);
  const context = {
    bot: harness.bot, signal: controller.signal,
    scenario: { params: { mob: "skeleton", requireNativeArrow: true, observeWithinTicks: 400 } },
    log(message: string) {
      logs.push(message);
      if (message.startsWith("LEDGE_PHASE ")) phases.push(JSON.parse(message.slice(12)));
    },
  };
  const deps = { openRuntime: async () => { starts.push(harness.bot.time.age!); return runtime; }, standStill: async () => true };
  return { ...harness, commands, controller, phases, starts, logs, runtime, context, deps, added, packetsAdded };
}

/** Assert that a settled driver cannot release a threat or capture again after its old deadlines. */
async function assertClean(f: ReturnType<typeof fixture>) {
  const commands = [...f.commands];
  const captures = f.runtime.captures;
  await f.clock.advance(100_000);
  assert.deepEqual(f.commands, commands);
  assert.equal(f.runtime.captures, captures);
  assert.equal(f.runtime.closes, f.starts.length);
  for (const event of ["death", "physicsTick", "blockUpdate"]) assert.equal(f.added(event), 0, event);
  for (const event of ["damage_event", "entity_status", "spawn_entity"]) assert.equal(f.packetsAdded(event), 0, event);
  assert.equal(getEventListeners(f.controller.signal, "abort").length, 0);
  assert.equal(f.clock.pendingTimers(), 0);
  assert.equal(f.clock.pendingGlobalTimers(), 0);
}

/** Replay green-20 t00159's spawn; vary identity/type/flight to exercise the witness predicate. */
function arrow(f: ReturnType<typeof fixture>, shooter = 8, name = "arrow",
  velocity = { x: 11999, y: 904, z: -825 }) {
  f.bot._client.emit("spawn_entity", {
    entityId: 9, type: f.bot.registry.entitiesByName[name]!.id, objectData: shooter,
    x: -134.7509208762802, y: 48.64000000804663, z: 196.1096063916202,
    velocity,
  });
}

for (const row of [
  { name: "released skeleton's arrow", shooter: 8, before: false, entity: "arrow", want: "succeeded" },
  { name: "released skeleton's spectral arrow", shooter: 8, before: false, entity: "spectral_arrow", want: "succeeded" },
  { name: "another shooter's arrow", shooter: 18, before: false, entity: "arrow", want: "failed" },
  { name: "arrow before release", shooter: 8, before: true, entity: "arrow", want: "failed" },
  { name: "non-arrow entity", shooter: 8, before: false, entity: "snowball", want: "failed" },
  { name: "backward arrow", shooter: 8, before: false, entity: "arrow", velocity: { x: -11999, y: 904, z: 825 }, want: "failed" },
  { name: "stationary arrow", shooter: 8, before: false, entity: "arrow", velocity: { x: 0, y: 0, z: 0 }, want: "failed" },
]) {
  test(`the bridge judges ${row.name} by its spawn identity`, async () => {
    const f = fixture();
    using _timers = f.clock.install();
    const pending = ledge.runLedgeWith(f.context, f.deps);
    watch(pending);
    await f.clock.advance(row.before ? 100 : 2_050);
    arrow(f, row.shooter, row.entity, "velocity" in row ? row.velocity : undefined);
    if (row.before) await f.clock.advance(2_000);
    // Melee must not substitute for a shot (native damage_event, no-bow-10 t00146).
    if (row.want === "failed") f.bot._client.emit("damage_event", { entityId: 1, sourceCauseId: 9, sourceDirectId: 9 });
    const result = await f.clock.settle(pending, 25_000);
    assert.equal(result.status, row.want, result.detail);
    if (row.want === "failed") assert.match(result.detail!, /stimulus not delivered: no arrow from the released skeleton/);
    await assertClean(f);
  });
}

for (const unsafe of ["below-ledge", "lava-contact", "airborne"] as const) {
  test(`a witnessed arrow still fails after ${unsafe}`, async () => {
    const f = fixture();
    using _timers = f.clock.install();
    const pending = ledge.runLedgeWith(f.context, f.deps);
    watch(pending);
    await f.clock.advance(2_050);
    arrow(f);
    if (unsafe === "below-ledge") f.bot.entity.position.y = 46.99;
    if (unsafe === "lava-contact") Reflect.set(f.bot.entity, "isInLava", true);
    f.bot.emit("physicsTick");
    f.bot.entity.position.y = 47;
    Reflect.set(f.bot.entity, "isInLava", false);
    f.bot.entity.onGround = unsafe !== "airborne";
    const result = await f.clock.settle(pending, 25_000);
    assert.equal(result.status, "failed", result.detail);
    const detail = JSON.parse(result.detail!);
    assert.equal(detail.nativeArrow, true);
    if (unsafe === "below-ledge") assert.equal(detail.minimumY, 46.99);
    if (unsafe === "lava-contact") assert.equal(detail.lava, true);
    if (unsafe === "airborne") assert.equal(detail.final.onGround, false);
    await assertClean(f);
  });
}

for (const rate of [20, 10]) {
  test(`the bridge starts only after the released skeleton's arrow at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const pending = ledge.runLedgeWith(f.context, f.deps);
    const state = watch(pending);
    await f.clock.advance(40_000 / rate);
    assert.equal(f.starts.length, 0, "the runtime must not race the skeleton's first shot");
    arrow(f, 18);
    await f.clock.advance(20_000 / rate);
    assert.equal(f.starts.length, 0, "another shooter's arrow cannot release the bridge run");
    arrow(f);
    await f.clock.advance(50);
    assert.deepEqual(f.starts, [60]);
    const observation = f.phases.find(p => p.phase === "observation")!;
    assert.equal(observation.age, 60);
    await f.clock.advance(380_000 / rate);
    assert.equal(f.bot.time.age! - observation.age, 380);
    assert.equal(state.over, false, "the bridge run retains 400 server ticks after the stimulus");
    const result = await f.clock.settle(pending, 5_000);
    assert.equal(result.status, "succeeded", result.detail);
    assert.equal(f.bot.time.age! - observation.age, 420);
    await assertClean(f);
  });

  for (const ticks of [null, 200, 220]) {
    test(`stimulus ${ticks === null ? "absent" : `at release +${ticks}`} ${ticks === 200 ? "starts" : "never starts"} the bridge at ${rate} tps`, async () => {
      const f = fixture(rate);
      using _timers = f.clock.install();
      const pending = ledge.runLedgeWith(f.context, f.deps);
      const state = watch(pending);
      await f.clock.advance(40_000 / rate);
      const release = f.phases.find(p => p.phase === "release")!;
      assert.ok(release, "the threat was released");
      assert.equal(release.age, 40);
      await f.clock.advance(180_000 / rate);
      assert.equal(f.bot.time.age! - release.age, 180);
      assert.equal(state.over, false);
      await f.clock.advance(20_000 / rate);
      assert.equal(f.bot.time.age! - release.age, 200);
      assert.equal(state.over, false, "the last cached packet can still carry the boundary arrow");
      if (ticks === 220) await f.clock.advance(20_000 / rate);
      if (ticks !== null) {
        assert.equal(f.bot.time.age! - release.age, ticks);
        arrow(f);
      }
      const result = await f.clock.settle(pending, 50_000);
      assert.equal(result.status, ticks === 200 ? "succeeded" : "failed", result.detail);
      if (ticks !== 200) {
        assert.equal(result.detail, "stimulus not delivered: no arrow from the released skeleton");
        assert.equal(f.bot.time.age! - release.age, 220);
        assert.deepEqual(f.starts, [], "no bridge run starts without the stimulus");
      }
      await assertClean(f);
    });
  }

  test(`a missing staged mob fails before release at ${rate} tps`, async () => {
    const f = fixture(rate, false);
    using _timers = f.clock.install();
    const result = await f.clock.settle(ledge.runLedgeWith(f.context, f.deps), 10_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /staged skeleton was not observed/);
    assert.equal(f.bot.time.age, 60);
    assert.equal(f.commands.length, 1);
    await assertClean(f);
  });
}

test("two visible skeletons fail the exactly-one release identity check", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.entities.spawn({ id: 18, name: "skeleton", position: new Vec3(-128.5, 57, 240.5) });
  const result = await f.clock.settle(ledge.runLedgeWith(f.context, f.deps), 5_000);
  assert.equal(result.status, "failed");
  assert.match(result.detail!, /exactly one/);
  assert.ok(!f.commands.some(c => c.endsWith("{NoAI:0b}")));
  await assertClean(f);
});

for (const phase of ["staging", "stimulus", "observation"]) {
  test(`a stopped server during ${phase} fails with unchanged age`, async () => {
    const f = fixture(10, phase !== "staging");
    using _timers = f.clock.install();
    const pending = ledge.runLedgeWith(f.context, f.deps);
    watch(pending);
    if (phase !== "staging") await f.clock.advance(4_050);
    if (phase === "observation") { arrow(f); await f.clock.advance(50); }
    f.server.stop();
    const age = f.bot.time.age;
    const result = await f.clock.settle(pending, 31_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /world age stopped/);
    assert.equal(f.bot.time.age, age);
    await assertClean(f);
  });
}

for (const exit of ["abort", "death"] as const) {
  for (const phase of ["staging", "release", "stimulus", "observation"]) {
    test(`${exit} during ${phase} prevents later release and success`, async () => {
      const f = fixture(20, phase !== "staging");
      using _timers = f.clock.install();
      const stop = () => exit === "abort" ? f.controller.abort(new Error("cancelled fixture")) : f.bot.emit("death");
      if (phase === "release") {
        const chat = f.bot.chat;
        f.bot.chat = command => { chat(command); if (command.startsWith("/tp ")) stop(); };
      }
      const pending = ledge.runLedgeWith(f.context, f.deps);
      watch(pending);
      await f.clock.advance(phase === "staging" ? 100 : 2_050);
      if (phase === "observation") { arrow(f); await f.clock.advance(50); }
      if (phase !== "release") stop();
      const commands = [...f.commands];
      const result = await f.clock.settle(pending, 5_000);
      assert.equal(result.status, "failed");
      assert.deepEqual(f.commands, commands);
      if (phase === "staging" || phase === "release") assert.ok(!commands.some(c => c.endsWith("{NoAI:0b}")));
      await assertClean(f);
    });
  }
}

test("runtime close failure still removes all fixture listeners", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.runtime.close = async () => { f.runtime.closes++; throw new Error("close failed"); };
  const rejected = assert.rejects(ledge.runLedgeWith(f.context, f.deps), /close failed/);
  await f.clock.advance(2_050);
  arrow(f);
  await f.clock.settle(rejected, 25_000);
  await assertClean(f);
});

test("rejected runtime startup after the stimulus removes listeners without closing an unacquired runtime", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  let attempts = 0;
  f.deps.openRuntime = async () => { attempts++; throw new Error("runtime startup failed"); };
  const pending = ledge.runLedgeWith(f.context, f.deps);
  watch(pending);
  await f.clock.advance(2_050);
  arrow(f);
  const result = await f.clock.settle(pending, 1_000);
  assert.equal(result.status, "failed");
  assert.equal(result.detail, "runtime startup failed");
  assert.equal(attempts, 1);
  assert.deepEqual(f.starts, []);
  assert.equal(f.runtime.captures, 0);
  assert.ok(!f.phases.some(p => p.phase === "observation"));
  await assertClean(f);
});

for (const budget of [0, 1]) {
  test(`stimulus budget ${budget} ${budget === 0 ? "rejects before staging" : "accepts the release-boundary arrow"}`, async () => {
    const f = fixture();
    using _timers = f.clock.install();
    Object.assign(f.context.scenario.params, { stimulusWithinTicks: budget });
    const pending = ledge.runLedgeWith(f.context, f.deps);
    watch(pending);
    if (budget === 0) {
      await f.clock.settle(assert.rejects(pending, /stimulusWithinTicks/), 1_000);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.starts, []);
    } else {
      await f.clock.advance(2_000);
      arrow(f);
      const result = await f.clock.settle(pending, 25_000);
      assert.equal(result.status, "succeeded", result.detail);
      assert.deepEqual(f.starts, [40]);
    }
    await assertClean(f);
  });
}
