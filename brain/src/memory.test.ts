import assert from "node:assert/strict";
import test from "node:test";
import { activityNotesQuery, memoryNote, recall, recallQuery, staleActivityNotes, type KnownFarm } from "./memory.ts";

const LIMITS = { places: 8, lately: 5, farms: 4, times: 3 };

const farm = (overrides: Partial<KnownFarm> = {}): KnownFarm => ({
  crop: "wheat_seeds", size: 9, centre: { x: 10, y: 63, z: -5 }, madeAt: "2026-10-02T20:00:00.000Z",
  tendedAt: "2026-10-02T20:00:00.000Z", state: { planted: 80, ripe: 0, empty: 0 }, ...overrides,
});

test("a farm is remembered as a sentence for people and as data the brain reads back", () => {
  const { note, context } = memoryNote({ kind: "farm", farm: farm() });
  assert.equal(note, "My wheat_seeds farm, 9x9 around 10 63 -5: 80 planted, 0 ripe, 0 empty when I last tended it (2026-10-02T20:00:00.000Z).");
  assert.deepEqual(recall([context], LIMITS).farms, [farm()]);
});

test("only the latest note of each farm is kept, at most the limit, oldest first", () => {
  const older = memoryNote({ kind: "farm", farm: farm() }).context;
  const newer = memoryNote({ kind: "farm", farm: farm({ tendedAt: "2026-10-02T21:00:00.000Z", state: { planted: 80, ripe: 30, empty: 0 } }) }).context;
  const other = memoryNote({ kind: "farm", farm: farm({ centre: { x: 40, y: 63, z: 0 }, crop: "carrot" }) }).context;
  // Newest first, as the query returns them.
  const farms = recall([other, newer, older], LIMITS).farms;
  assert.deepEqual(farms.map((known) => [known.crop, known.state.ripe]), [["wheat_seeds", 30], ["carrot", 0]]);
  assert.equal(recall([other, newer, older], { ...LIMITS, farms: 1 }).farms.length, 1);
});

test("the recall query reads farm notes too", () => {
  assert.match(recallQuery("Ayla", LIMITS), /brain memory: farm /u);
});

test("each step's activity time is remembered and read back oldest first, at most the limit", () => {
  const time = (activity: "farming" | "mining", ended: string) => memoryNote({ kind: "activity_time", time: { activity, ended, minutes: 2.5 } });
  assert.equal(time("farming", "2026-10-03T12:00:00.000Z").note, "I spent 2.5 min farming (until 2026-10-03T12:00:00.000Z).");
  const contexts = ["12:04", "12:03", "12:02", "12:01"].map((clock, index) => time(index % 2 === 0 ? "mining" : "farming", `2026-10-03T${clock}:00.000Z`).context);
  assert.deepEqual(recall(contexts, LIMITS).times.map((record) => record.ended.slice(11, 16)), ["12:02", "12:03", "12:04"]);
  assert.match(recallQuery("Ayla", LIMITS), /brain memory: activity_time /u);
});

test("activity notes older than the last hour of play are found to forget; the one crossing the hour is kept", () => {
  const row = (id: number, minutes: number) => [id, memoryNote({ kind: "activity_time", time: { activity: "farming", ended: "2026-10-03T12:00:00.000Z", minutes } }).context] as const;
  const rows = [row(9, 30), row(8, 20), row(7, 15), row(6, 5), [5, "not a memory"], row(4, 1)];
  assert.deepEqual(staleActivityNotes(rows, 60), [6, 4]);
  assert.match(activityNotesQuery("Ayla"), /bot_id = 'Ayla' AND substr\(context, 1, \d+\) = 'brain memory: activity_time ' ORDER BY note_id DESC/u);
});

test("a step's purpose is remembered with its time; a note from before has none", () => {
  const { note, context } = memoryNote({ kind: "activity_time", time: { activity: "woodcutting", purpose: "building", ended: "2026-10-03T12:00:00.000Z", minutes: 2.5 } });
  assert.equal(note, "I spent 2.5 min woodcutting for building (until 2026-10-03T12:00:00.000Z).");
  assert.deepEqual(recall([context], LIMITS).times, [{ activity: "woodcutting", purpose: "building", ended: "2026-10-03T12:00:00.000Z", minutes: 2.5 }]);
  const old = 'brain memory: activity_time {"kind":"activity_time","time":{"activity":"mining","ended":"2026-10-03T12:00:00.000Z","minutes":3}}';
  assert.deepEqual(recall([old], LIMITS).times, [{ activity: "mining", ended: "2026-10-03T12:00:00.000Z", minutes: 3 }]);
  const unknown = 'brain memory: activity_time {"kind":"activity_time","time":{"activity":"mining","purpose":"knitting","ended":"2026-10-03T12:00:00.000Z","minutes":3}}';
  assert.deepEqual(recall([unknown], LIMITS).times, [], "a purpose of ours or none");
});

test("a house place keeps its materials; an older note without them recalls unchanged", () => {
  const house = { size: "small" as const, style: "medieval", door: { x: -2, y: 64, z: 0 }, facing: "east" as const, materials: { wall: "dirt", window: "air" } };
  const place = { name: "the small medieval house you built", detail: "door -2 64 0 facing east", own: true, house };
  assert.deepEqual(recall([memoryNote({ kind: "place", place }).context], LIMITS).places, [place]);
  const older = { name: "the small medieval house you built", detail: "door -2 64 0 facing east", own: true };
  assert.deepEqual(recall([memoryNote({ kind: "place", place: older }).context], LIMITS).places, [older]);
});

test("an unfinished house keeps its materials; an older note has none", () => {
  const site = { door: { x: 1, y: 64, z: 2 }, facing: "north" as const };
  const withMaterials = { kind: "small medieval house", site, part: 2, prepared: true, materials: { roof: "dirt" } };
  assert.deepEqual(recall([memoryNote({ kind: "unfinished_house", house: withMaterials }).context], LIMITS).unfinished, withMaterials);
  const refused = { kind: "small medieval house", site, part: 2, prepared: true, refused: [{ x: 1, y: 64, z: 1 }] };
  assert.deepEqual(recall([memoryNote({ kind: "unfinished_house", house: refused }).context], LIMITS).unfinished, refused, "the refused cells survive a restart");
  const older = { kind: "small medieval house", site, part: 2 };
  assert.deepEqual(recall([memoryNote({ kind: "unfinished_house", house: older }).context], LIMITS).unfinished, older);
});

test("a conversation is remembered as a sentence without the character, and the newest 5 are read back newest first", () => {
  const talk = (index: number) => ({ id: `Theo-${index}`, members: ["Theo", "Bruno"], topic: "the mine", gist: `gist ${index}`, endedAt: `2026-10-18T12:0${index}:00.000Z`, reason: "goodbye" as const });
  assert.equal(memoryNote({ kind: "conversation", talk: { ...talk(1), members: ["Theo"] } }).note, "I talked with Theo about the mine: gist 1 (2026-10-18T12:01:00.000Z).");
  const contexts = [7, 6, 5, 4, 3, 2, 1].map((index) => memoryNote({ kind: "conversation", talk: talk(index) }).context);
  assert.deepEqual(recall(contexts, LIMITS).conversations.map((known) => known.gist), ["gist 7", "gist 6", "gist 5", "gist 4", "gist 3"]);
  assert.deepEqual(recall(contexts, LIMITS).conversations[0], { members: ["Theo", "Bruno"], topic: "the mine", gist: "gist 7", endedAt: "2026-10-18T12:07:00.000Z" });
  assert.match(recallQuery("Ayla", LIMITS), /brain memory: conversation .*LIMIT 5/u);
});
