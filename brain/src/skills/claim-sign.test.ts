// Claim-sign decisions over scripted runtime observations and the real foreground body.
import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { McpBotRuntime, type SignReading } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";
import { ensureClaimSign, signToUse, type HouseClaim } from "./claim-sign.ts";

const CLAIM: HouseClaim = {
  owner: "Ayla", what: "a house", dimension: "overworld", door: { x: 0, y: 64, z: 0 },
  spot: { position: { x: 1, y: 64, z: -1 }, facing: "north", support: { x: 1, y: 63, z: -1 }, wall: { x: 1, y: 64, z: 0 } },
};
const OPTIONS = { craft: false, reserved: [] } as const;
const EMPTY: SignReading["front"] = ["", "", "", ""];

/** Scripted `read_signs` data has the shape exercised by T6's runtime tests. */
function reading(front: SignReading["front"] = EMPTY, back: SignReading["back"] = EMPTY, known = true, block = "oak_sign"): SignReading {
  return { position: CLAIM.spot.position, block, known, front, back };
}

/** Use the shared brain runtime and real body; a sign success never mutates observed text. */
function setup() {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null, inventory: [{ name: "oak_sign", count: 1 }] };
  runtime.blockTags = { ...runtime.blockTags, air: ["air", "replaceable"], oak_sign: ["standing_signs"], oak_wall_sign: ["wall_signs"] };
  const controller = new AbortController();
  const body = new Body(runtime, () => {}, INSTANT_TYPING);
  const context = { runtime, body, signal: controller.signal, signLines: async () => ["Welcome"] };
  return { runtime, controller, body, context };
}

/** T5 action envelopes are scripted explicitly for incomplete writes and policy refusals. */
function unconfirmed(runtime: FakeRuntime, after: () => void = () => {}) {
  runtime.failNext.place_sign = {
    error: "[PLACE_SIGN_TEXT_UNCONFIRMED] Text was not confirmed; read the sign.", effect: after,
    result: { status: "partial", sign: { target: CLAIM.spot.position, block: "oak_sign", facing: "north", attach: "ground", lines: ["Ayla", "Welcome", "", ""], confirmed: false, placed: true } },
  };
}

for (const entry of [
  { name: "owner line standing: left as it is", front: ["Ayla", "Original", "", ""], back: EMPTY, known: true, want: "standing" },
  { name: "another's sign: taken, never broken", front: ["Steve", "", "", ""], back: EMPTY, known: true, want: "taken" },
  { name: "a sign with other text: taken, no place_sign", front: ["", "Keep out", "", ""], back: EMPTY, known: true, want: "taken" },
  { name: "text only on the back: taken", front: EMPTY, back: ["Steve", "", "", ""], known: true, want: "taken" },
  { name: "text not known: unknown, no action", front: EMPTY, back: EMPTY, known: false, want: "unknown" },
  { name: "an owner line with an unknown side: unknown, no action", front: ["Ayla", "", "", ""], back: EMPTY, known: false, want: "unknown" },
] satisfies { name: string; front: SignReading["front"]; back: SignReading["back"]; known: boolean; want: string }[]) {
  test(entry.name, async () => {
    const { runtime, context } = setup();
    runtime.signs = [reading(entry.front, entry.back, entry.known)];
    context.signLines = async () => { assert.fail("an existing claim must not call the model"); };
    assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, entry.want);
    assert.equal(runtime.submitted.length, 0);
  });
}

for (const code of ["TEXT_UNCONFIRMED", "NO_EDITOR"]) test(`a blank sign whose fill gets ${code}: blank, never broken, one try per call`, async () => {
  const { runtime, context } = setup();
  runtime.signs = [reading()];
  runtime.failures.place_sign = `[PLACE_SIGN_${code}] Read the sign before trying again.`;
  const result = await ensureClaimSign(context, CLAIM, OPTIONS);
  assert.equal(result.status, "blank");
  assert.equal(result.claim?.placed, true);
  assert.deepEqual(runtime.submitted.map(({ tool }) => tool), ["place_sign"]);
});

