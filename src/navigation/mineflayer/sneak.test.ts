import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setSneaking, writeShiftKey } from "./sneak.js";

/**
 * A bot on the shared fake, with the packets the server received: 1.21.5 is the last version whose server reads the
 * shift from entity_action, 1.21.6 the first to read player_input. The fake's `setControlState` writes what Mineflayer
 * writes for the control (`physics.js:245-275`), so a packet it adds shows up here too.
 */
function recordingBot(entityAction: boolean) {
  const { bot, server } = createFakeBot({ version: entityAction ? "1.21.5" : "1.21.6" });
  const written = () => server.packets.map(({ name, data }) => ({ name, packet: data }));
  return { bot, written };
}

test("on a version that reads the shift from entity_action, a press writes entity_action 0 and a release 1", () => {
  const { bot, written } = recordingBot(true);
  writeShiftKey(bot, true);
  writeShiftKey(bot, false);
  assert.deepEqual(written(), [
    { name: "entity_action", packet: { entityId: bot.entity.id, actionId: 0, jumpBoost: 0 } },
    { name: "entity_action", packet: { entityId: bot.entity.id, actionId: 1, jumpBoost: 0 } },
  ]);
});

test("on a later version it writes player_input shift, no entity_action", () => {
  const { bot, written } = recordingBot(false);
  writeShiftKey(bot, true);
  writeShiftKey(bot, false);
  assert.deepEqual(written(), [
    { name: "player_input", packet: { inputs: { shift: true } } },
    { name: "player_input", packet: { inputs: { shift: false } } },
  ]);
});

test("setSneaking sets the control and writes the same packet", () => {
  const { bot, written } = recordingBot(true);
  const controls: boolean[] = [];
  setSneaking(bot, true);
  controls.push(bot.getControlState("sneak"));
  setSneaking(bot, false);
  controls.push(bot.getControlState("sneak"));
  assert.deepEqual(controls, [true, false]);
  // Mineflayer's own write for the control comes first (player_input on 1.21.3 and later), then the entity_action the server reads.
  assert.deepEqual(
    written().map((entry) => (entry.name === "entity_action" ? `entity_action:${(entry.packet as { actionId: number }).actionId}` : entry.name)),
    ["player_input", "entity_action:0", "player_input", "entity_action:1"],
  );
});

test("on a later version setSneaking leaves the packet to Mineflayer: a second player_input would zero the walking inputs", () => {
  const { bot, written } = recordingBot(false);
  setSneaking(bot, true);
  assert.equal(bot.getControlState("sneak"), true);
  assert.deepEqual(written(), [{ name: "player_input", packet: { inputs: { shift: true } } }], "Mineflayer's one packet, none added");
});
