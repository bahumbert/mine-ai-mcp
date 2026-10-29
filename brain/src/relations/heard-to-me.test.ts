import assert from "node:assert/strict";
import test from "node:test";
import type { ChatDecision } from "../mind.ts";
import type { PlayerMessage } from "../runtime-client.ts";
import { askFromReply, lineIsToMe, markHeardAt, readAsToMe, type LineFacts } from "./heard-to-me.ts";

const line = (over: Partial<PlayerMessage> = {}): PlayerMessage => ({ username: "Theo", channel: "chat", message: "hello", addressed: false, ...over });
const reading = (over: Partial<ChatDecision> = {}): ChatDecision => ({ say: "", route: "talk", request: "", ...over });
const lineFacts = (over: Partial<LineFacts> = {}): LineFacts => ({ self: "ayla", isMember: false, named: [], ...over });
const readFacts = (justTalkedToAnother = false) => ({ self: "ayla", justTalkedToAnother });

test("a whisper is to me, whoever is in the talk", () => {
  assert.equal(lineIsToMe(line({ channel: "whisper" }), lineFacts()), true);
});

test("a line naming me as a word is to me even from a stranger", () => {
  assert.equal(lineIsToMe(line({ addressed: true }), lineFacts({ named: ["Ayla"] })), true);
});

test("a talk partner naming only me is talking to me", () => {
  assert.equal(lineIsToMe(line(), lineFacts({ isMember: true, named: ["Ayla"] })), true);
});

test("a talk partner naming nobody is talking to me", () => {
  assert.equal(lineIsToMe(line(), lineFacts({ isMember: true })), true);
});

test("a talk partner naming another character beside me is not known to speak to me", () => {
  assert.equal(lineIsToMe(line(), lineFacts({ isMember: true, named: ["Ayla", "Vex"] })), false);
  assert.equal(lineIsToMe(line(), lineFacts({ isMember: true, named: ["Vex"] })), false);
});

test("a stranger's plain line is not known to be to me (the chat tier reads it)", () => {
  assert.equal(lineIsToMe(line(), lineFacts()), false);
});

test("a line that answers one of my requests is read as to me, even routed to ignore", () => {
  const decision = reading({ route: "ignore", myRequest: { n: 1, answer: "agreed" }, to: ["Vex"] });
  assert.equal(readAsToMe(decision, readFacts(true)), true);
});

test("an ignored line is not to me", () => {
  assert.equal(readAsToMe(reading({ route: "ignore", to: ["Ayla"] }), readFacts()), false);
});

test("a line naming nobody is to me unless its speaker just talked to another character", () => {
  assert.equal(readAsToMe(reading(), readFacts()), true);
  assert.equal(readAsToMe(reading(), readFacts(true)), false);
});

test("a line the chat tier reads as to me by name is to me, even just after the speaker talked to another", () => {
  assert.equal(readAsToMe(reading({ route: "talk", to: ["AYLA"] }), readFacts(true)), true);
});

test("a line to everyone alone is not to me", () => {
  assert.equal(readAsToMe(reading({ route: "talk", to: ["everyone"] }), readFacts()), false);
});

test("a line to another character is not to me", () => {
  assert.equal(readAsToMe(reading({ route: "talk", to: ["Vex"] }), readFacts()), false);
});

const decided = (to?: readonly string[]) => ({ decision: reading({ route: "talk", ...(to !== undefined && { to }) }) });

test("the mark is the time the line was read when the chat tier reads it as to me", () => {
  assert.equal(markHeardAt(decided(), { aborted: false, readAt: 42, justTalkedToAnother: false, self: "ayla" }), 42);
  assert.equal(markHeardAt(decided(["Vex"]), { aborted: false, readAt: 42, justTalkedToAnother: false, self: "ayla" }), null);
});

test("a run that is over still marks a line the chat tier did read as to me", () => {
  assert.equal(markHeardAt(decided(), { aborted: true, readAt: 42, justTalkedToAnother: false, self: "ayla" }), 42);
});

test("a tier that could not read the line gives the speaker the benefit of the doubt, unless the run is over", () => {
  assert.equal(markHeardAt(null, { aborted: false, readAt: 42, justTalkedToAnother: false, self: "ayla" }), 42);
  assert.equal(markHeardAt(null, { aborted: true, readAt: 42, justTalkedToAnother: false, self: "ayla" }), null);
});

test("a reply that asks someone opens an ask of what it says, or of 'something' when no what was given", () => {
  assert.deepEqual(askFromReply({ say: "Can you bring bread?", asksOf: ["Theo"], asksWhat: "bread" }), { names: ["Theo"], what: "bread" });
  assert.deepEqual(askFromReply({ say: "Can you help?", asksOf: ["Theo"] }), { names: ["Theo"], what: "something" });
});

test("a reply that asks nobody, or says nothing, opens no ask", () => {
  assert.equal(askFromReply({ say: "Hello" }), null);
  assert.equal(askFromReply({ say: "  ", asksOf: ["Theo"], asksWhat: "bread" }), null);
});
