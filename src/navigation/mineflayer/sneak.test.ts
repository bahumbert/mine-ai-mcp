import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { setSneaking, writeShiftKey } from "./sneak.js";

/** A bot that records the packets and the control it is given: 1.21.5 is the last version whose server reads the shift from entity_action, 1.21.6 the first to read player_input. */
function recordingBot(entityAction: boolean) {
  const written: { name: string; packet: Record<string, unknown> }[] = [];
  const controls: [string, boolean][] = [];
  const bot = {
    entity: { id: 12 },
    version: entityAction ? "1.21.5" : "1.21.6",
    setControlState: (control: string, state: boolean) => controls.push([control, state]),
    _client: { write: (name: string, packet: Record<string, unknown>) => written.push({ name, packet }) },
  } as unknown as Bot;
  return { bot, written, controls };
}

test("on a version that reads the shift from entity_action, a press writes entity_action 0 and a release 1", () => {
  const { bot, written } = recordingBot(true);
  writeShiftKey(bot, true);
  writeShiftKey(bot, false);
  assert.deepEqual(written, [
    { name: "entity_action", packet: { entityId: 12, actionId: 0, jumpBoost: 0 } },
    { name: "entity_action", packet: { entityId: 12, actionId: 1, jumpBoost: 0 } },
  ]);
});

test("on a later version it writes player_input shift, no entity_action", () => {
  const { bot, written } = recordingBot(false);
  writeShiftKey(bot, true);
  writeShiftKey(bot, false);
  assert.deepEqual(written, [
    { name: "player_input", packet: { inputs: { shift: true } } },
    { name: "player_input", packet: { inputs: { shift: false } } },
  ]);
});

test("setSneaking sets the control and writes the same packet", () => {
  const { bot, written, controls } = recordingBot(true);
  setSneaking(bot, true);
  setSneaking(bot, false);
  assert.deepEqual(controls, [["sneak", true], ["sneak", false]]);
  assert.deepEqual(written.map((entry) => [entry.name, entry.packet.actionId]), [["entity_action", 0], ["entity_action", 1]]);
});

test("on a later version setSneaking leaves the packet to Mineflayer: a second player_input would zero the walking inputs", () => {
  const { bot, written, controls } = recordingBot(false);
  setSneaking(bot, true);
  assert.deepEqual(controls, [["sneak", true]]);
  assert.deepEqual(written, []);
});
