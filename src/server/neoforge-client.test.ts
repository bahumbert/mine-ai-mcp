import assert from "node:assert/strict";
import test from "node:test";
import { clickWithoutPrediction, encodeQuery, packetId, tolerateUnparsed, unknownStatesAsStone } from "./neoforge-client.js";

test("an unreadable window's contents open the window empty; another unreadable packet is skipped", () => {
  // Live 2026-10-07: the contents of a crafting table's window held a modded item, and every boat craft timed out.
  assert.equal(packetId("1.21.1", "window_items"), 0x13);
  let onState: ((state: string) => void) | null = null;
  const deserializer = { parsePacketBuffer: (_buffer: Buffer): unknown => { throw new Error("array size is abnormally large"); } };
  const client = { deserializer, on: (event: string, listener: (state: string) => void) => { if (event === "state") onState = listener; } };
  const windows: number[] = [];
  tolerateUnparsed(client as never, 0x13, (windowId) => windows.push(windowId));
  (onState as unknown as (state: string) => void)("play");

  const contents = deserializer.parsePacketBuffer(Buffer.from([0x13, 3, 0x2a, 0xff])) as { data: unknown };
  assert.deepEqual(contents.data, { name: "window_items", params: { windowId: 3, stateId: 42, items: [] } });
  assert.deepEqual(windows, [3]);
  const other = deserializer.parsePacketBuffer(Buffer.from([0x77, 1, 2])) as { data: unknown };
  assert.deepEqual(other.data, { name: "neoforge_unparsed", params: { id: 0x77 } });
});

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
