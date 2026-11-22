// House claims across preparation, construction, cancellation and improvement.
import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { planTemplate } from "../building/plan.ts";
import { memoryNote, recall } from "../memory.ts";
import type { KnownPlace } from "../mind.ts";
import type { Position, SignReading } from "../runtime-client.ts";
import { runStep, type UnfinishedHouse } from "../skills.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE } from "../testing.ts";
import { contextFor, SIGNED_MEDIEVAL, SIGNED_TEMPLATES } from "./skill-fixtures.test.ts";

const STEP = { skill: "build", structure: "house", size: "small" } as const;
const SITE = { door: { x: 0, y: 64, z: 2 }, facing: "north" } as const;
const SPOT = planTemplate(SIGNED_MEDIEVAL, SITE).sign!;
const EMPTY: SignReading["front"] = ["", "", "", ""];

/** Script the read separately: FakeRuntime's place_sign success does not observe a block or text. */
function sign(front: SignReading["front"] = EMPTY): SignReading {
  return { position: SPOT.position, block: "oak_sign", known: true, front, back: EMPTY };
}

/** The shared brain runtime supplies action results; claim reads use T6's measured sign envelope. */
function setup() {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: [...SMALL_MEDIEVAL_HOUSE, { name: "oak_sign", count: 1 }] };
  runtime.blockTags = { ...runtime.blockTags, air: ["air", "replaceable"], oak_sign: ["standing_signs"], oak_wall_sign: ["wall_signs"] };
  const building: { unfinished: UnfinishedHouse | null } = { unfinished: null };
  const places: KnownPlace[] = [];
  const controller = new AbortController();
  const context = contextFor(runtime, {
    self: "Ayla", style: "medieval", templates: SIGNED_TEMPLATES, building, signal: controller.signal,
    body: new Body(runtime, () => {}, INSTANT_TYPING), remember: (place) => places.push(place),
    signLines: async () => ["Welcome"],
  });
  return { runtime, building, places, controller, context };
}

/** The runtime confirms the block before a cut write; reading, rather than the fake success, decides the fill. */
function blankAfterPlacement(runtime: FakeRuntime) {
  runtime.failNext.place_sign = {
    error: "[PLACE_SIGN_TEXT_UNCONFIRMED] Read the sign before filling.",
    result: { status: "partial", sign: { target: SPOT.position, block: "oak_sign", facing: "north", attach: "ground", lines: ["Ayla", "Welcome", "", ""], confirmed: false, placed: true } },
    effect: () => { runtime.signs = [sign()]; runtime.failures.place_sign = "[PLACE_SIGN_NO_EDITOR] Read the sign before filling."; },
  };
}

test("the claim runs after the site is prepared, before part 1, line 1 = self", async () => {
  const { runtime, context, places } = setup();
  runtime.world.set("0,64,3", "dirt");
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "wooden_shovel", count: 1 }] };
  const result = await runStep(STEP, context);
  assert.equal(result.status, "done", JSON.stringify(result));
  const claim = runtime.submitted.findIndex(({ tool }) => tool === "place_sign");
  const builds = runtime.submitted.flatMap(({ tool }, index) => tool === "build_structure" ? [index] : []);
  assert.ok(builds[0]! < claim && claim < builds[1]!, "prepare, claim, part 1");
  assert.deepEqual(runtime.submitted[claim]?.input.lines, ["Ayla", "Welcome"]);
  assert.equal(places[0]?.house?.owner, "Ayla");
  assert.equal(places[0]?.house?.dimension, "minecraft:overworld");
  assert.match(result.status === "done" ? result.detail : "", /claim sign placed: Ayla/u);
  assertKept(runtime, [SPOT.position, SPOT.support], claim + 1);
});

for (const requester of ["Alex", undefined]) test(`an ordered house keeps its requester owner on resume under ${requester ?? "an own goal"}`, async () => {
  const { runtime, context, building, places } = setup();
  runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] Interrupted part." };
  assert.equal((await runStep(STEP, { ...context, requester: "Steve" })).status, "failed");
  assert.equal(building.unfinished?.owner, "Steve");
  assert.equal(building.unfinished?.dimension, "minecraft:overworld");
  const resumed = recall([memoryNote({ kind: "unfinished_house", house: building.unfinished }).context], { places: 8, lately: 5, farms: 4, times: 3 }).unfinished;
  building.unfinished = resumed;
  runtime.submitted.length = 0;
  const result = await runStep(STEP, { ...context, requester });
  assert.equal(result.status, "done");
  assert.deepEqual(runtime.submitted.find(({ tool }) => tool === "place_sign")?.input.lines, ["Steve", "Welcome"]);
  assert.equal(places[0]?.house?.owner, "Steve");
  assert.equal(places[0]?.own, undefined);
  assert.match(places[0]?.name ?? "", /for Steve$/u);
});

