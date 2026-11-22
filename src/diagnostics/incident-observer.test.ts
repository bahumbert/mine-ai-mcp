import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { Vec3 } from "vec3";
import type { IncidentReference } from "../bot-data/incident-log.js";
import type { NavigationEvent } from "../navigation/index.js";
import { MemoryWorld } from "../navigation/world/memory-world.js";
import { CombatProgress } from "../survival/control/combat/progress.js";
import { createFakeBot, createFakeClock, listenerCounts } from "../test-support/fake-bot/index.js";
import { observeDamageRegistry } from "../world/damage-registry.js";
import { observeIncidents } from "./incident-observer.js";

/** Exercise the actual observer and artifact writer with navigation events, without inventing server answers. */
async function navigationIncidents(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-search-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { bot } = createFakeBot();
  const events = new Set<(event: NavigationEvent) => void>();
  const observer = observeIncidents(bot, {
    world: new MemoryWorld(),
    onEvent: (listener) => { events.add(listener); return () => { events.delete(listener); }; },
  }, {
    directory, identity: {}, published: () => undefined,
    owner: () => ({ requestId: null, precedingRequestId: null,
      session: { owner: "idle", busy: false, activeAction: null }, combat: { targetId: null, position: null } }),
  });
  t.after(() => observer.close());
  return {
    emit: (event: NavigationEvent) => { for (const listener of events) listener(event); },
    capture: async (direct = false) => {
      const result = await (direct ? observer.recorder.capture("combat_waiting", null) : observer.capture());
      if (result.kind !== "completed" || result.reference.artifact.kind !== "written") return assert.fail("capture not written");
      return (await readFile(result.reference.artifact.path, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    },
  };
}

/** Navigation reports cumulative compute, as documented by NavigationEvent.search_slice. */
function searchSlice(searchId: string, computeMs: number, runId = "r1"): NavigationEvent {
  return { kind: "search_slice", searchId, runId, atMs: Date.now(), visited: 1, generated: 2, computeMs };
}

for (const outcome of ["stopped", "failed"] as const) {
  test(`search slices become one cumulative compute record when a run is ${outcome}`, async t => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1000 });
    using _installed = clock.install();
    const fixture = await navigationIncidents(t);
    fixture.emit(searchSlice("r1:search:1", 3));
    clock.stepWallClock(-1700);
    await clock.advance(40);
    fixture.emit(searchSlice("r1:search:1", 7));
    fixture.emit({ kind: "run_settled", runId: "r1", atMs: Date.now(), outcome });
    const rows = await fixture.capture();
    const summaries = rows.filter(row => row.event?.kind === "search_compute");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].event.slices, 2);
    assert.equal(summaries[0].event.computeMs, 7);
    assert.equal(summaries[0].event.lastAt - summaries[0].event.firstAt, 40);
    assert.equal(rows.filter(row => row.event?.kind === "search_slice").length, 0);
  });
}

test("replaced searches are flushed separately without ending another run's search", async t => {
  const fixture = await navigationIncidents(t);
  fixture.emit(searchSlice("r1:search:1", 3));
  fixture.emit(searchSlice("r2:search:1", 9, "r2"));
  fixture.emit({ kind: "search_started", runId: "r1", searchId: "r1:search:2", atMs: Date.now(), reason: "start_changed", goal: "safe" });
  fixture.emit(searchSlice("r1:search:2", 5));
  const rows = await fixture.capture();
  const summaries = rows.filter(row => row.event?.kind === "search_compute").map(row => row.event);
  assert.deepEqual(summaries.map(row => [row.searchId, row.computeMs]), [["r1:search:1", 3], ["r2:search:1", 9], ["r1:search:2", 5]]);
  assert.equal(summaries[0].reason, "search_started");
  assert.equal(summaries[1].reason, "capture");
});

