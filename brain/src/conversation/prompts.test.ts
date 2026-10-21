import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationFacts, OpeningInput } from "../mind.ts";
import { testPersona } from "../testing.ts";
import { conversationBlock, describeGist, describeOpening, gistSystemPrompt, openingSystemPrompt } from "./prompts.ts";

const facts = (overrides: Partial<ConversationFacts> = {}): ConversationFacts => ({
  kind: "chance", others: ["Theo"], opener: "Ayla", topic: "the mine", planned: "short", lines: 2, minutes: 1, iAmOpener: true, sayGoodbye: false, lastGists: [], ...overrides,
});

test("the block tells the opener its planned length", () => {
  assert.match(conversationBlock(facts()), /you meant it to be short \(2-4 lines in all\)/u);
  assert.match(conversationBlock(facts()), /This conversation:/u);
});

test("at the cap the block says goodbye now", () => {
  assert.match(conversationBlock(facts({ sayGoodbye: true })), /say goodbye now/u);
});

test("someone who did not open it has no planned length", () => {
  const block = conversationBlock(facts({ iAmOpener: false, planned: null, topic: "", opener: "Theo" }));
  assert.doesNotMatch(block, /you meant/u);
  assert.match(block, /Theo opened it/u);
});

test("the last talk with each member is shown", () => {
  assert.match(conversationBlock(facts({ lastGists: [{ with: ["Theo"], topic: "iron", gist: "I promised logs", minutesAgo: 12 }] })), /12 min ago about iron: I promised logs/u);
});

test("the opening says who is out of sight and who it never talked with", () => {
  const input: OpeningInput = {
    persona: testPersona(), kind: "social", near: [{ username: "Theo", distance: null, lastTalk: null }, { username: "Bruno", distance: 7, lastTalk: { with: ["Bruno"], topic: "farm", gist: "wheat", minutesAgo: 30 } }],
    activity: "idle", lately: ["a", "b", "c", "d"], lastFailed: null, calling: true,
  };
  const text = describeOpening(input);
  assert.match(text, /Theo, out of sight; never talked/u);
  assert.match(text, /Bruno, 7 blocks away; last talk 30 min ago about farm: wheat/u);
  assert.doesNotMatch(text, /- a$/mu);
});

test("the block names the real opener, not the first other member", () => {
  const block = conversationBlock(facts({ iAmOpener: false, planned: null, topic: "", others: ["Theo", "Bruno"], opener: "Bruno" }));
  assert.match(block, /Bruno opened it/u);
  assert.doesNotMatch(block, /Theo opened it/u);
});

test("a call is said to be shouted only where localized chat makes it so", () => {
  const input: OpeningInput = {
    persona: testPersona(), kind: "social", near: [{ username: "Theo", distance: null, lastTalk: null }], activity: "idle", lately: [], lastFailed: null, calling: true,
  };
  assert.doesNotMatch(describeOpening(input), /shout/u);
  assert.doesNotMatch(openingSystemPrompt(testPersona()), /shout/u);
  assert.match(describeOpening(input, { range: 64 }), /shouted/u);
  assert.match(openingSystemPrompt(testPersona(), { range: 64 }), /shouted/u);
});

test("the opening prompt tells the model to name those it speaks to", () => {
  assert.match(openingSystemPrompt(testPersona()), /name those you speak to/iu);
});

test("the gist prompt asks for partners only when relations are given", () => {
  const input = { persona: testPersona(), others: ["Theo"], topic: "iron", lines: [] };
  assert.doesNotMatch(gistSystemPrompt(testPersona()), /partners/u);
  assert.match(gistSystemPrompt(testPersona(), true), /"partners"/u);
  assert.doesNotMatch(describeGist(input), /You and/u);
  assert.match(describeGist({ ...input, relations: [{ name: "Theo", block: "You and Theo: friend (+2)." }] }), /You and Theo: friend \(\+2\)/u);
});

test("the opening shows the relation lines of those near", () => {
  const input: OpeningInput = {
    persona: testPersona(), kind: "social", near: [{ username: "Theo", distance: 3, lastTalk: null }], activity: "idle", lately: [], lastFailed: null, calling: false,
    relations: ["You and Theo: friend (+2)."],
  };
  assert.match(describeOpening(input), /You and Theo: friend \(\+2\)/u);
  assert.doesNotMatch(describeOpening({ ...input, relations: undefined }), /You and Theo/u);
});

test("a trade intent adds one line to the opening; without it the text is as before", () => {
  const input: OpeningInput = {
    persona: testPersona(), kind: "social", near: [{ username: "Theo", distance: 7, lastTalk: null }], activity: "trading", lately: [], lastFailed: null, calling: false,
  };
  const plain = describeOpening(input);
  const withIntent = describeOpening({ ...input, intent: { kind: "trade", want: ["iron_ingot", "bread"], offer: [{ item: "oak_log", count: 32 }, { item: "stick", count: 4 }] } });
  assert.match(withIntent, /You came to trade: ask for iron_ingot, bread, offer some of 32 oak_log, 4 stick; say what you would give\./u);
  assert.equal(withIntent.replace(/\n\nYou came to trade[^\n]*/u, ""), plain);
  assert.doesNotMatch(plain, /trade/u);
});

test("the block with a trade intent adds one line after the opener line; without it, nothing changes", () => {
  const plain = conversationBlock(facts());
  const intent = { kind: "trade" as const, partner: "Theo", want: ["iron_ingot"], offer: [{ item: "oak_log", count: 32 }] };
  const block = conversationBlock(facts({ intent }));
  assert.equal(block.split("\n").filter((line) => !plain.split("\n").includes(line)).join("\n"), "- You came to trade: ask Theo for iron_ingot now, offer some of 32 oak_log; say what you would give.");
  assert.equal(block.split("\n")[3], "- You came to trade: ask Theo for iron_ingot now, offer some of 32 oak_log; say what you would give.", "right after the opener line");
  assert.equal(conversationBlock(facts({})), plain);
});