for (const entry of [
  { name: "one read, one fill, filled", observed: reading(), want: "filled", actions: 2, fillFails: false },
  { name: "the fill fails too: blank, no third action", observed: reading(), want: "blank", actions: 2, fillFails: true },
  { name: "text there now: taken", observed: reading(["Steve", "", "", ""]), want: "taken", actions: 1, fillFails: false },
  { name: "text remains unknown: unknown", observed: reading(EMPTY, EMPTY, false), want: "unknown", actions: 1, fillFails: false },
]) test(`a fresh placement left unconfirmed: ${entry.name}`, async () => {
  const { runtime, context } = setup();
  unconfirmed(runtime, () => {
    runtime.signs = [entry.observed];
    if (entry.fillFails) runtime.failures.place_sign = "[PLACE_SIGN_NO_EDITOR] Read before trying again.";
  });
  const result = await ensureClaimSign(context, CLAIM, OPTIONS);
  assert.equal(result.status, entry.want);
  assert.equal(result.claim?.placed, true);
  assert.equal(runtime.signReads.length, 2, "one initial read and exactly one recovery read");
  assert.equal(runtime.submitted.length, entry.actions);
  if (entry.actions === 2) assert.deepEqual(runtime.submitted[1]?.input, { ...CLAIM.spot.position, facing: "north", attach: "ground", lines: ["Ayla", "Welcome"], fill_blank: true });
});

test("given at: no status before the read; a standing sign costs one read_signs", async () => {
  const { runtime, context } = setup();
  runtime.signs = [reading(["Ayla", "", "", ""])];
  runtime.status = async () => { assert.fail("the step-end status is already supplied"); };
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, at: runtime.snapshot });
  assert.equal(result.status, "standing");
  assert.equal(runtime.signReads.length, 1);
  assert.equal(runtime.submitted.length, 0);
});

test("other dimension: no read, no action", async () => {
  const { runtime, context } = setup();
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, at: { ...runtime.snapshot, dimension: "the_nether" } });
  assert.equal(result.status, "stopped");
  assert.equal(runtime.signReads.length, 0);
  assert.equal(runtime.submitted.length, 0);
});

for (const at of [false, true]) test(`a death during the model call stops the action (given at ${at})`, async () => {
  const { runtime, context } = setup();
  const baseline = runtime.snapshot;
  context.signLines = async () => { runtime.die(null); return ["Welcome"]; };
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, ...(at && { at: baseline }) })).status, "stopped");
  assert.equal(runtime.submitted.length, 0);
});

for (const change of ["dimension", "beyond door range", "exactly door range"]) test(`the status immediately before acting checks ${change}`, async () => {
  const { runtime, context } = setup();
  context.signLines = async () => {
    runtime.snapshot = { ...runtime.snapshot, ...(change === "dimension" ? { dimension: "the_end" } : { position: { x: change === "exactly door range" ? 6 : 6.01, y: 64, z: 0 } }) };
    return ["Welcome"];
  };
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, change === "exactly door range" ? "placed" : "stopped");
  assert.equal(runtime.submitted.length, change === "exactly door range" ? 1 : 0);
});

for (const stage of ["read", "craft", "lines"]) test(`abort after the ${stage}: stopped, no new action`, async () => {
  const { runtime, controller, context, body } = setup();
  if (stage === "read") {
    const read = runtime.readSigns.bind(runtime);
    runtime.readSigns = async (at) => { const result = await read(at); controller.abort(); return result; };
  } else if (stage === "lines") context.signLines = async () => { controller.abort(); return []; };
  else {
    readyRecipe(runtime);
    body.onAction = (tool) => { if (tool === "craft_item") controller.abort(); };
  }
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true })).status, "stopped");
  assert.deepEqual(runtime.submitted.map(({ tool }) => tool), stage === "craft" ? ["craft_item"] : []);
});

test("model lines fail: owner line only", async () => {
  const { runtime, context } = setup();
  context.signLines = async () => { throw new Error("model unavailable"); };
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, "placed");
  assert.deepEqual(runtime.submitted[0]?.input.lines, ["Ayla"]);
});

/** Recipe inputs follow FakeRuntime's measured crafting-requirements shape, with no physical crafting inference. */
function readyRecipe(runtime: FakeRuntime) {
  runtime.itemFamilies = { sign: ["oak_sign", "spruce_sign"] };
  runtime.recipes = { oak_sign: { makes: 3, needs: [{ item: "oak_planks", count: 6 }, { item: "stick", count: 1 }] } };
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 6 }, { name: "stick", count: 1 }] };
}