for (const terminal of ["route_committed", "search_finished"] as const) test(`capture keeps compute across ${terminal} and its terminal slice`, async t => {
  const fixture = await navigationIncidents(t);
  fixture.emit(searchSlice("r1:search:1", 3));
  const first = await fixture.capture(true);
  assert.equal(first.filter(row => row.event?.kind === "search_compute").at(-1)?.event.computeMs, 3);
  // NavigationRun emits terminal evidence before that advance's last slice.
  if (terminal === "search_finished") fixture.emit({ kind: terminal, runId: "r1", searchId: "r1:search:1", atMs: Date.now(),
    goal: "safe", result: "no_path", counts: { queued: 0, visited: 1, farthestVisited: 0, generated: 2, slices: 2, computeMs: 7 },
    exhausted: "frontier", limit: null, interpretation: "terminal search evidence" });
  fixture.emit(searchSlice("r1:search:1", 7));
  if (terminal === "route_committed") fixture.emit({ kind: terminal, runId: "r1", planId: "r1:search:1:route:1", atMs: Date.now(), steps: 0,
    plan: { start: { x: 0, y: 64, z: 0 }, end: { x: 1, y: 64, z: 0 }, steps: [], complete: false } });
  const final = await fixture.capture();
  const summaries = final.filter(row => row.event?.kind === "search_compute").map(row => row.event);
  assert.deepEqual(summaries.map(row => [row.reason, row.slices, row.computeMs]), [["capture", 1, 3], [terminal, 2, 7]]);
  assert.equal(final.filter(row => row.event?.kind === "search_slice").length, 0);
});

test("committing a route preserves its pending continuation's admission time", async t => {
  const clock = createFakeClock({ mode: "mocked", startMs: 1000 });
  using _installed = clock.install();
  const fixture = await navigationIncidents(t);
  fixture.emit({ kind: "search_started", runId: "r1", searchId: "r1:search:2", atMs: Date.now(), reason: "segment_continuation", goal: "safe" });
  const admitted = performance.now();
  fixture.emit({ kind: "route_committed", runId: "r1", planId: "r1:search:1:route:1", atMs: Date.now(), steps: 0,
    plan: { start: { x: 0, y: 64, z: 0 }, end: { x: 1, y: 64, z: 0 }, steps: [], complete: false } });
  await clock.advance(50);
  fixture.emit(searchSlice("r1:search:2", 7));
  const rows = await fixture.capture();
  const summary = rows.find(row => row.event?.kind === "search_compute")?.event;
  assert.equal(summary.firstAt, admitted);
  assert.equal(summary.admissionObserved, true);
});

