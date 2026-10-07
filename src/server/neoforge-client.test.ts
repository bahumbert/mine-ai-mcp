import assert from "node:assert/strict";
import test from "node:test";
import { clickWithoutPrediction, encodeQuery, unknownStatesAsStone } from "./neoforge-client.js";

test("a container click goes without the client's slot prediction, every other packet as it is", () => {
  const sent: [string, object][] = [];
  const client = { write: (name: string, params: object) => void sent.push([name, params]) };
  clickWithoutPrediction(client);

  client.write("window_click", { windowId: 0, stateId: 7, slot: 38, mouseButton: 1, mode: 4, changedSlots: [{ location: 38, item: { itemCount: 1, itemId: 10_937 } }], cursorItem: { itemCount: 1, itemId: 5 } });
  client.write("chat_message", { message: "hi" });

  assert.deepEqual(sent, [
    ["window_click", { windowId: 0, stateId: 7, slot: 38, mouseButton: 1, mode: 4, changedSlots: [], cursorItem: { itemCount: 0 } }],
    ["chat_message", { message: "hi" }],
  ]);
});

test("the channel query lists each non-empty protocol with its channels' id, version, flow and optional flag", () => {
  const query = encodeQuery({
    "1": [{ id: "a:b", version: "1", flow: 1, optional: false }],
    "4": [],
  });

  // 1 protocol; protocol 1 with 1 channel; "a:b"; "1"; flow present = 1; not optional.
  assert.deepEqual([...query], [1, 1, 1, 3, 0x61, 0x3a, 0x62, 1, 0x31, 1, 1, 0]);
});

test("a block state the vanilla data does not know reads as stone, a known one as itself", () => {
  const stone = { name: "stone" };
  const dirt = { name: "dirt" };
  const registry = { blocksByStateId: { 10: dirt } as Record<number, unknown>, blocksByName: { stone } };

  unknownStatesAsStone(registry);
  unknownStatesAsStone(registry);

  assert.equal(registry.blocksByStateId[10], dirt);
  assert.equal(registry.blocksByStateId[99_999], stone);
});