test("no sign and nothing ready: no_sign naming what it needs", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  runtime.snapshot = { ...runtime.snapshot, inventory: [] };
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true });
  assert.equal(result.status, "no_sign");
  assert.match(result.detail, /sign/u);
  assert.match(result.detail, /oak_planks/u);
  assert.equal(runtime.submitted.length, 0);
});

test("ready only from reserved planks: no_sign", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  const reserved = [{ item: "oak_planks", count: 1 }];
  assert.equal(await signToUse(runtime, reserved), null);
  assert.equal((await ensureClaimSign(context, CLAIM, { craft: true, reserved })).status, "no_sign");
  assert.equal(runtime.submitted.length, 0);
});

test("ready from surplus: crafted then placed", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  assert.deepEqual(await signToUse(runtime, [{ item: "cobblestone", count: 20 }]), { item: "oak_sign", carried: false });
  assert.equal((await ensureClaimSign(context, CLAIM, { craft: true, reserved: [{ item: "cobblestone", count: 20 }] })).status, "placed");
  assert.deepEqual(runtime.submitted.map(({ tool }) => tool), ["craft_item", "place_sign"]);
  assert.deepEqual(runtime.submitted[0]?.input, { items: [{ item_name: "oak_sign", count: 1 }] });
  assert.equal(runtime.submitted[1]?.input.sign_item, "oak_sign");
});

test("a build never crafts a ready sign", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, "no_sign");
  assert.equal(runtime.submitted.length, 0);
});

test("a carried sign wins before recipes and reserved stock, by family rather than name", async () => {
  const { runtime } = setup();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "registry_notice", count: 0, families: ["sign"] }, { name: "another_notice", count: 2, families: ["sign"] }] };
  runtime.itemFamily = async () => { assert.fail("carried family data suffices"); };
  assert.deepEqual(await signToUse(runtime, [{ item: "oak_planks", count: 6 }]), { item: "another_notice", carried: true });
});

test("stock gone between ready and craft: no_sign, no craft", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  const needs = runtime.craftingNeeds.bind(runtime);
  runtime.craftingNeeds = async (...args) => {
    const result = await needs(...args);
    runtime.snapshot = { ...runtime.snapshot, inventory: [] };
    return result;
  };
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true })).status, "no_sign");
  assert.equal(runtime.submitted.length, 0);
});

for (const wall of ["stone", "air"]) test(`no support, front wall ${wall}: ${wall === "stone" ? "wall attach at the same cell" : "no fallback"}`, async () => {
  const { runtime, context } = setup();
  runtime.world.set("1,64,0", wall);
  runtime.failNext.place_sign = { error: "[PLACE_SIGN_NO_SUPPORT] Choose a supported cell." };
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, wall === "stone" ? "placed" : "failed");
  assert.equal(runtime.submitted.length, wall === "stone" ? 2 : 1);
  if (wall === "stone") assert.deepEqual(runtime.submitted[1]?.input, { ...CLAIM.spot.position, facing: "north", attach: "wall", sign_item: "oak_sign", lines: ["Ayla", "Welcome"] });
});

for (const [code, want] of [["CELL_TAKEN", "taken"], ["TEXT_UNKNOWN", "unknown"], ["FAILED", "failed"]]) test(`runtime ${code} refusal is surfaced as ${want}`, async () => {
  const { runtime, context } = setup();
  runtime.failures.place_sign = `[PLACE_SIGN_${code}] Inspect the cell.`;
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, want);
  assert.equal(runtime.submitted.length, 1);
});

test("death after crafting stops placement", async () => {
  const { runtime, body, context } = setup();
  readyRecipe(runtime);
  body.onAction = (tool) => { if (tool === "craft_item") runtime.die(null); };
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true })).status, "stopped");
  assert.deepEqual(runtime.submitted.map(({ tool }) => tool), ["craft_item"]);
});

