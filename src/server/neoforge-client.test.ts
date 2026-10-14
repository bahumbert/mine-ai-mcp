import assert from "node:assert/strict";
import test from "node:test";
import { askSlotBySlot, clickWithoutPrediction, encodeQuery, packetId, tolerateUnparsed, unknownStatesAsStone } from "./neoforge-client.js";

test("an unreadable window's contents open the window empty; another unreadable packet is skipped", () => {
  // Live 2026-10-07: the contents of a crafting table's window held a modded item, and every boat craft timed out.
  assert.equal(packetId("1.21.1", "window_items"), 0x13);
  assert.equal(packetId("1.21.1", "set_slot"), 0x15);
  let onState: ((state: string) => void) | null = null;
  const deserializer = { parsePacketBuffer: (_buffer: Buffer): unknown => { throw new Error("array size is abnormally large"); } };
  const client = { deserializer, on: (event: string, listener: (state: string) => void) => { if (event === "state") onState = listener; } };
  const windows: [number, number][] = [];
  tolerateUnparsed(client as never, { windowItems: 0x13, setSlot: 0x15 }, (windowId, stateId) => windows.push([windowId, stateId]));
  (onState as unknown as (state: string) => void)("play");

  const contents = deserializer.parsePacketBuffer(Buffer.from([0x13, 3, 0x2a, 0xff])) as { data: unknown };
  assert.deepEqual(contents.data, { name: "window_items", params: { windowId: 3, stateId: 42, items: [] } });
  assert.deepEqual(windows, [[3, 42]]);
  const other = deserializer.parsePacketBuffer(Buffer.from([0x77, 1, 2])) as { data: unknown };
  assert.deepEqual(other.data, { name: "neoforge_unparsed", params: { id: 0x77 } });

  // A slot update holding a modded item: window 0, state 7, slot 36, 1 of item 1500 (varint 0xdc 0x0b), components.
  const slot = deserializer.parsePacketBuffer(Buffer.from([0x15, 0, 7, 0, 36, 1, 0xdc, 0x0b, 2, 0, 0x99])) as { data: unknown };
  assert.deepEqual(slot.data, {
    name: "set_slot",
    params: { windowId: 0, stateId: 7, slot: 36, item: { itemCount: 1, itemId: 1500, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } },
  });
  const cursor = deserializer.parsePacketBuffer(Buffer.from([0x15, 0xff, 7, 0xff, 0xff, 2, 5])) as { data: { params: object } };
  assert.deepEqual(cursor.data.params, { windowId: -1, stateId: 7, slot: -1, item: { itemCount: 2, itemId: 5, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } });
});

test("a window whose contents could not be read is asked for slot by slot, by a click that does nothing", () => {
  const sent: [string, { changedSlots: { location: number }[] } & Record<string, unknown>][] = [];
  const send = (name: string, params: object) => void sent.push([name, params as never]);
  askSlotBySlot(send, { currentWindow: null }, 0, 9);
  askSlotBySlot(send, { currentWindow: { id: 4, slots: new Array(46) } as never }, 4, 2);
  askSlotBySlot(send, { currentWindow: null }, 5, 2);

  assert.equal(sent.length, 2);
  const [name, params] = sent[0]!;
  assert.equal(name, "window_click");
  assert.deepEqual({ ...params, changedSlots: params.changedSlots.length }, {
    windowId: 0, stateId: 9, slot: -999, mouseButton: 0, mode: 0, changedSlots: 46,
    cursorItem: { itemCount: 0, components: [], removeComponents: [] },
  });
  assert.deepEqual(params.changedSlots.map((entry) => entry.location), Array.from({ length: 46 }, (_, index) => index));
  assert.equal(sent[1]![1].windowId, 4);
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
