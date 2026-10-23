import test from "node:test";
import assert from "node:assert/strict";
import { PortPairs } from "./port-block.ts";

test("pairs are handed out two apart from the start of the block, lowest free first", () => {
  const pairs = new PortPairs({ first: 25_400, last: 25_405 });
  assert.equal(pairs.lease(), 25_400);
  assert.equal(pairs.lease(), 25_402);
  pairs.release(25_400);
  assert.equal(pairs.lease(), 25_400);
});

test("a full block throws naming the block", () => {
  const pairs = new PortPairs({ first: 25_300, last: 25_303 });
  pairs.lease();
  pairs.lease();
  assert.throws(() => pairs.lease(), /25300-25303/u);
});

test("a pair outside the block (Mine Labs moved it up to find a free one) is recognised", () => {
  const pairs = new PortPairs({ first: 25_400, last: 25_405 });
  assert.equal(pairs.contains(25_402), true);
  assert.equal(pairs.contains(25_406), false);
  assert.equal(pairs.contains(25_405), false, "the RCON port 25406 would leave the block");
});