test("a failed blank fill leaves the next visit able to fill without an item and then use the body", async () => {
  const { runtime, body, context } = setup();
  runtime.snapshot = { ...runtime.snapshot, inventory: [] };
  runtime.signs = [reading(EMPTY, EMPTY, true, "oak_wall_sign")];
  runtime.failNext.place_sign = { error: "[PLACE_SIGN_NO_EDITOR] Read before trying again." };
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, "blank");
  const filled = await ensureClaimSign(context, CLAIM, OPTIONS);
  assert.equal(filled.status, "filled");
  assert.deepEqual(filled.claim, { position: CLAIM.spot.position, facing: "north", attach: "wall", placed: true });
  const input = { ...CLAIM.spot.position, facing: "north", attach: "wall", fill_blank: true, lines: ["Ayla", "Welcome"] };
  assert.deepEqual(runtime.submitted, [{ tool: "place_sign", input }, { tool: "place_sign", input }]);
  assert.equal((await body.act("navigate", { x: 2, y: 64, z: 0 }, "Leave the doorway.", { signal: context.signal })).status, "succeeded");
  assert.deepEqual(runtime.submitted.map(({ tool }) => tool), ["place_sign", "place_sign", "navigate"]);
});

test("an observed sign with unknown attachment is preserved without inventing a claim record", async () => {
  const { runtime, context } = setup();
  runtime.signs = [reading()];
  runtime.blockTags = { ...runtime.blockTags, oak_sign: [] };
  const result = await ensureClaimSign(context, CLAIM, OPTIONS);
  assert.equal(result.status, "unknown");
  assert.equal(result.claim, null);
  assert.equal(runtime.submitted.length, 0);
});

for (const stage of ["before read", "during status", "during recipe", "before fallback", "before recovery fill"]) test(`abort ${stage} stops the next action`, async () => {
  const { runtime, controller, context } = setup();
  if (stage === "before read") controller.abort();
  if (stage === "during status") {
    const status = runtime.status.bind(runtime);
    runtime.status = async () => { const answer = await status(); controller.abort(); return answer; };
  }
  if (stage === "during recipe") {
    readyRecipe(runtime);
    const needs = runtime.craftingNeeds.bind(runtime);
    runtime.craftingNeeds = async (...args) => { const answer = await needs(...args); controller.abort(); return answer; };
  }
  if (stage === "before fallback") {
    runtime.world.set("1,64,0", "stone");
    runtime.failNext.place_sign = { error: "[PLACE_SIGN_NO_SUPPORT] Choose support.", effect: () => controller.abort() };
  }
  if (stage === "before recovery fill") unconfirmed(runtime, () => { runtime.signs = [reading()]; controller.abort(); });
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true });
  assert.equal(result.status, "stopped");
  assert.equal(runtime.submitted.length, stage === "before fallback" || stage === "before recovery fill" ? 1 : 0);
  if (stage === "before recovery fill") assert.equal(result.claim?.placed, true, "observed placement is retained on abort");
});

test("death during the recipe recheck stops crafting", async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  const needs = runtime.craftingNeeds.bind(runtime);
  let reads = 0;
  runtime.craftingNeeds = async (...args) => {
    const answer = await needs(...args);
    if (++reads === 2) runtime.die(null);
    return answer;
  };
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true })).status, "stopped");
  assert.equal(runtime.submitted.length, 0);
});

test("death during the recovery read stops the fill but keeps the observed placement", async () => {
  const { runtime, context } = setup();
  unconfirmed(runtime, () => {
    runtime.signs = [reading()];
    const read = runtime.readSigns.bind(runtime);
    runtime.readSigns = async (at) => { const answer = await read(at); runtime.die(null); return answer; };
  });
  const result = await ensureClaimSign(context, CLAIM, OPTIONS);
  assert.equal(result.status, "stopped");
  assert.equal(result.claim?.placed, true);
  assert.equal(runtime.submitted.length, 1);
});

