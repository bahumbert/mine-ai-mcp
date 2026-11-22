// Tests of the house facts the goal tier is told (temporary house, unfinished house, template bill) and of house notes saved.
import assert from "node:assert/strict";
import test from "node:test";
import { templateFor } from "../building/templates.ts";
import type { KnownPlace } from "../mind.ts";
import { memoryNote } from "../memory.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE, until } from "../testing.ts";
import { agentFor, bodyDownAt, say } from "./agent-fixtures.test.ts";

/** The goal tier's first request of an agent whose memory holds `place` as its own house. */
async function goalRequestWithHouse(t: { after(fn: () => Promise<void>): void }, house: NonNullable<KnownPlace["house"]>): Promise<string> {
  const runtime = new FakeRuntime();
  runtime.notes = [memoryNote({ kind: "place", place: { name: "the house you built", detail: "door 0 64 2 facing north", own: true, house } })];
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  return planner.requests[0]?.[1]?.content ?? "";
}

test("a temporary house gives its facts, by its template or (an old note) by its style and size: the roles and the template's own blocks, whatever the persona's style", async (t) => {
  const own = templateFor("japanese-small")!.palette.wall!;
  const door = { x: 0, y: 64, z: 2 };
  const byTemplate = await goalRequestWithHouse(t, { template: "japanese-small", family: "east-asia", door, facing: "north", materials: { wall: "dirt" } });
  assert.match(byTemplate, new RegExp(`- \\(building\\) your house at door 0 64 2 is temporary: wall dirt \\(the house's own: ${own}\\)`, "u"));
  assert.match(byTemplate, new RegExp(`improving your house needs \\d+ more ${own}`, "u"));
  const old = await goalRequestWithHouse(t, { size: "small", style: "japanese", door, facing: "north", materials: { wall: "dirt" } });
  assert.match(old, new RegExp(`is temporary: wall dirt \\(the house's own: ${own}\\)`, "u"));
});

test("a house whose template is gone gives no facts and no failure", async (t) => {
  const request = await goalRequestWithHouse(t, { template: "no-such-house", door: { x: 0, y: 64, z: 2 }, facing: "north", materials: { wall: "dirt" } });
  assert.doesNotMatch(request, /is temporary/u);
  assert.match(request, /Places you know: the house you built/u);
});

test("an unfinished house is named in the places with the step that resumes it, and in the opportunities", async (t) => {
  const runtime = new FakeRuntime();
  const house = { kind: "small japanese house", template: "japanese-small", site: { door: { x: 5, y: 64, z: 5 }, facing: "north" as const }, part: 2, prepared: true, stage: 1, stages: 4, stageName: "walls" };
  runtime.notes = [memoryNote({ kind: "unfinished_house", house })];
  const { planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /your unfinished small japanese house \(door 5 64 5; \{"skill":"build","template":"japanese-small","x":5,"y":64,"z":5\} walks there and goes on with it\)/u);
  assert.match(request, /- \(building\) your unfinished small japanese house \(stage 2 of 4, walls\), door at 5 64 5: \{"skill":"build","template":"japanese-small","x":5,"y":64,"z":5\}/u);
});

test("an unfinished house of a template nobody has any more is dropped at the start and said", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notes = [memoryNote({ kind: "unfinished_house", house: { kind: "rondavel", template: "no-such-house", site: { door: { x: 5, y: 64, z: 5 }, facing: "north" }, part: 2 } })];
  const { planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.doesNotMatch(request, /Places you know: [^\n]*your unfinished/u);
  assert.match(request, /your unfinished rondavel is no longer a house you know how to build/u, "the model reads why it has no house to finish");
});

test("the items an unfinished house needs are its template's bill; one nobody knows needs none and never throws", async (t) => {
  const { agent } = agentFor(t, new FakeRuntime());
  const inside = agent as unknown as { memory: { building: { unfinished: unknown } }; runner: { neededFor(snapshot: unknown, work: unknown): Set<string> } };
  const site = { door: { x: 5, y: 64, z: 5 }, facing: "north" as const };
  const needed = (unfinished: unknown) => {
    inside.memory.building.unfinished = unfinished;
    return inside.runner.neededFor({ inventory: [], foods: [] }, { wanted: new Set<string>(), objective: { text: "build" } });
  };
  const own = templateFor("japanese-small")!.palette.wall!;
  assert.ok(needed({ kind: "small japanese house", template: "japanese-small", site, part: 1 }).has(own), "by its template");
  assert.ok(needed({ kind: "small japanese house", site, part: 1 }).has(own), "an old note, by its kind");
  assert.equal(needed({ kind: "gone house", site, part: 1 }).has(own), false, "no template: no bill, no throw");
  assert.equal(needed(null).has(own), false);
});

// Plan 2026-11-09-house-templates Task 1 (P1, run 17b): the unfinished house is saved when it changes, and again when the save did not go through.

/** The unfinished-house notes saved so far, oldest first, as their JSON. */
function unfinishedHouseNotes(runtime: FakeRuntime): string[] {
  return runtime.notes.map((note) => note.context).filter((context) => context.startsWith("brain memory: unfinished_house "));
}

/** A house at Steve's request: Ayla stands by the site with exactly the bill. */
function houseOrderRuntime(): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL_HOUSE, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
  // The claim sign's cell is free when the game tags its block (air) so; without the tag the claim reads it as taken and
  // the build refuses to start (the wall behind the sign is then asked to stand already).
  runtime.blockTags = { ...runtime.blockTags, air: ["air", "replaceable"] };
  return runtime;
}

test("a note not saved while the body is down is saved when the body is back", async (t) => {
  const runtime = houseOrderRuntime();
  // A body that is down fails every call, note_save included, until two status reads have failed (`failStatusReads` is no help: the saves must fail too).
  let down = false;
  let failedReads = 0;
  let parts = 0;
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input) => {
    if (down) throw bodyDownAt(30_000);
    if (tool === "build_structure" && (parts += 1) === 2) {
      down = true;
      throw bodyDownAt(30_000);
    }
    return submit(tool, input);
  };
  const status = runtime.status.bind(runtime);
  runtime.status = async () => {
    if (!down) return status();
    if ((failedReads += 1) >= 2) down = false;
    throw bodyDownAt(30_000);
  };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "build Steve a small house" }, { say: "Later then." });
  action.reply({ step: { skill: "build" } }, { done: "the body went down; I stop here" });
  await agent.handle(say("Steve", "build me a house"));
  const leftByTheStop = () => unfinishedHouseNotes(runtime).some((note) => note.includes("\"kind\":\"small medieval house\"") && note.includes("\"part\":1,\"prepared\":true"));
  await until(leftByTheStop, 3_000);
  assert.ok(leftByTheStop(), "the record the stop left is saved");
});

test("a house recorded as prepared is saved before its first part is built", async (t) => {
  // A brain that dies during the first part must find the house prepared: the note goes to the body before the next call.
  const runtime = houseOrderRuntime();
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "build Steve a small house" }, { say: "Done!" });
  action.reply({ step: { skill: "build" } }, { done: "the house is up" });
  await agent.handle(say("Steve", "build me a house"));
  await until(() => runtime.submitted.some((call) => call.tool === "build_structure"));
  const asked = runtime.submitted.flatMap((call) => call.tool === "build_structure" ? ["part"] : call.tool === "note_save" && String(call.input.context).includes("\"prepared\":true") ? ["prepared"] : []);
  assert.deepEqual(asked.slice(0, 2), ["prepared", "part"]);
});
