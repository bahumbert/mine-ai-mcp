import assert from "node:assert/strict";
import test from "node:test";
import { memoryNote, recall, recallQuery, type KnownFarm } from "./memory.ts";

const LIMITS = { places: 8, lately: 5, farms: 4 };

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
