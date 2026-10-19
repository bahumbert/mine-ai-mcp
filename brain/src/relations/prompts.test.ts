import assert from "node:assert/strict";
import test from "node:test";
import { testPersona } from "../testing.ts";
import { describeJudge, judgeSystemPrompt, openingRelationLines, parseGistPartners, parseTrade, relationsBlock, tradeInstructions } from "./prompts.ts";
import { newRelation, withSaid } from "./record.ts";
import { agreeTrade } from "./trade.ts";

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

test("tradeInstructions give the tools and no rule on whom to trust", () => {
  const text = tradeInstructions();
  assert.match(text, /refuse/u);
  assert.match(text, /ask .*back/u);
  assert.match(text, /give first/u);
  assert.match(text, /gift/u);
  assert.doesNotMatch(text, /(always|never)[^.\n]*trust|trust[^.\n]*(always|never)/iu);
});

test("parseGistPartners keeps good entries and drops bad ones", () => {
  const parsed = parseGistPartners([
    { name: "Theo", feeling: 2, word: "friend", why: "paid back", has: ["iron_ingot"], needs: ["white_wool"] },
    { name: "Bruno" },
    { feeling: 1 },
    "nobody",
    { name: "Ayla", feeling: "high", has: "bread" },
  ]);
  assert.deepEqual(parsed, [
    { name: "Theo", judged: { feeling: 2, word: "friend", why: "paid back" }, has: ["iron_ingot"], needs: ["white_wool"] },
    { name: "Bruno", judged: null, has: [], needs: [] },
    { name: "Ayla", judged: null, has: [], needs: [] },
  ]);
  assert.deepEqual(parseGistPartners(undefined), []);
  assert.deepEqual(parseGistPartners({ name: "Theo" }), []);
});

test("openingRelationLines tells what a partner said it has that the objective lacks", () => {
  const theo = withSaid(newRelation("Theo", 0), ["iron_ingot"], [], 0);
  const lines = openingRelationLines([{ partner: "Theo", relation: theo }, { partner: "Ayla", relation: null }], ["iron_ingot"], 60_000);
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /Theo said 1 min ago they have iron_ingot/u);
  assert.match(lines[0] ?? "", /You lack iron_ingot/u);
  assert.match(lines[1] ?? "", /not dealt with Ayla/u);
});

test("the judge prompt asks for feeling, word and why; the request shows the record and the trade", () => {
  assert.match(judgeSystemPrompt(testPersona()), /"feeling"/u);
  const trade = agreeTrade(null, { self: "Ayla", partner: "Theo", give: [{ item: "bread", count: 5 }], get: [{ item: "iron_ingot", count: 5 }], first: "me", now: 0 });
  const text = describeJudge({ persona: testPersona(), partner: "Theo", block: "You and Theo: friend (+2).", trade: { ...trade, state: "broken", brokenBy: "them", note: "they paid 3 of 5 iron_ingot" } });
  assert.match(text, /You and Theo: friend/u);
  assert.match(text, /5 bread/u);
  assert.match(text, /they paid 3 of 5 iron_ingot/u);
});
