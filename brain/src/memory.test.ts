import assert from "node:assert/strict";
import test from "node:test";
import { activityNotesQuery, memoryNote, recall, recallQuery, shelterNotesQuery, staleActivityNotes, staleShelterNotes, type KnownFarm } from "./memory.ts";
import { newRelation } from "./relations/record.ts";
import type { Relation } from "./relations/types.ts";

const LIMITS = { places: 8, lately: 5, farms: 4, times: 3 };

test("house claim metadata accepts absent or one-character owner/dimension and skips empty strings", () => {
  for (const field of ["owner", "dimension"]) for (const value of [undefined, "A", ""]) for (const kind of ["place", "unfinished_house"] as const) {
    const fields = value === undefined ? {} : { [field]: value };
    const house = { size: "small" as const, style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north" as const, materials: {}, ...fields };
    const place = { name: "my house", detail: "", house };
    const unfinished = { kind: "small medieval house", site: { door: house.door, facing: house.facing }, part: 0, ...fields };
    const note = kind === "place" ? memoryNote({ kind, place }) : memoryNote({ kind, house: unfinished });
    const recalled = recall([note.context], LIMITS);
    assert.deepEqual(kind === "place" ? recalled.places : recalled.unfinished, value === "" ? kind === "place" ? [] : null : kind === "place" ? [place] : unfinished, `${kind}.${field}=${JSON.stringify(value)}`);
  }
});

const farm = (overrides: Partial<KnownFarm> = {}): KnownFarm => ({
  crop: "wheat_seeds", size: 9, centre: { x: 10, y: 63, z: -5 }, madeAt: "2026-10-02T20:00:00.000Z",
  tendedAt: "2026-10-02T20:00:00.000Z", state: { planted: 80, ripe: 0, empty: 0 }, ...overrides,
});

// `farm()` has none of the stage, dry farmland or dimension fields: this is also the note from before they existed
// ("old farm note renders as before").
test("a farm is remembered as a sentence for people and as data the brain reads back", () => {
  const { note, context } = memoryNote({ kind: "farm", farm: farm() });
  assert.equal(note, "My wheat_seeds farm, 9x9 around 10 63 -5: 80 planted, 0 ripe, 0 empty when I last tended it (2026-10-02T20:00:00.000Z).");
  assert.deepEqual(recall([context], LIMITS).farms, [farm()]);
});

test("farm note keeps stage, dry and dimension", () => {
  const grown = farm({ state: { planted: 24, ripe: 0, empty: 0, stage: 3, ripeAge: 7, dry: 2 }, dimension: "overworld" });
  const { note, context } = memoryNote({ kind: "farm", farm: grown });
  assert.equal(note, "My wheat_seeds farm, 9x9 around 10 63 -5: 24 planted, 0 ripe, 0 empty, at stage 3.0 of 7, 2 dry farmland (grows slower; water within 4 blocks hydrates it) when I last tended it (2026-10-02T20:00:00.000Z).");
  assert.deepEqual(recall([context], LIMITS).farms, [grown]);
});

test("a farm note with a stage that is not a number is skipped, as any note that does not parse", () => {
  const bad = `brain memory: farm ${JSON.stringify({ kind: "farm", farm: { ...farm(), state: { planted: 1, ripe: 0, empty: 0, stage: "high" } } })}`;
  assert.deepEqual(recall([bad], LIMITS).farms, []);
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

const activityRow = (id: number, minutes: number) => [id, memoryNote({ kind: "activity_time", time: { activity: "farming", ended: "2026-10-03T12:00:00.000Z", minutes } }).context] as const;

test("activity notes older than the last hour of play are found to forget; the one crossing the hour is kept", () => {
  const rows = [activityRow(9, 30), activityRow(8, 20), activityRow(7, 15), activityRow(6, 5), [5, "not a memory"], activityRow(4, 1)];
  assert.deepEqual(staleActivityNotes(rows, 60), [6, 4]);
  assert.match(activityNotesQuery("Ayla"), /bot_id = 'Ayla' AND substr\(context, 1, \d+\) = 'brain memory: activity_time ' ORDER BY note_id DESC/u);
});

test("the note that ends exactly on the last hour of play is kept; the next one is stale", () => {
  // 30 + 30 is exactly 60: the note ending on the hour stays, the one after it is forgotten.
  assert.deepEqual(staleActivityNotes([activityRow(9, 30), activityRow(8, 30), activityRow(7, 30)], 60), [7]);
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

test("an unfinished house keeps its template, family and stage; a note whose template is gone is dropped at recall, saying so", () => {
  const site = { door: { x: 1, y: 64, z: 2 }, facing: "north" as const };
  const known = { kind: "small japanese house", site, part: 4, prepared: true, template: "japanese-small", family: "east-asia", stage: 1, stages: 4, stageName: "walls" };
  const recalled = recall([memoryNote({ kind: "unfinished_house", house: known }).context], LIMITS);
  assert.deepEqual(recalled.unfinished, known, "template, family, stage, stages and stage name survive a restart");
  assert.deepEqual(recalled.gone, []);
  const lost = recall([memoryNote({ kind: "unfinished_house", house: { ...known, kind: "rondavel", template: "no-such-house" } }).context], LIMITS);
  assert.equal(lost.unfinished, null);
  assert.deepEqual(lost.gone, ["your unfinished rondavel is no longer a house you know how to build; its protected area stays until you release_area it"]);
  const oldGone = recall([memoryNote({ kind: "unfinished_house", house: { kind: "gone house", site, part: 2 } }).context], LIMITS);
  assert.deepEqual([oldGone.unfinished, oldGone.gone.length], [null, 1], "an old note names no template: its kind must be one we know");
  const oldKnown = recall([memoryNote({ kind: "unfinished_house", house: { kind: "small medieval house", site, part: 2 } }).context], LIMITS);
  assert.equal(oldKnown.unfinished?.kind, "small medieval house");
});

test("a house place keeps its template and family; an old place with a size and style still parses; a place with no size parses", () => {
  const door = { x: -2, y: 64, z: 0 };
  const modern = { name: "the japanese house you built", detail: "door -2 64 0 facing east", house: { template: "japanese-small", family: "east-asia", door, facing: "east" as const, materials: {} } };
  assert.deepEqual(recall([memoryNote({ kind: "place", place: modern }).context], LIMITS).places, [modern]);
  const classic = { name: "the small medieval house you built", detail: "d", house: { size: "small" as const, style: "medieval", template: "medieval-small", family: "europe", door, facing: "east" as const, materials: {} } };
  assert.deepEqual(recall([memoryNote({ kind: "place", place: classic }).context], LIMITS).places, [classic]);
  const old = 'brain memory: place {"kind":"place","place":{"name":"the small medieval house you built","detail":"d","house":{"size":"small","style":"medieval","door":{"x":1,"y":64,"z":2},"facing":"north","materials":{}}}}';
  assert.equal(recall([old], LIMITS).places[0]?.house?.size, "small");
  const bad = 'brain memory: place {"kind":"place","place":{"name":"x","detail":"d","house":{"size":"huge","style":"medieval","door":{"x":1,"y":64,"z":2},"facing":"north","materials":{}}}}';
  assert.deepEqual(recall([bad], LIMITS).places, [], "a size that is not a classic size is no house");
});

test("a conversation is remembered as a sentence without the character, and the newest 5 are read back newest first", () => {
  const talk = (index: number) => ({ id: `Theo-${index}`, members: ["Theo", "Bruno"], topic: "the mine", gist: `gist ${index}`, endedAt: `2026-10-18T12:0${index}:00.000Z`, reason: "goodbye" as const });
  assert.equal(memoryNote({ kind: "conversation", talk: { ...talk(1), members: ["Theo"] } }).note, "I talked with Theo about the mine: gist 1 (2026-10-18T12:01:00.000Z).");
  assert.equal(memoryNote({ kind: "conversation", talk: { ...talk(1), topic: "" } }).note, "I talked with Theo, Bruno: gist 1 (2026-10-18T12:01:00.000Z).", "no topic: no about");
  const contexts = [7, 6, 5, 4, 3, 2, 1].map((index) => memoryNote({ kind: "conversation", talk: talk(index) }).context);
  assert.deepEqual(recall(contexts, LIMITS).conversations.map((known) => known.gist), ["gist 7", "gist 6", "gist 5", "gist 4", "gist 3"]);
  assert.deepEqual(recall(contexts, LIMITS).conversations[0], { members: ["Theo", "Bruno"], topic: "the mine", gist: "gist 7", endedAt: "2026-10-18T12:07:00.000Z" });
  assert.match(recallQuery("Ayla", LIMITS), /brain memory: conversation .*LIMIT 5/u);
});

const relationOf = (partner: string, lastDealt: number, score = 30): Relation => ({
  ...newRelation(partner, lastDealt, 0), score, lastDealt,
  facts: { tradesDone: 1, promisesKept: 1, keptLate: 0, promisesBroken: 0, iFailedToPay: 0, giftsGiven: 0, giftsReceived: 0 },
});

test("a relation note round trip", () => {
  const relation = relationOf("Theo", 5);
  const { note, context } = memoryNote({ kind: "relation", relation });
  assert.match(note, /Theo/u);
  assert.match(context, /^brain memory: relation:Theo \{/u);
  const recalled = recall([context], LIMITS);
  assert.deepEqual(recalled.relations, [relation]);
  assert.equal(recalled.skipped, 0);
  assert.match(recallQuery("Ayla", LIMITS), /brain memory: relation:/u);
});

test("relations recall caps at 30, newest dealt first, one per partner, skips a bad note and counts it", () => {
  const contexts = Array.from({ length: 35 }, (_, i) => memoryNote({ kind: "relation", relation: relationOf(`Bot${i}`, i) }).context);
  const stale = memoryNote({ kind: "relation", relation: relationOf("Bot34", 1, -5) }).context;
  const recalled = recall([...contexts.toReversed(), "brain memory: relation:Zed {bad", stale], LIMITS);
  assert.equal(recalled.relations.length, 30);
  assert.deepEqual(recalled.relations.slice(0, 2).map((r) => r.partner), ["Bot34", "Bot33"]);
  assert.equal(recalled.relations[0]?.score, 30, "the newest note of a partner wins");
  assert.equal(recalled.skipped, 1);
});

test("recall reads an old relation note", () => {
  const { score: _score, scoredAt: _scoredAt, ledger: _ledger, requests: _requests, lastHurt: _lastHurt, ...old } = { ...relationOf("Theo", 5), feeling: -2, word: "wary", why: "he cheated" };
  const recalled = recall([`brain memory: relation:Theo ${JSON.stringify({ kind: "relation", relation: old })}`], LIMITS);
  assert.equal(recalled.skipped, 0);
  assert.equal(recalled.relations[0]?.score, -60);
  assert.equal(recalled.relations[0]?.ledger[0]?.kind, "earlier");
});

test("persisted house shapes round-trip in both envelopes, accepting one-character names and rejecting empty ones", () => {
  for (const value of ["", "a", "oak_stairs"]) for (const kind of ["place", "unfinished_house"] as const) {
    const shapes = { roof: { stairs: value, slab: "oak_slab" } };
    const house = { size: "small" as const, style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north" as const, materials: { roof: "oak_planks" }, shapes };
    const place = { name: "my house", detail: "", house };
    const unfinished = { kind: "small medieval house", site: { door: house.door, facing: house.facing }, part: 0, materials: house.materials, shapes };
    const note = kind === "place" ? memoryNote({ kind, place }) : memoryNote({ kind, house: unfinished });
    const recalled = recall([note.context], LIMITS);
    assert.deepEqual(kind === "place" ? recalled.places : recalled.unfinished, value === "" ? kind === "place" ? [] : null : kind === "place" ? [place] : unfinished, `${kind} shape=${JSON.stringify(value)}`);
  }
});

test("a shelter note says the hole in a sentence and in data, and never reaches the memory a prompt is built from", () => {
  const hole = { x: 0, y: 64, z: 0, depth: 3, roofed: true, at: "2026-11-07T21:04:00.000Z" };
  const { note, context } = memoryNote({ kind: "shelter", hole });
  assert.equal(note, "I dug in at 0 64 0, 3 deep, roofed (2026-11-07T21:04:00.000Z).");
  assert.equal(context, `brain memory: shelter ${JSON.stringify({ kind: "shelter", hole })}`);
  const recalled = recall([context], LIMITS);
  assert.deepEqual([recalled.places, recalled.lately, recalled.farms, recalled.times, recalled.unfinished], [[], [], [], [], null]);
  assert.doesNotMatch(recallQuery("Ayla", LIMITS), /shelter/u);
});

test("all but the newest shelter note are found to forget, whatever other notes lie between", () => {
  const row = (id: number, x: number) => [id, memoryNote({ kind: "shelter", hole: { x, y: 64, z: 0, depth: 3, roofed: true, at: "2026-11-07T21:04:00.000Z" } }).context] as const;
  const rows = [row(9, 3), [8, "not a memory"], row(7, 2), row(4, 1)];
  assert.deepEqual(staleShelterNotes(rows), [7, 4]);
  assert.deepEqual(staleShelterNotes([row(1, 0)]), []);
  assert.match(shelterNotesQuery("Ayla"), /bot_id = 'Ayla' AND substr\(context, 1, \d+\) = 'brain memory: shelter ' ORDER BY note_id DESC/u);
});
