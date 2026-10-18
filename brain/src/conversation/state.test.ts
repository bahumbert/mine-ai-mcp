import assert from "node:assert/strict";
import test from "node:test";
import { personaSchema } from "../persona.ts";
import { addMembers, capReached, checkRange, ending, isMember, lineSaid, manhattan, openConversation, type Limits } from "./state.ts";

const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
const limits: Limits = { ...personaSchema.parse(base).settings.conversation, talkRange: 64 };
const t0 = 1_000_000;
const here = { x: 0, y: 0, z: 0 };
const open = (extra: { waitUntil?: number } = {}) => openConversation({
  self: "Ayla", opener: "Ayla", kind: "chance", members: ["Theo"], topic: "mine", planned: "short", whisper: false, now: t0, ...extra,
});

test("a member out of range for 20 s is dropped", () => {
  const c = open();
  const far = [{ username: "Theo", position: { x: 70, y: 0, z: 0 } }];
  assert.deepEqual(checkRange(c, "Ayla", here, far, limits, t0), []);
  assert.equal(c.outOfRangeSince.Theo, t0);
  assert.deepEqual(checkRange(c, "Ayla", here, far, limits, t0 + 19_999), []);
  assert.deepEqual(checkRange(c, "Ayla", here, far, limits, t0 + 20_000), ["Theo"]);
  assert.equal(isMember(c, "Theo"), false);
});

test("back in range before 20 s clears the timer", () => {
  const c = open();
  checkRange(c, "Ayla", here, [{ username: "Theo", position: { x: 70, y: 0, z: 0 } }], limits, t0);
  checkRange(c, "Ayla", here, [{ username: "Theo", position: { x: 5, y: 0, z: 0 } }], limits, t0 + 10_000);
  assert.deepEqual(c.outOfRangeSince, {});
});

test("absent member counts as out of range", () => {
  for (const players of [[], [{ username: "Theo", position: null }]]) {
    const c = open();
    assert.deepEqual(checkRange(c, "Ayla", here, players, limits, t0), []);
    assert.equal(c.outOfRangeSince.Theo, t0);
    assert.deepEqual(checkRange(c, "Ayla", here, players, limits, t0 + 20_000), ["Theo"]);
    assert.equal(ending(c, "Ayla", limits, t0 + 20_000), "out_of_range");
  }
});

test("silence ends it after 60 s", () => {
  const c = open();
  assert.equal(ending(c, "Ayla", limits, t0 + 59_999), null);
  assert.equal(ending(c, "Ayla", limits, t0 + 60_000), "silence");
  lineSaid(c, t0 + 50_000);
  assert.equal(ending(c, "Ayla", limits, t0 + 60_000), null);
});

test("nothing ends before waitUntil", () => {
  const c = open({ waitUntil: t0 + 60_000 });
  assert.deepEqual(checkRange(c, "Ayla", here, [], limits, t0 + 59_000), []);
  assert.equal(ending(c, "Ayla", limits, t0 + 59_000), null);
});

test("cap at 24 lines or 6 minutes", () => {
  const c = open();
  c.lines = 23;
  assert.equal(capReached(c, limits, t0 + 359_999), false);
  assert.equal(capReached(c, limits, t0 + 360_000), true);
  c.lines = 24;
  assert.equal(capReached(c, limits, t0), true);
});

test("addMembers ignores case and self", () => {
  const c = open();
  assert.deepEqual(addMembers(c, ["theo", "ayla"]), []);
  assert.deepEqual(addMembers(c, ["theo", "Bruno"]), ["Bruno"]);
});

test("the record opens with self and opener, id from the opener", () => {
  const c = openConversation({ self: "Ayla", opener: "Tester", kind: "chance", members: ["Ayla"], topic: "", planned: null, whisper: true, now: t0 });
  assert.deepEqual(c.members, ["Ayla", "Tester"]);
  assert.equal(c.id, `Tester-${t0}`);
});

test("manhattan distance", () => {
  assert.equal(manhattan({ x: 0, y: 0, z: 0 }, { x: 3, y: -4, z: 5 }), 12);
});