test("incident evidence keeps body telemetry every tick, samples entities every five ticks, distinguishes corrections and detaches listeners", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { bot, combat: scene } = createFakeBot({ entities: { 7: { name: "zombie", position: new Vec3(2, 64, 0) } } });
  // The server's flags: on fire (`shared_flags`) and using an item in the off hand (`living_entity_flags`).
  bot.entity.metadata = playerMetadata(bot, { living_entity_flags: 3, shared_flags: 1 });
  bot.entity.velocity = new Vec3(0.02, -0.08, 0);
  // Mineflayer answers controls through `getControlState`: object spread must not define the evidence.
  bot.setControlState("forward", true);
  const self = bot.entity.id;
  const listenersBefore = { bot: listenerCounts(bot), client: listenerCounts(bot._client) };
  observeDamageRegistry(bot);
  bot._client.emit("registry_data", {
    id: "minecraft:damage_type",
    entries: [{ key: "test:zero" }, { key: "test:one" }, { key: "minecraft:fireball" }],
  });
  const world = new MemoryWorld();
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 1 });
  const events = new Set<(event: NavigationEvent) => void>();
  const references: IncidentReference[] = [];
  const observer = observeIncidents(
    bot,
    {
      world,
      onEvent: (listener) => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
    },
    {
      directory,
      identity: { worldId: "test" },
      published: (reference) => references.push(reference),
      owner: () => ({
        requestId: 17,
        precedingRequestId: null,
        session: {
          owner: "foreground",
          busy: true,
          activeAction: { action: "navigate", startedAt: "test" },
        },
        combat: {
          targetId: 42,
          position: null,
          execution: {
            phase: "guard",
            phaseTicks: 0,
            attacks: 0,
            expected: "Volley finishes",
            completedEffects: 0,
            phaseHistory: {},
            progress: new CombatProgress().snapshot(),
          },
        },
      }),
    },
  );
  for (let tick = 1; tick <= 11; tick++) {
    bot.entity.position.x = (tick + 4) / 10;
    bot.health = 20 - tick;
    bot.setControlState("forward", tick % 2 === 1);
    if (tick === 2) bot.entities[7]!.position.x = 12;
    if (tick === 7) delete bot.entities[7];
    bot.emit("physicsTick");
  }
  bot.health = 20;
  // A failed step and mob hit stay silent; a death freezes their preceding history.
  for (const listener of events)
    listener({
      kind: "step_failed",
      runId: "r1",
      stepId: "s1",
      movement: "walk",
      observation: "no progress",
      atMs: Date.now(),
    });
  bot._client.emit("damage_event", {
    entityId: self,
    sourceTypeId: 2,
    sourceCauseId: 7,
    sourceDirectId: 7,
    sourcePosition: null,
  });
  scene.setHealth(18);
  // Damage caused by this bot is evidence too, including a collateral hit.
  // It remains silent and does not trigger a separate capture.
  bot._client.emit("damage_event", { entityId: 8, sourceTypeId: 2, sourceCauseId: 6, sourceDirectId: 6 });
  bot._client.emit("damage_event", { entityId: 9, sourceTypeId: 2, sourceCauseId: 10, sourceDirectId: 10 });
  // Preserve the authoritative own impulse, independent of client velocity.
  bot._client.emit("entity_velocity", {
    entityId: self,
    velocity: { x: -4000, y: 3200, z: 8000 },
    secret: "never-record",
  });
  bot._client.emit("entity_velocity", { entityId: 19, velocity: { x: 1, y: 2, z: 3 } });
  bot._client.emit("entity_velocity", { entityId: 19, velocity: "unsupported foreign shape" });
  bot._client.emit("entity_velocity", { entityId: self, velocity: { x: 0.5, y: 0, z: 0 } });
  assert.equal(references.length, 0);
  bot.emit("death");
  await observer.recorder.flush();
  const first = references[0]!.artifact;
  assert.equal(first.kind, "written");
  if (first.kind !== "written") return;
  const intact = await readFile(first.path, "utf8");
  const physics = intact.trim().split("\n")
    .map((line) => JSON.parse(line)).filter((entry) => entry.kind === "physics");
  assert.deepEqual(physics.map((entry) => [entry.position.x, entry.health, entry.controls.forward]), [
    [0.5, 19, true], [0.6, 18, false], [0.7, 17, true], [0.8, 16, false], [0.9, 15, true],
    [1, 14, false], [1.1, 13, true], [1.2, 12, false], [1.3, 11, true], [1.4, 10, false], [1.5, 9, true],
  ]);
  const entitySamples = physics.flatMap((entry, index) => entry.entities === undefined ? [] : [[index + 1, entry.entities]]);
  assert.deepEqual(entitySamples.map(([tick]) => tick), [1, 6, 11]);
  assert.equal(entitySamples[0]![1].find((entity: { id: number }) => entity.id === 7).position.x, 2);
  assert.equal(entitySamples[1]![1].find((entity: { id: number }) => entity.id === 7).position.x, 12);
  assert.equal(entitySamples[2]![1].some((entity: { id: number }) => entity.id === 7), false);
  assert.match(intact, /"forward":true/);
  assert.match(intact, /"combat":\{"targetId":42,"position":null,"execution":/);
  assert.match(intact, /"phaseTicks":\{"guard":11\}/);
  assert.match(intact, /"positionDelta":\{"elapsedMs":\d+,"x":0\.099/);
  assert.match(intact, /"mineflayerVelocity":\{"x":0\.02/);
  assert.match(intact, /"mineflayerUsingHeldItem":false,"serverLivingEntityFlags":3/);
  assert.match(intact, /"kind":"hit".*"cause":\{"id":6,"name":null.*"burning":true/);
  assert.match(intact, /"kind":"unloaded"/);
  assert.match(intact, /"sourceType":"minecraft:fireball"/);
  assert.match(intact, /"shieldReadyFromObservedUse":false/);
  assert.match(intact, /"healthLossFollowingSource":\{"minecraft:fireball":2\}/);
  assert.doesNotMatch(intact, /nearby_block_change/);
  assert.match(intact, /"entityId":8,"sourceTypeId":2,"sourceCauseId":6,"sourceDirectId":6/);
  assert.match(intact, /"entityId":9/, "unrelated damage remains available before attribution filtering");
  assert.match(intact, new RegExp(String.raw`"packet":"update_health","botEntityId":${self},"fields":\{"health":18,"food":20,"foodSaturation":5\}`));
  const impulseRows = intact
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.packet === "entity_velocity");
  assert.deepEqual(
    impulseRows.map(({ atMs, ...row }) => row),
    [
      {
        kind: "packet",
        packet: "entity_velocity",
        fields: {
          entityId: self,
          velocity: { x: -4000, y: 3200, z: 8000 },
          velocityBlocksPerTick: { x: -0.5, y: 0.4, z: 1 },
        },
      },
      { kind: "packet_unavailable", packet: "entity_velocity", reason: "unsupported diagnostic fields" },
    ],
  );

  world.load({ x: 0, y: 63, z: 0 }, { stateId: 0 });
  bot._client.emit("position", {
    teleportId: 4,
    x: 8,
    y: 64,
    z: 0.5,
    dx: 0,
    dy: 0,
    dz: 0,
    yaw: 0,
    pitch: 0,
    flags: { _value: 0, x: false },
    secret: "never-record",
  });
  bot.entity.position.x = 8;
  bot.emit("forcedMove");
  bot.emit("physicsTick");
  bot._client.emit("explosion", { x: 10, y: 64, z: 0, playerKnockback: { x: 1, y: 0, z: 0 }, secret: "never-record" });
  // Protodef omits the value of an absent option; it does not return null.
  bot._client.emit("damage_event", { entityId: self, sourceTypeId: 2, sourceCauseId: 0, sourceDirectId: 0 });
  scene.setHealth(17);
  await observer.close();
  const last = references.at(-1)!.artifact;
  assert.equal(last.kind, "written");
  if (last.kind !== "written") return;
  const changed = await readFile(last.path, "utf8");
  assert.equal(references.at(-1)?.trigger, "runtime_closed");
  assert.match(
    changed,
    /nearby_block_change.*"before":\{"kind":"loaded","stateId":1.*"after":\{"kind":"loaded","stateId":0/,
  );
  assert.match(changed, /server_position_applied/);
  assert.match(changed, /"position":\{"x":8,"y":64,"z":0\.5},"positionDelta":null/);
  assert.match(changed, /"packet":"damage_event"/);
  assert.match(changed, /"packet":"explosion"/);
  assert.doesNotMatch(changed, /never-record/);
  assert.equal(world.listenerCount, 0);
  assert.equal(events.size, 0);
  bot.emit("end", "done");
  assert.deepEqual({ bot: listenerCounts(bot), client: listenerCounts(bot._client) }, listenersBefore);
});

// Run 14b: eight bots froze after a boat ride with no record of the mount, the get-off or the server's answer.
test("a physics stall is captured with the mount, the server's passenger lists and the vehicle state before it", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { bot } = createFakeBot({ position: new Vec3(0.5, 62.96, 0.5), entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 62.46, 0.5) } } });
  bot.entity.onGround = false;
  const boat = bot.entities[7]!;
  const self = bot.entity.id;
  const references: IncidentReference[] = [];
  const observer = observeIncidents(bot, { world: new MemoryWorld(), onEvent: () => () => undefined }, {
    directory,
    identity: { worldId: "test" },
    published: (reference) => references.push(reference),
    owner: () => ({
      requestId: 3,
      precedingRequestId: null,
      session: { owner: "foreground", busy: true, activeAction: { action: "navigate", startedAt: "test" } },
      combat: { targetId: null, position: null },
    }),
  });
  bot._client.emit("set_passengers", { entityId: 7, passengers: [self] });
  bot.vehicle = boat;
  bot.entity.vehicle = boat;
  bot.emit("mount");
  bot._client.emit("set_passengers", { entityId: 9, passengers: [11] });
  // The server lets her off: the list no longer names her; Mineflayer keeps the vehicle.
  bot._client.emit("set_passengers", { entityId: 7, passengers: [] });
  bot.vehicle = null;
  Object.assign(bot.entity, { vehicle: null });
  bot.emit("dismount", boat);
  observer.physicsStalled("navigate");
  await observer.recorder.flush();
  assert.equal(references[0]?.trigger, "physics_stalled");
  const artifact = references[0]!.artifact;
  if (artifact.kind !== "written") return assert.fail("not written");
  const text = await readFile(artifact.path, "utf8");
  assert.match(text, new RegExp(String.raw`"packet":"set_passengers","botEntityId":${self},"fields":\{"entityId":7,"passengers":\[${self}\]\}`));
  assert.match(text, new RegExp(String.raw`"packet":"set_passengers","botEntityId":${self},"fields":\{"entityId":7,"passengers":\[\]\}`));
  assert.doesNotMatch(text, /"entityId":9/, "another entity's passengers are not hers");
  assert.match(text, /"kind":"vehicle","atMs":\d+,"event":"mount","vehicleId":7/);
  assert.match(text, /"kind":"vehicle","atMs":\d+,"event":"dismount","vehicleId":7/);
  assert.match(text, /"trigger":"physics_stalled".*"action":"navigate".*"vehicleId":null/);
  await observer.close();
});

