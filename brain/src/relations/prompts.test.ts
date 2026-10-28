import assert from "node:assert/strict";
import test from "node:test";
import { chatSystemPrompt } from "../llm-mind.ts";
import { testPersona, testScoring } from "../testing.ts";
import { openingRelationLines, parseGistPartners, parseTrade, relationsBlock, tooFarLine, tradeInstructions } from "./prompts.ts";
import { newRelation, withSaid } from "./record.ts";

const good = { action: "propose", give: [{ item: "oak_log", count: 5 }], get: [{ item: "bread", count: 3 }], first: "me" };

test("parseTrade reads each action", () => {
  for (const action of ["propose", "accept", "decline", "cancel"]) {
    assert.equal(parseTrade({ ...good, action })?.action, action);
  }
  assert.deepEqual(parseTrade(good), { action: "propose", give: [{ item: "oak_log", count: 5 }], get: [{ item: "bread", count: 3 }], first: "me" });
  assert.deepEqual(parseTrade({ action: "propose", give: [{ item: "bread", count: 1 }], first: "them" })?.get, [], "a gift has no get");
  assert.equal(parseTrade({ action: "decline", first: undefined })?.action, "decline", "a refusal needs no sides");
});

test("parseTrade: absent or malformed is no trade", () => {
  const entry = { item: "oak_log", count: 1 };
  assert.equal(parseTrade(undefined), null);
  assert.equal(parseTrade(null), null);
  assert.equal(parseTrade("trade"), null);
  assert.equal(parseTrade({ ...good, give: [{ item: "oak_log", count: 0 }] }), null);
  assert.equal(parseTrade({ ...good, give: [{ item: "oak_log", count: 65 }] }), null);
  assert.equal(parseTrade({ ...good, give: [{ item: "oak_log", count: 1.5 }] }), null);
  assert.equal(parseTrade({ ...good, give: Array(5).fill(entry) }), null);
  assert.equal(parseTrade({ ...good, action: "swap" }), null);
  assert.equal(parseTrade({ action: "propose", give: good.give, get: good.get }), null, "first is missing");
  assert.equal(parseTrade({ action: "propose", give: [], get: [], first: "me" }), null, "a proposal with nothing in it");
});

test("relationsBlock lists each partner and what the objective lacks", () => {
  const text = relationsBlock(["You and Theo: friend (+2).", "You have not dealt with Ayla before."], ["iron_ingot x3"]);
  assert.match(text, /You and Theo/u);
  assert.match(text, /Your current objective lacks: iron_ingot x3/u);
  assert.doesNotMatch(relationsBlock(["x"], []), /lacks/u);
  assert.equal(relationsBlock([], []), "");
});

test("relationsBlock tells how feelings show, in the character's own measure", () => {
  const text = relationsBlock(["You and Theo: 45, you like Theo."], []);
  assert.ok(text.startsWith("Your relations:\nHow you feel about someone shows in how you talk to them and in what you do for them; how much is yours, from your traits.\nYou and Theo"), text);
});

test("no threshold in the prompt", () => {
  const prompt = chatSystemPrompt(testPersona({ preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } }), true, undefined, false, true);
  const text = `${prompt}\n${relationsBlock(["You and Theo: 45, you like Theo."], [])}`;
  assert.doesNotMatch(text, /score[^.\n]*-?(60|20)\b|-?(60|20)\b[^.\n]*score/iu);
  assert.doesNotMatch(text, /\b(enemy|dislike|friend)\b[^.\n]*\b(at|below|above|under|over) -?\d+/iu);
});

test("tradeInstructions give the tools and no rule on whom to trust", () => {
  const text = tradeInstructions();
  assert.match(text, /refuse/u);
  assert.match(text, /ask .*back/u);
  assert.match(text, /give first/u);
  assert.match(text, /gift/u);
  assert.doesNotMatch(text, /(always|never)[^.\n]*trust|trust[^.\n]*(always|never)/iu);
});

test("tradeInstructions say that agreeing to an offer heard in a line is accept, with the terms from my side", () => {
  const text = tradeInstructions();
  assert.match(text, /agree[^.\n]*offer[^.\n]*(heard|line)[^.\n]*"accept"/iu);
  assert.match(text, /"give"[^.\n]*what they ask of you[^.\n]*"get"[^.\n]*what they offer/iu);
  assert.match(text, /"propose"[^.\n]*(only|your own)[^.\n]*counter/iu);
  assert.doesNotMatch(text, /answers a "propose" you heard/u, "the model hears chat lines, never a propose");
});

test("parseGistPartners keeps good entries and drops bad ones", () => {
  const parsed = parseGistPartners([
    { name: "Theo", nudge: 2.5, why: "paid back", has: ["iron_ingot"], needs: ["white_wool"] },
    { name: "Bruno" },
    { feeling: 1 },
    "nobody",
    { name: "Ayla", nudge: "high", has: "bread" },
    { name: "Cleo", nudge: 0 },
  ]);
  assert.deepEqual(parsed, [
    { name: "Theo", nudge: { value: 2.5, why: "paid back" }, has: ["iron_ingot"], needs: ["white_wool"] },
    { name: "Bruno", nudge: null, has: [], needs: [] },
    { name: "Ayla", nudge: null, has: [], needs: [] },
    { name: "Cleo", nudge: { value: 0, why: "the conversation" }, has: [], needs: [] },
  ]);
  assert.deepEqual(parseGistPartners(undefined), []);
  assert.deepEqual(parseGistPartners({ name: "Theo" }), []);
});

test("openingRelationLines tells what a partner said it has that the objective lacks", () => {
  const theo = withSaid(newRelation("Theo", 0, 0), ["iron_ingot"], [], 0);
  const lines = openingRelationLines([{ partner: "Theo", relation: theo }, { partner: "Ayla", relation: null }], ["iron_ingot"], 60_000, testScoring());
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /Theo said 1 min ago they have iron_ingot/u);
  assert.match(lines[0] ?? "", /You lack iron_ingot/u);
  assert.match(lines[1] ?? "", /not dealt with Ayla/u);
});


test("F10 tooFarLine tells a partner out of reach cannot be gone to, with the distance or 'out of sight'", () => {
  assert.equal(tooFarLine("Theo", 200), "Theo is too far away to trade with (200 blocks away): do not offer to go to them; they can come to you.");
  assert.equal(tooFarLine("Theo", null), "Theo is too far away to trade with (out of sight): do not offer to go to them; they can come to you.");
});

test("tradeInstructions forbids claiming a hand-over", () => {
  assert.match(tradeInstructions(), /never say you gave, dropped or handed over items unless your "Open:" line says you gave them/u);
});
