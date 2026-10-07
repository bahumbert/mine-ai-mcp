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