for (const stage of ["read", "craft", "place"]) test(`a runtime error during ${stage} is a failed claim, the body remains usable`, async () => {
  const { runtime, body, context } = setup();
  if (stage === "read") runtime.readSigns = async () => { throw new Error("[READ_SIGNS_UNLOADED] Move closer."); };
  if (stage === "craft") { readyRecipe(runtime); runtime.throwNext.craft_item = "runtime disconnected"; }
  if (stage === "place") runtime.throwNext.place_sign = "runtime disconnected";
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true });
  assert.equal(result.status, "failed");
  assert.match(result.detail, stage === "read" ? /READ_SIGNS_UNLOADED/u : /runtime disconnected/u);
  assert.equal((await body.act("navigate", { x: 0, y: 64, z: 0 }, "Continue after the claim failure.")).status, "succeeded");
});

test("missing recipe input knowledge never risks reserved stock; later ready members are tried", async () => {
  const { runtime } = setup();
  readyRecipe(runtime);
  runtime.itemFamilies = { sign: ["undocumented_notice", "oak_sign"] };
  const needs = runtime.craftingNeeds.bind(runtime);
  runtime.craftingNeeds = async (items) => items[0]?.item === "undocumented_notice" ? { status: "ready", missing: [] } : needs(items);
  assert.deepEqual(await signToUse(runtime, [{ item: "cobblestone", count: 1 }]), { item: "oak_sign", carried: false });
  assert.deepEqual(await signToUse(runtime, [{ item: "oak_planks", count: 0 }]), { item: "oak_sign", carried: false });
});

test("given at, a carried sign costs one status before placement", async () => {
  const { runtime, context } = setup();
  let reads = 0;
  const status = runtime.status.bind(runtime);
  runtime.status = async () => { reads += 1; return status(); };
  assert.equal((await ensureClaimSign(context, CLAIM, { ...OPTIONS, at: runtime.snapshot })).status, "placed");
  assert.equal(reads, 1);
  assert.equal(runtime.signReads.length, 1);
});

for (const recovery of [false, true]) test(`a real failed sign-read envelope stops ${recovery ? "recovery fill" : "supplies and placement"}`, async () => {
  const client = McpBotRuntime.over({
    callTool: async () => ({ structuredContent: { response: { format: "json", data: { result: {
      status: "failed", error: "[READ_SIGNS_UNLOADED] The cell is not loaded; move closer and read again.", signs: [],
    } } } } }), close: async () => {},
  });
  const { runtime, context } = setup();
  if (recovery) unconfirmed(runtime, () => { runtime.readSigns = client.readSigns.bind(client); });
  else { readyRecipe(runtime); runtime.readSigns = client.readSigns.bind(client); }
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft: true });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /READ_SIGNS_UNLOADED/u);
  assert.equal(runtime.submitted.length, recovery ? 1 : 0);
  assert.equal(result.claim?.placed, recovery ? true : undefined);
});

for (const craft of [false, true]) test(`a non-sign block is taken before supplies (craft ${craft})`, async () => {
  const { runtime, context } = setup();
  readyRecipe(runtime);
  runtime.world.set("1,64,-1", "stone");
  context.signLines = async () => { assert.fail("an occupied cell needs no model lines"); };
  const result = await ensureClaimSign(context, CLAIM, { ...OPTIONS, craft });
  assert.equal(result.status, "taken");
  assert.equal(runtime.submitted.length, 0);
});

for (const missing of ["loaded cell", "block kind"]) test(`missing ${missing} knowledge cannot authorize a placement`, async () => {
  const { runtime, context } = setup();
  if (missing === "loaded cell") runtime.unloadedCells.add("1,64,-1");
  else runtime.blockKinds = async () => ({});
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, missing === "loaded cell" ? "failed" : "unknown");
  assert.equal(runtime.submitted.length, 0);
});

for (const stage of ["cellsAt", "blockKinds"] as const) test(`abort after ${stage} stops before model and placement`, async () => {
  const { runtime, controller, context } = setup();
  if (stage === "cellsAt") {
    const cells = runtime.cellsAt.bind(runtime);
    runtime.cellsAt = async (positions) => { const answer = await cells(positions); controller.abort(); return answer; };
  } else {
    const kinds = runtime.blockKinds.bind(runtime);
    runtime.blockKinds = async (names) => { const answer = await kinds(names); controller.abort(); return answer; };
  }
  context.signLines = async () => { assert.fail("no model work after abort"); };
  assert.equal((await ensureClaimSign(context, CLAIM, OPTIONS)).status, "stopped");
  assert.equal(runtime.submitted.length, 0);
});
