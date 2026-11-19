import assert from "node:assert/strict";
import test from "node:test";
import { isStopLine, parseStopWords, stopLineIsMine, type StopLineFacts } from "./stop-line.ts";

test("parseStopWords: comma separated, trimmed, lower-cased, inner spaces collapsed, empty items dropped", () => {
  assert.deepEqual(parseStopWords(" Stop , stop  it,,"), ["stop", "stop it"]);
  assert.deepEqual(parseStopWords(undefined), []);
  assert.deepEqual(parseStopWords(""), []);
});

test("a stop word is read the way a line is: its punctuation is left out, so it can match", () => {
  assert.deepEqual(parseStopWords("Stop!, arrête-toi, ?!"), ["stop", "arrêtetoi"]);
  assert.equal(isStopLine("Arrête-toi !", parseStopWords("arrête-toi"), []), true);
});

test("isStopLine: the line is a stop line when, without the names and the punctuation, it equals one stop word", () => {
  assert.equal(isStopLine("stop", ["stop"], []), true);
  assert.equal(isStopLine("Brea, STOP!", ["stop"], ["Brea"]), true);
  assert.equal(isStopLine("stop it", ["stop"], []), false);
  assert.equal(isStopLine("stop it", ["stop", "stop it"], []), true);
  assert.equal(isStopLine("arrête", ["arrête"], []), true);
  assert.equal(isStopLine("stop", [], []), false, "no stop word set: no line is a stop line");
  assert.equal(isStopLine("stop mining", ["stop"], []), false);
  assert.equal(isStopLine("Vex stop", ["stop"], ["Vex"]), true, "whose it is, is for the caller to decide");
  assert.equal(isStopLine("Bream stop", ["stop"], ["Brea"]), false, "a name is removed as a whole word only");
  assert.equal(isStopLine("Brea_2, stop", ["stop"], ["Brea_2"]), true, "a name with an underscore is one word");
});

const facts = (overrides: Partial<StopLineFacts>): StopLineFacts => ({ named: [], self: "Brea", channel: "chat", speakerHasOrder: false, talkedToOther: false, heard: true, ...overrides });

test("stopLineIsMine: named self; named another; whisper naming nobody; public with an order; talked to another; not heard", () => {
  assert.equal(stopLineIsMine(facts({ named: ["brea"] })), true, "naming the bot is enough, whatever its case");
  assert.equal(stopLineIsMine(facts({ named: ["Brea"], channel: "whisper" })), true);
  assert.equal(stopLineIsMine(facts({ named: ["Vex"], speakerHasOrder: true })), false, "another character is named, even with an order on this bot");
  assert.equal(stopLineIsMine(facts({ named: ["Brea", "Vex"] })), true, "a line naming her and another is hers too: each named bot stops");
  assert.equal(stopLineIsMine(facts({ channel: "whisper" })), true, "a whisper naming nobody");
  assert.equal(stopLineIsMine(facts({})), false, "public, nobody named, no order on the stack: left to the chat tier");
  assert.equal(stopLineIsMine(facts({ speakerHasOrder: true })), true, "public, nobody named, the speaker has an order");
  assert.equal(stopLineIsMine(facts({ speakerHasOrder: true, talkedToOther: true })), false, "the speaker was talking to another bot lately");
  assert.equal(stopLineIsMine(facts({ channel: "whisper", talkedToOther: true })), true, "a whisper is to her whatever was said before");
  assert.equal(stopLineIsMine(facts({ named: ["brea"], heard: false })), false, "a speaker she does not hear stops nothing");
});