// SRV-01: a reflex that held the body past its ceiling or without progress is released; the incident says which and who.
test("a reflex that hit its limit is captured with the reflex and the limit", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { bot } = createFakeBot({ position: new Vec3(0.5, 62.96, 0.5) });
  const references: IncidentReference[] = [];
  const observer = observeIncidents(bot, { world: new MemoryWorld(), onEvent: () => () => undefined }, {
    directory,
    identity: { worldId: "test" },
    published: (reference) => references.push(reference),
    owner: () => ({
      requestId: 3,
      precedingRequestId: null,
      session: { owner: "takeover", busy: true, activeAction: { action: "breath_reflex", startedAt: "test" } },
      combat: { targetId: null, position: null },
    }),
  });
  observer.reflexLimit("breath_reflex", "no_progress");
  await observer.recorder.flush();
  assert.equal(references[0]?.trigger, "reflex_limit");
  const artifact = references[0]!.artifact;
  if (artifact.kind !== "written") return assert.fail("not written");
  assert.match(await readFile(artifact.path, "utf8"), /"trigger":"reflex_limit".*"reflex":"breath_reflex".*"limit":"no_progress"/);
  await observer.close();
});

/** The player's metadata as the server sends it: each flag at the index the version's data gives its key. */
function playerMetadata(bot: Bot, flags: Readonly<Record<string, number>>): object[] {
  const keys = bot.registry.entitiesByName.player?.metadataKeys ?? [];
  return Object.assign([], Object.fromEntries(Object.entries(flags).map(([key, value]) => [keys.indexOf(key), value])));
}

