import assert from "node:assert/strict";
import test from "node:test";
import { personaSchema } from "../persona.ts";
import { addMembers, capReached, checkRange, ending, FAR_NO_POSITION_MS, heardFarAway, isMember, lineDistance, lineSaid, manhattan, noteNoPosition, openConversation, type Limits, type NoPositionSince } from "./state.ts";

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

test("a call nobody answered ends out_of_range at waitUntil, not silence", () => {
  const c = open({ waitUntil: t0 + 60_000 });
  c.lines = 1;
  assert.equal(ending(c, "Ayla", limits, t0 + 59_999), null);
  assert.equal(ending(c, "Ayla", limits, t0 + 60_000), "out_of_range");
  c.lines = 2;
  assert.equal(ending(c, "Ayla", limits, t0 + 60_000), "silence", "they answered, then went quiet");
});

test("a conversation opened by whisper ignores range (a whisper carries any distance) but not silence or the cap", () => {
  const c = openConversation({ self: "Ayla", opener: "Theo", kind: "chance", members: [], topic: "", planned: null, whisper: true, now: t0 });
  assert.deepEqual(checkRange(c, "Ayla", here, [], limits, t0), []);
  assert.deepEqual(checkRange(c, "Ayla", here, [], limits, t0 + 120_000), [], "absent for two minutes: still a member");
  assert.deepEqual(c.members, ["Ayla", "Theo"]);
  assert.equal(ending(c, "Ayla", limits, t0 + 59_999), null);
  assert.equal(ending(c, "Ayla", limits, t0 + 60_000), "silence");
  c.lines = 24;
  assert.equal(capReached(c, limits, t0), true);
});

const shout = { username: "Lena", channel: "chat", message: "anyone?", addressed: false } as const;
const lookAt = (position: { x: number; y: number; z: number } | null) => ({ position: here, players: [{ username: "Lena", position }] });

test("lineDistance: a server distance wins over the positions", () => {
  assert.equal(lineDistance({ ...shout, distance: 7 }, lookAt({ x: 100, y: 0, z: 0 })), 7);
});

test("lineDistance: a shout with no distance is as far as the look puts the speaker (Manhattan)", () => {
  assert.equal(lineDistance(shout, lookAt({ x: 100, y: 1, z: 20 })), 121);
  assert.equal(lineDistance({ ...shout, username: "LENA" }, lookAt({ x: 5, y: 0, z: 0 })), 5, "the speaker is matched without regard to case");
});

test("lineDistance: a speaker out of tab range, offline, without a position, or with no look has no distance", () => {
  assert.equal(lineDistance(shout, { position: here, players: [] }), undefined);
  assert.equal(lineDistance(shout, lookAt(null)), undefined);
  assert.equal(lineDistance(shout, null), undefined);
});

const listed = (...players: { username: string; position: { x: number; y: number; z: number } | null }[]) => ({ position: here, players });

test("heardFarAway: a speaker listed with no position for 3 s is far; for less (a fresh login or /tp) is not", () => {
  const since: NoPositionSince = new Map();
  const look = listed({ username: "Lena", position: null });
  noteNoPosition(since, look.players, t0);
  assert.equal(heardFarAway(shout, look, since, t0), false);
  assert.equal(heardFarAway(shout, look, since, t0 + FAR_NO_POSITION_MS - 1), false);
  assert.equal(heardFarAway(shout, look, since, t0 + FAR_NO_POSITION_MS), true);
});

test("heardFarAway: a position seen in between starts the timer again", () => {
  const since: NoPositionSince = new Map();
  noteNoPosition(since, [{ username: "Lena", position: null }], t0);
  noteNoPosition(since, [{ username: "Lena", position: { x: 5, y: 0, z: 0 } }], t0 + 2_000);
  const gone = listed({ username: "Lena", position: null });
  noteNoPosition(since, gone.players, t0 + 2_500);
  assert.equal(heardFarAway(shout, gone, since, t0 + 5_000), false, "2.5 s since the position was lost");
  assert.equal(heardFarAway(shout, gone, since, t0 + 5_500), true);
});

test("heardFarAway: a name that left the list and came back starts the timer again", () => {
  const since: NoPositionSince = new Map();
  const back = listed({ username: "Lena", position: null });
  noteNoPosition(since, back.players, t0);
  noteNoPosition(since, [], t0 + 1_000);
  noteNoPosition(since, back.players, t0 + 2_500);
  assert.equal(heardFarAway(shout, back, since, t0 + 3_000), false, "listed again 0.5 s ago");
  assert.equal(heardFarAway(shout, back, since, t0 + 5_500), true);
});

test("heardFarAway: the name is matched without regard to case", () => {
  const since: NoPositionSince = new Map();
  const look = listed({ username: "Lena", position: null });
  noteNoPosition(since, look.players, t0);
  assert.equal(heardFarAway({ ...shout, username: "LENA" }, look, since, t0 + 3_000), true);
});

test("heardFarAway: not listed, a position known, a server distance or no look is not far", () => {
  const since: NoPositionSince = new Map([["lena", t0]]);
  const later = t0 + 10_000;
  assert.equal(heardFarAway(shout, listed(), since, later), false, "not listed");
  assert.equal(heardFarAway(shout, listed({ username: "Lena", position: { x: 100, y: 0, z: 0 } }), since, later), false, "position known");
  assert.equal(heardFarAway({ ...shout, distance: 150 }, listed({ username: "Lena", position: null }), since, later), false, "the server's number wins");
  assert.equal(heardFarAway(shout, null, since, later), false, "no look");
  assert.equal(heardFarAway(shout, listed({ username: "Lena", position: null }), new Map(), later), false, "never seen with no position");
});