for (const failure of ["refusal", "throw", "read throws", "part failure"]) test(`a claim ${failure} preserves the house result and its claim clause`, async () => {
  const { runtime, context, building, places } = setup();
  const partFails = failure === "part failure";
  if (failure === "refusal" || partFails) runtime.failures.place_sign = "[PLACE_SIGN_NO_EDITOR] Inspect the sign.";
  else if (failure === "throw") runtime.throwNext.place_sign = "claim transport failed";
  else runtime.readSigns = async () => { throw new Error("sign read failed"); };
  if (partFails) runtime.failNext.build_structure = { error: "[BUILD_INCOMPLETE] Part could not finish." };
  const result = await runStep(STEP, context);
  assert.equal(result.status, partFails ? "failed" : "done");
  assert.equal(places.length, partFails ? 0 : 1);
  if (partFails) {
    assert.equal(building.unfinished?.owner, "Ayla");
    assert.match(result.status === "failed" ? result.detail : "", /Part could not finish/u);
  } else assert.equal(building.unfinished, null);
  assert.match(result.detail, failure === "throw" ? /claim sign placed:/u : /no claim sign yet:/u);
});

for (const blank of [false, true]) test(`a resumed ${blank ? "blank" : "standing"} wall claim retains its attachment for improvement`, async () => {
  const { runtime, context, building, places } = setup();
  runtime.signs = [{ ...sign(blank ? EMPTY : ["Ayla", "", "", ""]), block: "oak_wall_sign" }];
  const claim = { position: SPOT.position, facing: "north", attach: "wall", placed: true } as const;
  // The roof is dirt: carried, or the stage that places it ends the step before the house is whole.
  runtime.snapshot = { ...runtime.snapshot, inventory: [...runtime.snapshot.inventory, { name: "dirt", count: 100 }] };
  runtime.world.set("1,64,2", "oak_planks");
  building.unfinished = { kind: "small medieval house", site: SITE, part: 0, prepared: true, owner: "Ayla", dimension: "minecraft:overworld", materials: { roof: "dirt" }, claim };
  assert.equal((await runStep(STEP, context)).status, "done");
  assert.deepEqual(places[0]?.house?.claim, claim);
  runtime.world.set("1,64,2", "oak_planks");
  runtime.submitted.length = 0;
  assert.equal((await runStep({ skill: "improve_house", roles: ["roof"] }, { ...context, ownHouse: () => places[0]! })).status, "done");
  assertKept(runtime, [SPOT.position, SPOT.wall]);
});

for (const staysBlank of [false, true]) test(`a sign left blank before part 1: ${staysBlank ? "still blank after the end pass, house done" : "filled at the end pass"}`, async () => {
  const { runtime, context, places } = setup();
  blankAfterPlacement(runtime);
  context.body.onAction = (tool) => { if (tool === "build_structure" && !staysBlank) delete runtime.failures.place_sign; };
  const result = await runStep(STEP, context);
  assert.equal(result.status, "done");
  const last = runtime.submitted.at(-1)!;
  assert.equal(last.tool, "place_sign", "one final fill follows the house audit");
  assert.equal(last.input.fill_blank, true);
  assert.match(result.status === "done" ? result.detail : "", staysBlank ? /no claim sign yet:.*blank/iu : /claim sign placed: Ayla/u);
  const house = places[0]?.house;
  assert.deepEqual(house?.claim, { position: SPOT.position, facing: "north", attach: "ground", placed: true });
  const recalled = recall([memoryNote({ kind: "place", place: places[0]! }).context], { places: 8, lately: 5, farms: 4, times: 3 });
  assert.deepEqual(recalled.places[0]?.house, house, "the claim survives a restart");
  assert.equal((await runStep({ skill: "go_to", x: 0, y: 64, z: 0 }, context)).status, "done", "the next action can use the body");
});