// A health loss is blamed on the last hit only within 250 ms of it. WSL steps its wall clock (back ~2 s every 30 s), so a
// window read on `Date.now()` blames a stale hit after a step back and drops a fresh one after a step forward.
for (const { name, stepMs, passedMs, source } of [
  { name: "a hit 100 ms before the health loss still gets the blame across a wall clock step forward", stepMs: 1200, passedMs: 100, source: "damage_type:2" },
  { name: "a hit 300 ms before the health loss gets no blame across a wall clock step back", stepMs: -2000, passedMs: 300, source: "unattributed" },
]) {
  test(name, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    const { bot, combat: scene } = createFakeBot({ position: new Vec3(0.5, 62.96, 0.5) });
    const references: IncidentReference[] = [];
    const observer = observeIncidents(bot, { world: new MemoryWorld(), onEvent: () => () => undefined }, {
      directory,
      identity: { worldId: "test" },
      published: (reference) => references.push(reference),
      owner: () => ({
        requestId: 3,
        precedingRequestId: null,
        session: { owner: "foreground", busy: true, activeAction: { action: "navigate", startedAt: "test" } },
        combat: { targetId: null, position: null },
      }),
    });
    // A cause id is an entity's: a hit with none is a "non_entity_damage" trigger that captures at once.
    bot._client.emit("damage_event", { entityId: bot.entity.id, sourceTypeId: 2, sourceCauseId: 7, sourceDirectId: 7, sourcePosition: null });
    clock.stepWallClock(stepMs);
    await clock.advance(passedMs);
    scene.setHealth(18);
    observer.physicsStalled("navigate");
    await observer.recorder.flush();
    const artifact = references[0]!.artifact;
    if (artifact.kind !== "written") return assert.fail("not written");
    assert.match(await readFile(artifact.path, "utf8"), new RegExp(String.raw`"healthLossFollowingSource":\{"${source}":2\}`));
    await observer.close();
  });
}
