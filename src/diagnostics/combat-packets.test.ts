import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import type { IncidentRecorder } from "./incident-recorder.js";
import { observeCombatPackets } from "./combat-packets.js";

test("item-use assignment tracing preserves values and restores the property on disposal", () => {
  const { bot } = createFakeBot();
  const records: any[] = [];
  const original = Object.getOwnPropertyDescriptor(bot, "usingHeldItem")!;
  const observer = observeCombatPackets(bot, { record: (_kind: string, facts: object) => records.push(facts) } as unknown as IncidentRecorder, 8);
  bot.usingHeldItem = true;
  bot.usingHeldItem = true;
  bot.usingHeldItem = false;
  assert.deepEqual(records.map((r) => [r.fields.before, r.fields.after]), [[false, true], [true, false]]);
  assert.ok(records[0].fields.stack.length > 0);
  observer[Symbol.dispose]();
  assert.deepEqual(Object.getOwnPropertyDescriptor(bot, "usingHeldItem"), original);
  bot.usingHeldItem = true;
  assert.equal(records.length, 2);
});

test("combat telemetry preserves writes and orders commands against received flags without claiming acknowledgement", () => {
  const writes: unknown[] = [];
  const records: any[] = [];
  const { bot } = createFakeBot();
  const client = bot._client;
  // The protocol writer the observer wraps: it records what reaches it and the receiver it is called on.
  client.write = function (name: string, params: unknown) {
    assert.equal(this, client);
    writes.push({ name, params });
  };
  const original = client.write;
  const recorder = { record: (kind: string, facts: object) => records.push({ kind, ...facts }) } as unknown as IncidentRecorder;
  const observer = observeCombatPackets(bot, recorder, 8);
  const use = { hand: 1, sequence: 12, rotation: { x: 90, y: 0 }, ignored: "not captured" };
  client.write("use_item", use);
  client.emit("entity_metadata", { entityId: 2, metadata: [{ key: 8, value: 3 }] });
  assert.equal(observer.snapshot().lastReceivedUseFlags, null);
  client.emit("entity_metadata", { entityId: 1, metadata: [{ key: 8, value: 3 }, { key: 9, value: "excluded" }] });
  client.write("look", { yaw: 120, pitch: 5 });
  client.write("block_dig", { status: 5, sequence: 13 });
  client.write("chat", { message: "excluded" });
  client.write("block_dig", { status: 0, sequence: 14 });
  client.emit("entity_status", { entityId: 1, entityStatus: 29 });
  client.emit("set_cooldown", { cooldownGroup: "minecraft:shield", cooldownTicks: 100 });
  assert.equal(writes.length, 5);
  assert.equal((writes[0] as { params: unknown }).params, use);
  assert.deepEqual(records.map((r) => r.packet), ["use_item", "entity_metadata", "look", "block_dig", "entity_status", "set_cooldown"]);
  assert.deepEqual(records.map((r) => r.order), [1, 2, 3, 4, 5, 6]);
  assert.equal(records[0].fields.ignored, undefined);
  const snapshot = observer.snapshot();
  assert.equal(snapshot.lastItemCommand?.packet, "block_dig");
  assert.equal(snapshot.lastRotationCommand?.packet, "look");
  assert.equal(snapshot.lastReceivedUseFlags?.value, 3);
  assert.equal(snapshot.serverBlockingConfirmed, false);
  bot.emit("respawn");
  assert.equal(observer.snapshot().lastReceivedUseFlags, null);
  observer[Symbol.dispose]();
  assert.equal(client.write, original);
  assert.equal(client.listenerCount("entity_metadata"), 0);
  assert.equal(client.listenerCount("entity_status"), 0);
  assert.equal(client.listenerCount("set_cooldown"), 0);
});

test("a failed protocol write remains a failure and cannot become a successful item command", () => {
  const failure = new Error("socket write failed");
  const { bot } = createFakeBot();
  bot._client.write = () => {
    throw failure;
  };
  const records: any[] = [];
  using observer = observeCombatPackets(bot, { record: (_kind: string, facts: object) => records.push(facts) } as unknown as IncidentRecorder, 8);
  assert.throws(() => bot._client.write("block_dig", { status: 5, sequence: 1 }), (error) => error === failure);
  assert.equal(observer.snapshot().lastItemCommand, null);
  assert.equal(records[1].outcome, "write_threw");
  assert.equal(records[1].writeOrder, records[0].order);
});