test("abort during the claim: unfinished at part 0, the resume builds and claims", async () => {
  const { runtime, context, controller, building, places } = setup();
  blankAfterPlacement(runtime);
  runtime.failNext.place_sign = { ...runtime.failNext.place_sign!, effect: () => { runtime.signs = [sign()]; controller.abort(); } };
  assert.equal((await runStep(STEP, context)).status, "stopped");
  assert.equal(building.unfinished?.part, 0);
  assert.equal(building.unfinished?.prepared, true);
  assert.equal(building.unfinished?.owner, "Ayla");
  assert.equal(building.unfinished?.claim?.placed, true);
  assert.equal(runtime.submitted.some(({ tool }) => tool === "build_structure"), false);
  assert.equal(places.length, 0);
  assert.equal((await runStep(STEP, { ...context, requester: "Alex", signal: new AbortController().signal })).status, "done");
  assert.equal(building.unfinished, null);
  assert.equal(runtime.submitted.filter(({ tool }) => tool === "place_sign").at(-1)?.input.fill_blank, true);
  assert.equal(places[0]?.own, true);
});

test("the new house's bill includes one sign; a resume's does not", async () => {
  const { runtime, context, building } = setup();
  runtime.snapshot = { ...runtime.snapshot, inventory: SMALL_MEDIEVAL_HOUSE };
  runtime.itemFamilies = { sign: ["oak_sign"] };
  runtime.recipes = { oak_sign: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] } };
  const fresh = await runStep(STEP, context);
  assert.equal(fresh.status, "failed");
  assert.match(fresh.status === "failed" ? fresh.detail : "", /missing 1 oak_sign/u);
  assert.equal(runtime.submitted.length, 0);
  building.unfinished = { kind: "small medieval house", site: SITE, part: 0, prepared: true, owner: "Ayla", dimension: "minecraft:overworld" };
  const resumed = await runStep(STEP, context);
  assert.equal(resumed.status, "done");
  assert.equal(runtime.submitted.some(({ tool }) => tool === "craft_item"), false);
  assert.match(resumed.status === "done" ? resumed.detail : "", /no claim sign yet:/u);
});

/** Every construction and audit request must protect cells outside the blueprint itself. */
function assertKept(runtime: FakeRuntime, cells: readonly Position[], from = 0) {
  const calls = runtime.submitted.slice(from).filter(({ tool }) => tool === "build_structure");
  assert.ok(calls.length > 2);
  for (const call of calls) for (const cell of cells) assert.ok((call.input.keep as Position[] | undefined)?.some((kept) => kept.x === cell.x && kept.y === cell.y && kept.z === cell.z), JSON.stringify({ cell, call }));
}

for (const attach of ["ground", "wall"] as const) test(`improve_house keeps the ${attach} claim cells`, async () => {
  const { runtime, context, places } = setup();
  const claim = { position: SPOT.position, facing: "north", attach, placed: true } as const;
  const place: KnownPlace = { name: "my house", detail: "door 0 64 2", own: true, house: { size: "small", style: "medieval", ...SITE, materials: { wall: "dirt" }, owner: "Ayla", dimension: "minecraft:overworld", claim } };
  runtime.world.set("1,64,2", "dirt");
  const result = await runStep({ skill: "improve_house" }, { ...context, ownHouse: () => place });
  if (attach === "wall") {
    assert.equal(result.status, "failed");
    assert.match(result.status === "failed" ? result.detail : "", /claim sign.*support/iu);
    assert.equal(runtime.submitted.some(({ tool }) => tool === "build_structure"), false);
    assert.equal(places.length, 0, "the wall stays temporary");
    return;
  }
  assert.equal(result.status, "done");
  assertKept(runtime, [SPOT.position, SPOT.support]);
  assert.deepEqual(places[0]?.house?.claim, claim);
});

test("an older note without owner/dimension: no claim fields invented", async () => {
  const { runtime, context, building, places } = setup();
  building.unfinished = { kind: "small medieval house", site: SITE, part: 0, prepared: true };
  assert.equal((await runStep(STEP, context)).status, "done");
  assert.equal(runtime.signReads.length, 0);
  assert.equal(runtime.submitted.some(({ tool }) => tool === "place_sign"), false);
  for (const field of ["owner", "dimension", "claim"]) assert.equal(field in places[0]!.house!, false);
});
