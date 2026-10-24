import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Vec3 } from "vec3";
import type { IncidentReference } from "../bot-data/incident-log.js";
import type { NavigationEvent } from "../navigation/index.js";
import { MemoryWorld } from "../navigation/world/memory-world.js";
import { CombatProgress } from "../survival/control/combat/progress.js";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { observeDamageRegistry } from "../world/damage-registry.js";
import { observeIncidents } from "./incident-observer.js";

test("failure evidence separates lost support, server corrections, and local motion and detaches every listener", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { bot, combat: scene } = createFakeBot();
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
  bot.emit("physicsTick");
  bot.entity.position.x += 0.1;
  bot.emit("physicsTick");
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
  assert.match(intact, /"forward":true/);
  assert.match(intact, /"combat":\{"targetId":42,"position":null,"execution":/);
  assert.match(intact, /"phaseTicks":\{"guard":2\}/);
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

/** An emitter as a listener count reads it: Node's, or Mineflayer's typed one. */
type Listened = { eventNames(): Array<string | symbol>; listenerCount(event: string | symbol): number };
/** How many listeners each event has: what an observer that detaches everything leaves unchanged. */
function listenerCounts(emitter: Listened): Record<string, number> {
  return Object.fromEntries(emitter.eventNames().map((name) => [String(name), emitter.listenerCount(name)]));
}
