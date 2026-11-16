import assert from "node:assert/strict";
import test from "node:test";
import { temporaryBotData } from "../test-support/bot-data.js";
import { captureStderr } from "../test-support/stderr.js";
import { forgetSign, observeSign, recordOwnSign, signKey } from "./sign-observations.js";

const sign = { dimension: "overworld", position: { x: 1, y: 64, z: -2 }, block: "oak_sign", front: ["one", "", "", ""], back: ["", "", "", ""] };
const rows = (data: ReturnType<typeof temporaryBotData>) => data.read("SELECT * FROM observed_signs ORDER BY sign_key");

test("own sign then the same read keeps the placer", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordOwnSign(data, "Builder", sign);
  observeSign(data, sign);
  assert.equal(rows(data)[0]?.placed_by_bot_id, "Builder");
  assert.equal(rows(data)[0]?.front_json, JSON.stringify(sign.front));
  assert.equal(signKey(sign.dimension, sign.position), "overworld|1|64|-2");
});

test("changed block or either side clears the placer permanently", (t) => {
  for (const changed of [{ ...sign, block: "spruce_sign" }, { ...sign, front: ["changed", "", "", ""] }, { ...sign, back: ["changed", "", "", ""] }]) {
    const data = temporaryBotData({ closeAfter: t });
    recordOwnSign(data, "Builder", sign);
    observeSign(data, changed);
    assert.equal(rows(data)[0]?.placed_by_bot_id, null);
    observeSign(data, sign);
    assert.equal(rows(data)[0]?.placed_by_bot_id, null);
  }
});

test("forget deletes the row", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordOwnSign(data, "Builder", sign);
  forgetSign(data, sign.dimension, sign.position);
  assert.deepEqual(rows(data), []);
});

test("another dimension is another row", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordOwnSign(data, "Builder", sign);
  observeSign(data, { ...sign, dimension: "the_nether" });
  assert.deepEqual(rows(data).map((row) => row.placed_by_bot_id), ["Builder", null]);
});

test("a bad lines array is refused and logged, not thrown", (t) => {
  const lines = captureStderr(t);
  const data = temporaryBotData({ closeAfter: t });
  for (const invalid of [{ ...sign, front: ["too short"] }, { ...sign, front: new Array<string>(4) }, { ...sign, back: new Array<string>(4) }]) {
    assert.doesNotThrow(() => observeSign(data, invalid));
    assert.deepEqual(rows(data), []);
    recordOwnSign(data, "Builder", sign);
    const before = rows(data);
    observeSign(data, invalid);
    assert.deepEqual(rows(data), before);
    forgetSign(data, sign.dimension, sign.position);
  }
  assert.match(lines[0]!, /^\[observed-signs\]/u);
});

test("repeated failures are suppressed per store and reset after success", (t) => {
  const lines = captureStderr(t);
  const first = temporaryBotData({ closeAfter: t });
  const second = temporaryBotData({ closeAfter: t });
  const bad = { ...sign, front: [] };
  observeSign(first, bad);
  observeSign(first, bad);
  assert.equal(lines.length, 1);
  observeSign(second, bad);
  assert.equal(lines.length, 2);
  observeSign(first, sign);
  observeSign(first, bad);
  assert.equal(lines.length, 3);
});

test("a closed store never throws from any writer", (t) => {
  const lines = captureStderr(t);
  const data = temporaryBotData();
  data.close();
  assert.doesNotThrow(() => recordOwnSign(data, "Builder", sign));
  assert.doesNotThrow(() => observeSign(data, sign));
  assert.doesNotThrow(() => forgetSign(data, sign.dimension, sign.position));
  assert.ok(lines.length >= 1);
});
