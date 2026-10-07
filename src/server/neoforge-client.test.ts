import assert from "node:assert/strict";
import test from "node:test";
import { encodeQuery, unknownStatesAsStone } from "./neoforge-client.js";

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
